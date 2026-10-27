import { type AudioTrackInfo, makeLabel } from './audioTracks';
import type { MediaPlayer } from './mediaPlayer';
import { PlayerState, VIDEO_FILE_ERROR } from './youtubeApi';

export interface VideoSource {
  src: string;
  /** An HLS playlist (.m3u8): played natively on Safari, through hls.js elsewhere. */
  hls: boolean;
}

interface VideoEvents {
  onStateChange: (state: number) => void;
  onError: (code: number) => void;
  /** The file plays but its picture can't be decoded (typically HEVC/x265 on a browser without support). */
  onNoPicture: () => void;
  /** Audio languages the player itself can switch (HLS streams, or Safari's native audioTracks). */
  onAudioTracks?: (tracks: AudioTrackInfo[], current: string | null) => void;
}

type HlsInstance = {
  loadSource(src: string): void;
  attachMedia(el: HTMLMediaElement): void;
  destroy(): void;
  on(event: string, cb: () => void): void;
  audioTracks: { name?: string; lang?: string }[];
  audioTrack: number;
};

/** Safari's HTMLMediaElement.audioTracks (missing from TypeScript's DOM typings). */
type NativeAudioTracks = ArrayLike<{ id: string; label: string; language: string; enabled: boolean }> & EventTarget;

/**
 * Drives a <video> element through the same interface as the YouTube player, so movie rooms reuse
 * the sync engine unchanged. `resolve` maps the room's movie id to something playable on this
 * device (a local file, a link); null means "not available here yet" (e.g. this person hasn't
 * opened their copy), and `retry()` tries again once it is.
 */
export class VideoElementPlayer implements MediaPlayer {
  private waiting = false;
  private pending: { videoId: string; startSeconds?: number; autoplay: boolean } | null = null;
  private hls: HlsInstance | null = null;
  private volume = 100;
  private readonly cleanup: (() => void)[] = [];

  constructor(
    private video: HTMLVideoElement,
    private resolve: (videoId: string) => VideoSource | null,
    private events: VideoEvents,
  ) {
    video.preload = 'auto';
    video.playsInline = true;
    const on = (type: string, fn: () => void) => {
      video.addEventListener(type, fn);
      this.cleanup.push(() => video.removeEventListener(type, fn));
    };
    on('playing', () => {
      this.waiting = false;
      events.onStateChange(PlayerState.PLAYING);
    });
    on('pause', () => !video.ended && events.onStateChange(PlayerState.PAUSED));
    on('waiting', () => {
      this.waiting = true;
      events.onStateChange(PlayerState.BUFFERING);
    });
    on('canplay', () => {
      if (!this.waiting) return;
      this.waiting = false;
      if (!video.paused) events.onStateChange(PlayerState.PLAYING);
    });
    on('ended', () => events.onStateChange(PlayerState.ENDED));
    on('loadedmetadata', () => {
      if (video.duration > 0 && video.videoWidth === 0) events.onNoPicture();
      this.reportAudioTracks();
    });
    const native = this.nativeAudioTracks();
    if (native) {
      const report = () => this.reportAudioTracks();
      native.addEventListener('addtrack', report);
      native.addEventListener('change', report);
      this.cleanup.push(() => {
        native.removeEventListener('addtrack', report);
        native.removeEventListener('change', report);
      });
    }
    on('error', () => video.getAttribute('src') && events.onError(VIDEO_FILE_ERROR));
  }

  private async attach(source: VideoSource, startSeconds: number, autoplay: boolean) {
    this.hls?.destroy();
    this.hls = null;
    const v = this.video;
    if (source.hls && !v.canPlayType('application/vnd.apple.mpegurl')) {
      const { default: Hls } = await import('hls.js');
      if (!Hls.isSupported()) return this.events.onError(VIDEO_FILE_ERROR);
      const hls = new Hls({ startPosition: startSeconds }) as unknown as HlsInstance;
      this.hls = hls;
      hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => this.reportAudioTracks());
      hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, () => this.reportAudioTracks());
      hls.loadSource(source.src);
      hls.attachMedia(v);
    } else {
      v.src = source.src;
    }
    v.currentTime = startSeconds;
    v.playbackRate = 1;
    this.events.onStateChange(PlayerState.UNSTARTED);
    if (autoplay) void v.play().catch(() => {});
  }

  private load(options: { videoId: string; startSeconds?: number }, autoplay: boolean) {
    const source = this.resolve(options.videoId);
    if (!source) {
      // Not playable on this device yet; remember it and show nothing.
      this.pending = { ...options, autoplay };
      this.hls?.destroy();
      this.hls = null;
      this.video.removeAttribute('src');
      this.video.load();
      this.events.onStateChange(PlayerState.UNSTARTED);
      return;
    }
    this.pending = null;
    void this.attach(source, options.startSeconds ?? 0, autoplay);
  }

  private nativeAudioTracks(): NativeAudioTracks | null {
    return (this.video as unknown as { audioTracks?: NativeAudioTracks }).audioTracks ?? null;
  }

  /** Audio tracks this player can switch itself: hls.js tracks, or the browser's native list. */
  getAudioTracks(): { tracks: AudioTrackInfo[]; current: string | null } {
    if (this.hls?.audioTracks?.length) {
      return {
        tracks: this.hls.audioTracks.map((t, i) => ({ id: String(i), label: makeLabel(i, t.name, t.lang) })),
        current: String(this.hls.audioTrack),
      };
    }
    const native = this.nativeAudioTracks();
    if (native && native.length) {
      const list = Array.from(native);
      return {
        tracks: list.map((t, i) => ({ id: t.id || String(i), label: makeLabel(i, t.label, t.language) })),
        current: list.find((t) => t.enabled)?.id ?? null,
      };
    }
    return { tracks: [], current: null };
  }

  setAudioTrack(id: string) {
    if (this.hls?.audioTracks?.length) {
      this.hls.audioTrack = Number(id);
      return;
    }
    const native = this.nativeAudioTracks();
    if (native) Array.from(native).forEach((t, i) => (t.enabled = (t.id || String(i)) === id));
    this.reportAudioTracks();
  }

  private reportAudioTracks() {
    const { tracks, current } = this.getAudioTracks();
    this.events.onAudioTracks?.(tracks, current);
  }

  /** True when the last load had nothing to play on this device. */
  get isWaitingForSource() {
    return this.pending !== null;
  }

  loadVideoById(options: { videoId: string; startSeconds?: number }) {
    this.load(options, true);
  }

  cueVideoById(options: { videoId: string; startSeconds?: number }) {
    this.load(options, false);
  }

  playVideo() {
    if (this.video.getAttribute('src') || this.hls) void this.video.play().catch(() => {});
  }

  pauseVideo() {
    this.video.pause();
  }

  stopVideo() {
    this.video.pause();
  }

  seekTo(seconds: number) {
    const d = this.video.duration;
    this.video.currentTime = Number.isFinite(d) && d > 0 ? Math.min(seconds, d) : seconds;
  }

  getCurrentTime() {
    return this.video.currentTime;
  }

  getDuration() {
    return Number.isFinite(this.video.duration) ? this.video.duration : 0;
  }

  getPlayerState() {
    const v = this.video;
    if (!v.getAttribute('src') && !this.hls) return PlayerState.UNSTARTED;
    if (v.ended) return PlayerState.ENDED;
    if (v.paused) return PlayerState.PAUSED;
    return this.waiting || v.readyState < HTMLMediaElement.HAVE_FUTURE_DATA ? PlayerState.BUFFERING : PlayerState.PLAYING;
  }

  /** Local files (blob: URLs) seek instantly and frame-accurately. */
  hasInstantSeek() {
    return (this.video.getAttribute('src') ?? '').startsWith('blob:');
  }

  getPlaybackRate() {
    return this.video.playbackRate;
  }

  setPlaybackRate(rate: number) {
    this.video.playbackRate = rate;
  }

  /** Any speed works on <video>; ±5–8% with pitch preserved is hard to notice in a movie. */
  getAvailablePlaybackRates() {
    return [0.92, 0.95, 1, 1.05, 1.08];
  }

  getVolume() {
    return this.volume;
  }

  setVolume(volume: number) {
    this.volume = volume;
    this.video.volume = volume / 100;
  }

  mute() {
    this.video.muted = true;
  }

  unMute() {
    this.video.muted = false;
  }

  isMuted() {
    return this.video.muted;
  }

  destroy() {
    this.cleanup.forEach((fn) => fn());
    this.hls?.destroy();
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
  }
}
