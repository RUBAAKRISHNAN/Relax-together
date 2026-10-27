import type { RtcSignal, UserId } from '@shared/types';
import { SERVER_URL } from './env';
import type { AppSocket } from './socket';

/**
 * "Stream from my device": the host's browser sends its movie straight to each viewer over
 * WebRTC (a star of peer connections). The server only relays the small signalling messages;
 * the video itself never touches it. Each viewer costs the host roughly the bitrate below in
 * upload bandwidth, so this suits small groups.
 *
 * Every connection attempt has a session id (`sid`). Answers and ICE candidates carry it back,
 * and anything from an older attempt is ignored, so overlapping attempts (a viewer joining
 * while the host's list updates, retries after a network blip) can never get cross-wired.
 */

const VIDEO_BITRATE = 4_000_000;
/** Viewer retry schedule after a failed/dropped connection (ms). */
const RETRY_DELAYS = [1500, 3000, 6000, 10_000, 15_000];
/** A "disconnected" connection often recovers by itself; give it this long before retrying. */
const DISCONNECT_GRACE_MS = 5000;
/** If no offer arrives this long after asking, ask again. */
const OFFER_TIMEOUT_MS = 10_000;

const FALLBACK_ICE: RTCIceServer[] = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];
let iceCache: { servers: RTCIceServer[]; expires: number } | null = null;

/**
 * STUN plus TURN relay credentials from our server (it issues short-lived ones, so no secret is
 * in the website). TURN carries the stream when networks can't connect directly (mobile data,
 * strict NATs). Falls back to STUN only.
 */
export async function iceServers(): Promise<RTCIceServer[]> {
  if (iceCache && iceCache.expires > Date.now()) return iceCache.servers;
  try {
    const res = await fetch(`${SERVER_URL}/api/ice`, { signal: AbortSignal.timeout(5000) });
    const body = (await res.json()) as { iceServers?: RTCIceServer[] };
    const servers = body.iceServers?.length ? body.iceServers : FALLBACK_ICE;
    iceCache = { servers, expires: Date.now() + 30 * 60 * 1000 };
    return servers;
  } catch {
    return FALLBACK_ICE;
  }
}

const newSid = () => Math.random().toString(36).slice(2, 12);

type SignalEvent = { from: UserId; signal: RtcSignal };

interface Peer {
  pc: RTCPeerConnection;
  sid: string;
}

export class StreamHost {
  private peers = new Map<UserId, Peer>();
  private stream: MediaStream | null = null;
  /** Viewers who asked for the stream ("hello") and are still in the room. */
  private viewers = new Set<UserId>();

  constructor(
    private socket: AppSocket,
    private onPeersChange: (states: Record<UserId, RTCPeerConnectionState>) => void,
  ) {
    socket.on('rtc:signal', this.onSignal);
  }

  /** The captured movie (video.captureStream()). A new stream reconnects everyone who asked. */
  setStream(stream: MediaStream | null) {
    if (stream === this.stream) return;
    this.stream = stream;
    for (const id of this.viewers) void this.connect(id);
  }

  /**
   * Who is still in the room. Connections are only ever started by a viewer's "hello" (exactly
   * one offer per request), so this just drops viewers who left.
   */
  setViewers(ids: UserId[]) {
    const present = new Set(ids);
    for (const id of [...this.viewers]) {
      if (present.has(id)) continue;
      this.viewers.delete(id);
      this.close(id);
    }
  }

  private send(to: UserId, signal: RtcSignal) {
    this.socket.emit('rtc:signal', { to, signal });
  }

  private report() {
    this.onPeersChange(Object.fromEntries([...this.peers].map(([id, p]) => [id, p.pc.connectionState])));
  }

  private close(id: UserId) {
    this.peers.get(id)?.pc.close();
    this.peers.delete(id);
    this.report();
  }

  /** (Re)connects a viewer with a fresh session; any previous attempt for them is dropped. */
  private async connect(id: UserId) {
    this.close(id);
    const stream = this.stream;
    if (!stream) return;
    const sid = newSid();
    const pc = new RTCPeerConnection({ iceServers: await iceServers() });
    if (stream !== this.stream || !this.viewers.has(id)) {
      pc.close();
      return; // superseded while fetching the ICE config
    }
    this.close(id);
    const peer = { pc, sid };
    this.peers.set(id, peer);
    const current = () => this.peers.get(id) === peer;

    for (const track of stream.getTracks()) pc.addTrack(track, stream);
    pc.onicecandidate = (e) => e.candidate && current() && this.send(id, { type: 'candidate', candidate: e.candidate.toJSON(), sid });
    pc.onconnectionstatechange = () => {
      if (!current()) return;
      this.report();
      // The viewer retries on failure (it sends "hello"), so just let this attempt go.
      if (pc.connectionState === 'failed') this.close(id);
    };
    try {
      const offer = await pc.createOffer();
      if (!current()) return;
      await pc.setLocalDescription(offer);
      this.send(id, { type: 'offer', sdp: offer.sdp ?? '', sid });
      // Movies favour a sharp picture; cap the bitrate so a few viewers fit in a home upload.
      for (const sender of pc.getSenders()) {
        if (sender.track?.kind !== 'video') continue;
        const params = sender.getParameters();
        params.encodings = params.encodings?.length ? params.encodings : [{}];
        params.encodings[0].maxBitrate = VIDEO_BITRATE;
        await sender.setParameters(params).catch(() => {});
      }
    } catch {
      if (current()) this.close(id);
    }
    this.report();
  }

  private onSignal = async ({ from, signal }: SignalEvent) => {
    if (signal.type === 'hello') {
      // A viewer is (re)starting: it has no working connection, so give it a fresh one.
      this.viewers.add(from);
      return this.connect(from);
    }
    if (signal.type === 'bye') return this.close(from);
    const peer = this.peers.get(from);
    if (!peer || signal.sid !== peer.sid) return; // a reply to an older attempt
    try {
      if (signal.type === 'answer') {
        if (peer.pc.signalingState === 'have-local-offer') await peer.pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
      } else if (signal.type === 'candidate') {
        await peer.pc.addIceCandidate(signal.candidate);
      }
    } catch {
      /* the attempt failed; the viewer will retry */
    }
  };

  stop() {
    this.socket.off('rtc:signal', this.onSignal);
    for (const id of this.peers.keys()) this.send(id, { type: 'bye' });
    for (const { pc } of this.peers.values()) pc.close();
    this.peers.clear();
    this.viewers.clear();
  }
}

export type ViewerState = RTCPeerConnectionState | 'waiting' | 'retrying';

export class StreamViewer {
  private peer: Peer | null = null;
  /** Candidates that arrived before their offer was applied, keyed by session id. */
  private pendingCandidates: { sid: string; candidate: RTCIceCandidateInit }[] = [];
  private hostId: UserId | null = null;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(
    private socket: AppSocket,
    private onStream: (stream: MediaStream | null) => void,
    private onState: (state: ViewerState) => void,
  ) {
    socket.on('rtc:signal', this.onSignal);
    // After a socket reconnect the host may have dropped us; ask again.
    socket.on('connect', this.onSocketReconnect);
  }

  /** Ask the host for the stream (also used to retry manually). */
  connect(hostId: UserId) {
    this.hostId = hostId;
    this.attempt = 0;
    void iceServers(); // warm the ICE config so the offer can be answered without delay
    this.requestOffer();
  }

  private requestOffer() {
    if (this.stopped || !this.hostId) return;
    this.clearRetry();
    this.onState(this.attempt === 0 ? 'waiting' : 'retrying');
    this.socket.emit('rtc:signal', { to: this.hostId, signal: { type: 'hello' } });
    // If the host never answers (e.g. it hasn't opened the movie yet), keep asking.
    this.retryTimer = setTimeout(() => this.retry(), OFFER_TIMEOUT_MS);
  }

  /** Back off and ask the host for a fresh connection. */
  private retry() {
    if (this.stopped) return;
    this.clearRetry();
    const delay = RETRY_DELAYS[Math.min(this.attempt, RETRY_DELAYS.length - 1)];
    this.attempt++;
    if (this.attempt > RETRY_DELAYS.length + 3) {
      this.onState('failed');
      return;
    }
    this.onState('retrying');
    this.retryTimer = setTimeout(() => this.requestOffer(), delay);
  }

  private clearRetry() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private onSocketReconnect = () => {
    if (this.hostId && this.peer?.pc.connectionState !== 'connected') this.requestOffer();
  };

  private send(signal: RtcSignal) {
    if (this.hostId) this.socket.emit('rtc:signal', { to: this.hostId, signal });
  }

  private onSignal = async ({ from, signal }: SignalEvent) => {
    if (from !== this.hostId || this.stopped) return;
    try {
      if (signal.type === 'offer') {
        this.clearRetry();
        this.peer?.pc.close();
        this.peer = null;
        const pc = new RTCPeerConnection({ iceServers: await iceServers() });
        const peer = { pc, sid: signal.sid };
        this.peer = peer;
        // Keep only early candidates that belong to this offer.
        const early = this.pendingCandidates.filter((p) => p.sid === peer.sid).map((p) => p.candidate);
        this.pendingCandidates = [];
        const current = () => this.peer === peer;
        let disconnectTimer: ReturnType<typeof setTimeout> | null = null;

        pc.ontrack = (e) => current() && this.onStream(e.streams[0] ?? new MediaStream([e.track]));
        pc.onicecandidate = (e) => e.candidate && current() && this.send({ type: 'candidate', candidate: e.candidate.toJSON(), sid: peer.sid });
        pc.onconnectionstatechange = () => {
          if (!current()) return;
          const state = pc.connectionState;
          if (disconnectTimer) clearTimeout(disconnectTimer);
          if (state === 'connected') {
            this.attempt = 0;
            this.onState('connected');
          } else if (state === 'failed') {
            this.retry();
          } else if (state === 'disconnected') {
            // Often a brief network hiccup that heals itself; retry only if it doesn't.
            disconnectTimer = setTimeout(() => current() && pc.connectionState !== 'connected' && this.retry(), DISCONNECT_GRACE_MS);
          } else if (state !== 'closed') {
            this.onState(state);
          }
        };

        await pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp });
        for (const c of early) await pc.addIceCandidate(c).catch(() => {});
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        if (current()) this.send({ type: 'answer', sdp: answer.sdp ?? '', sid: peer.sid });
        // No connection within the timeout (e.g. networks that can't reach each other): try again.
        this.retryTimer = setTimeout(() => current() && pc.connectionState !== 'connected' && this.retry(), 20_000);
      } else if (signal.type === 'candidate') {
        const peer = this.peer;
        if (peer && signal.sid === peer.sid && peer.pc.remoteDescription) {
          await peer.pc.addIceCandidate(signal.candidate);
        } else {
          // Candidates can arrive before their offer has been applied (or even created); keep them.
          this.pendingCandidates.push({ sid: signal.sid, candidate: signal.candidate });
          if (this.pendingCandidates.length > 200) this.pendingCandidates.splice(0, 100);
        }
      } else if (signal.type === 'bye') {
        // The host stopped streaming (changed movie, left). Wait for a new offer.
        this.peer?.pc.close();
        this.peer = null;
        this.onStream(null);
        this.onState('waiting');
      }
    } catch {
      this.retry();
    }
  };

  stop() {
    this.stopped = true;
    this.clearRetry();
    this.socket.off('rtc:signal', this.onSignal);
    this.socket.off('connect', this.onSocketReconnect);
    this.send({ type: 'bye' });
    this.peer?.pc.close();
    this.peer = null;
  }
}

/** video.captureStream() (Chrome/Edge, Safari 17+) or mozCaptureStream() (Firefox). */
export function captureVideo(video: HTMLVideoElement): MediaStream | null {
  const el = video as HTMLVideoElement & { captureStream?: () => MediaStream; mozCaptureStream?: () => MediaStream };
  try {
    return el.captureStream?.() ?? el.mozCaptureStream?.() ?? null;
  } catch {
    return null;
  }
}
