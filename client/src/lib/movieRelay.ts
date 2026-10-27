import { RELAY_PIECE_BYTES } from '@shared/constants';
import type { RelayChunk } from '@shared/types';
import type { AppSocket } from './socket';

/**
 * Server relay for "stream from my device": the fallback when peer-to-peer can't connect, which is
 * common on carrier-grade NAT (most mobile and many fibre networks). The host records its
 * captured movie as WebM in short slices and sends them, in small pieces, over the WebSocket it
 * already has; the server forwards them to relay viewers, who play them with Media Source
 * Extensions. Plain HTTPS/WebSocket traffic, so it works on any network that can load the site.
 */

const VIDEO_BITRATE = 1_800_000;
const AUDIO_BITRATE = 128_000;
/** Short slices keep latency low; each one is split into pieces under the proxy limit. */
const SLICE_MS = 250;
/** A new viewer asks for a fresh recording; restarts are batched so a crowd joining is one restart. */
const RESTART_DEBOUNCE_MS = 400;
/**
 * Viewer jitter buffer: slices arrive in bursts over the network (host → server → viewer can span
 * continents), so playback starts only with this much buffered, and catches up to this far behind
 * the newest data when it falls behind. A few seconds of delay is invisible in a movie; stutter isn't.
 */
const START_BUFFER_S = 2;
const TARGET_DELAY_S = 3;
const MAX_DELAY_S = 7;
/** Below / above this much buffered, play slightly slower / faster (pitch preserved, inaudible). */
const LOW_BUFFER_S = 1.5;
const HIGH_BUFFER_S = 4;

const MIME_CANDIDATES = ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm'];

function pickMime(): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  return MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) ?? null;
}

export class RelayHost {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private viewers = 0;
  private sendChain = Promise.resolve();
  private restartTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private socket: AppSocket) {
    socket.on('relay:demand', this.onDemand);
  }

  /** The captured movie. A new stream restarts the recording if anyone is watching via the relay. */
  setStream(stream: MediaStream | null) {
    if (stream === this.stream) return;
    this.stream = stream;
    if (this.viewers > 0) this.restart();
  }

  private onDemand = ({ viewers, restart }: { viewers: number; restart: boolean }) => {
    this.viewers = viewers;
    if (viewers === 0) this.stopRecording();
    else if (restart || !this.recorder) this.scheduleRestart();
  };

  private scheduleRestart() {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => this.restart(), RESTART_DEBOUNCE_MS);
  }

  private restart() {
    this.stopRecording();
    const mime = pickMime();
    if (!this.stream || !mime || this.viewers === 0) return;
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(this.stream, { mimeType: mime, videoBitsPerSecond: VIDEO_BITRATE, audioBitsPerSecond: AUDIO_BITRATE });
    } catch {
      return;
    }
    this.recorder = recorder;
    let first = true;
    recorder.ondataavailable = (e) => {
      if (!e.data.size || this.recorder !== recorder) return;
      const isInit = first;
      first = false;
      // Blob → bytes is async; chain the sends so pieces always leave in recording order.
      this.sendChain = this.sendChain.then(async () => {
        const bytes = await e.data.arrayBuffer();
        for (let offset = 0; offset < bytes.byteLength; offset += RELAY_PIECE_BYTES) {
          const piece: RelayChunk = { init: isInit && offset === 0, data: bytes.slice(offset, offset + RELAY_PIECE_BYTES) };
          if (piece.init) piece.mime = mime;
          this.socket.emit('relay:chunk', piece);
        }
      });
    };
    recorder.start(SLICE_MS);
  }

  private stopRecording() {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    const recorder = this.recorder;
    this.recorder = null;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  }

  stop() {
    this.socket.off('relay:demand', this.onDemand);
    this.viewers = 0;
    this.stopRecording();
  }
}

export type RelayViewerState = 'waiting' | 'playing' | 'unsupported';

/** Plays the relayed stream in a <video> via Media Source Extensions, staying near the live edge. */
export class RelayViewer {
  private mediaSource: MediaSource | null = null;
  private buffer: SourceBuffer | null = null;
  private queue: ArrayBuffer[] = [];
  private objectUrl: string | null = null;
  private stopped = false;
  private state: RelayViewerState = 'waiting';
  /** Paused on purpose until enough is buffered (at start, or after running dry). */
  private rebuffering = true;
  private controlTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private socket: AppSocket,
    private video: HTMLVideoElement,
    private onState: (state: RelayViewerState) => void,
    private onNeedsTap: () => void,
  ) {}

  start() {
    if (typeof MediaSource === 'undefined') {
      this.setState('unsupported');
      return;
    }
    this.socket.on('relay:chunk', this.onChunk);
    this.socket.on('connect', this.subscribe); // re-subscribe after a reconnect
    // The relay decides when to play (after buffering), not the browser.
    this.video.autoplay = false;
    this.video.addEventListener('waiting', this.onRanDry);
    this.controlTimer = setInterval(() => this.control(), 500);
    this.subscribe();
  }

  /** Buffer ran dry: pause and rebuffer properly instead of stuttering on every slice. */
  private onRanDry = () => {
    if (this.ahead() < 0.5) {
      this.rebuffering = true;
      this.video.pause();
    }
  };

  private ahead(): number {
    const r = this.video.buffered;
    return r.length ? r.end(r.length - 1) - this.video.currentTime : 0;
  }

  /** Keeps the buffer near its target: resume after rebuffering, and nudge speed gently. */
  private control() {
    const v = this.video;
    const r = v.buffered;
    if (!r.length) return;
    const end = r.end(r.length - 1);
    // Fell far behind (e.g. after a long stall): skip ahead rather than lag further.
    if (end - v.currentTime > MAX_DELAY_S || v.currentTime < r.start(0)) v.currentTime = Math.max(r.start(0), end - TARGET_DELAY_S);
    const ahead = this.ahead();
    if (this.rebuffering) {
      if (ahead < START_BUFFER_S) return;
      this.rebuffering = false;
      void v.play().then(
        () => this.setState('playing'),
        () => this.onNeedsTap(),
      );
      return;
    }
    v.playbackRate = ahead < LOW_BUFFER_S ? 0.96 : ahead > HIGH_BUFFER_S ? 1.04 : 1;
    if (!v.paused) this.setState('playing');
  }

  private subscribe = () => this.socket.emit('relay:subscribe');

  private setState(state: RelayViewerState) {
    if (state === this.state) return;
    this.state = state;
    this.onState(state);
  }

  private onChunk = (chunk: RelayChunk) => {
    if (this.stopped) return;
    if (chunk.init) this.reset(chunk.mime ?? 'video/webm;codecs=vp8,opus');
    if (!this.mediaSource) return; // joined mid-recording: wait for the next fresh start
    this.queue.push(chunk.data);
    this.pump();
  };

  /** A fresh recording begins: rebuild the MediaSource so playback starts from its header. */
  private reset(mime: string) {
    if (!MediaSource.isTypeSupported(mime)) {
      this.setState('unsupported');
      return;
    }
    this.teardownMedia();
    const ms = new MediaSource();
    this.mediaSource = ms;
    this.queue = [];
    this.rebuffering = true;
    this.objectUrl = URL.createObjectURL(ms);
    this.video.srcObject = null;
    this.video.src = this.objectUrl;
    ms.addEventListener(
      'sourceopen',
      () => {
        if (this.mediaSource !== ms) return;
        // Default "segments" mode keeps the recording's own continuous timestamps; "sequence"
        // re-times each appended piece and leaves tiny gaps between interleaved audio/video slices.
        const sb = ms.addSourceBuffer(mime);
        sb.addEventListener('updateend', () => this.afterAppend());
        this.buffer = sb;
        this.pump();
      },
      { once: true },
    );
  }

  private pump() {
    const sb = this.buffer;
    if (!sb || sb.updating || !this.queue.length || this.mediaSource?.readyState !== 'open') return;
    try {
      sb.appendBuffer(this.queue.shift()!);
    } catch (err) {
      // Buffer full: drop what's already been watched and try again shortly.
      if ((err as DOMException).name === 'QuotaExceededError') this.trim(true);
    }
  }

  private afterAppend() {
    this.control();
    this.trim(false);
    this.pump();
  }

  /** Keeps memory flat over a two-hour movie by removing what's been watched. */
  private trim(force: boolean) {
    const sb = this.buffer;
    const v = this.video;
    if (!sb || sb.updating || !v.buffered.length) return;
    const start = v.buffered.start(0);
    if (force || v.currentTime - start > 30) {
      try {
        sb.remove(start, Math.max(start, v.currentTime - 5));
      } catch {
        /* nothing to trim yet */
      }
    }
  }

  private teardownMedia() {
    this.buffer = null;
    if (this.mediaSource?.readyState === 'open') {
      try {
        this.mediaSource.endOfStream();
      } catch {
        /* already ended */
      }
    }
    this.mediaSource = null;
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
  }

  stop() {
    this.stopped = true;
    if (this.controlTimer) clearInterval(this.controlTimer);
    this.video.removeEventListener('waiting', this.onRanDry);
    this.video.playbackRate = 1;
    this.video.autoplay = true;
    this.socket.off('relay:chunk', this.onChunk);
    this.socket.off('connect', this.subscribe);
    this.socket.emit('relay:unsubscribe');
    this.teardownMedia();
    this.video.removeAttribute('src');
    this.video.load();
  }
}
