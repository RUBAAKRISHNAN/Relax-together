import type { RtcSignal, UserId } from '@shared/types';
import type { AppSocket } from './socket';

/**
 * "Stream from my device": the host's browser sends its movie straight to each viewer over
 * WebRTC (a star of peer connections). The server only relays the small signalling messages;
 * the video itself never touches it. Each viewer costs the host roughly the bitrate below in
 * upload bandwidth, so this suits small groups.
 */

const VIDEO_BITRATE = 4_000_000;

function iceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  // Optional TURN relay for networks that block peer-to-peer (see README).
  const turn = import.meta.env.VITE_TURN_URL as string | undefined;
  if (turn) {
    servers.push({
      urls: turn.split(',').map((u) => u.trim()),
      username: import.meta.env.VITE_TURN_USERNAME as string | undefined,
      credential: import.meta.env.VITE_TURN_CREDENTIAL as string | undefined,
    });
  }
  return servers;
}

type SignalEvent = { from: UserId; signal: RtcSignal };

export class StreamHost {
  private peers = new Map<UserId, RTCPeerConnection>();
  private stream: MediaStream | null = null;
  private viewers = new Set<UserId>();

  constructor(
    private socket: AppSocket,
    private onPeersChange: (states: Record<UserId, RTCPeerConnectionState>) => void,
  ) {
    socket.on('rtc:signal', this.onSignal);
  }

  /** The captured movie (video.captureStream()). Changing it reconnects everyone. */
  setStream(stream: MediaStream | null) {
    if (stream === this.stream) return;
    this.stream = stream;
    for (const id of this.viewers) void this.connect(id);
  }

  /** Who should be receiving the stream (everyone online except the host). */
  setViewers(ids: UserId[]) {
    const next = new Set(ids);
    for (const id of this.viewers) if (!next.has(id)) this.close(id);
    for (const id of next) if (!this.viewers.has(id)) void this.connect(id);
    this.viewers = next;
  }

  private send(to: UserId, signal: RtcSignal) {
    this.socket.emit('rtc:signal', { to, signal });
  }

  private report() {
    this.onPeersChange(Object.fromEntries([...this.peers].map(([id, pc]) => [id, pc.connectionState])));
  }

  private close(id: UserId) {
    this.peers.get(id)?.close();
    this.peers.delete(id);
    this.report();
  }

  private async connect(id: UserId) {
    this.close(id);
    const stream = this.stream;
    if (!stream) return;
    const pc = new RTCPeerConnection({ iceServers: iceServers() });
    this.peers.set(id, pc);
    for (const track of stream.getTracks()) pc.addTrack(track, stream);
    pc.onicecandidate = (e) => e.candidate && this.send(id, { type: 'candidate', candidate: e.candidate.toJSON() });
    pc.onconnectionstatechange = () => this.report();
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.send(id, { type: 'offer', sdp: offer.sdp ?? '' });
      // Movies favour a sharp picture; cap the bitrate so a few viewers fit in a home upload.
      for (const sender of pc.getSenders()) {
        if (sender.track?.kind !== 'video') continue;
        const params = sender.getParameters();
        params.encodings = params.encodings?.length ? params.encodings : [{}];
        params.encodings[0].maxBitrate = VIDEO_BITRATE;
        await sender.setParameters(params).catch(() => {});
      }
    } catch {
      this.close(id);
    }
    this.report();
  }

  private onSignal = async ({ from, signal }: SignalEvent) => {
    if (signal.type === 'hello') {
      // A viewer (re)joined and is ready for an offer.
      this.viewers.add(from);
      return this.connect(from);
    }
    const pc = this.peers.get(from);
    if (!pc) return;
    try {
      if (signal.type === 'answer') await pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
      else if (signal.type === 'candidate') await pc.addIceCandidate(signal.candidate);
      else if (signal.type === 'bye') this.close(from);
    } catch {
      /* stale or out-of-order message for an old connection */
    }
  };

  stop() {
    this.socket.off('rtc:signal', this.onSignal);
    for (const id of this.peers.keys()) this.send(id, { type: 'bye' });
    for (const pc of this.peers.values()) pc.close();
    this.peers.clear();
    this.viewers.clear();
  }
}

export class StreamViewer {
  private pc: RTCPeerConnection | null = null;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private hostId: UserId | null = null;

  constructor(
    private socket: AppSocket,
    private onStream: (stream: MediaStream | null) => void,
    private onState: (state: RTCPeerConnectionState | 'waiting') => void,
  ) {
    socket.on('rtc:signal', this.onSignal);
  }

  /** Ask the host for the stream (also used to retry). */
  connect(hostId: UserId) {
    this.hostId = hostId;
    this.onState('waiting');
    this.socket.emit('rtc:signal', { to: hostId, signal: { type: 'hello' } });
  }

  private send(signal: RtcSignal) {
    if (this.hostId) this.socket.emit('rtc:signal', { to: this.hostId, signal });
  }

  private onSignal = async ({ from, signal }: SignalEvent) => {
    if (from !== this.hostId) return;
    try {
      if (signal.type === 'offer') {
        this.pc?.close();
        const pc = new RTCPeerConnection({ iceServers: iceServers() });
        this.pc = pc;
        pc.ontrack = (e) => this.onStream(e.streams[0] ?? new MediaStream([e.track]));
        pc.onicecandidate = (e) => e.candidate && this.send({ type: 'candidate', candidate: e.candidate.toJSON() });
        pc.onconnectionstatechange = () => this.onState(pc.connectionState);
        await pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp });
        for (const c of this.pendingCandidates.splice(0)) await pc.addIceCandidate(c).catch(() => {});
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.send({ type: 'answer', sdp: answer.sdp ?? '' });
      } else if (signal.type === 'candidate') {
        // Candidates can arrive before the offer has been applied.
        if (this.pc?.remoteDescription) await this.pc.addIceCandidate(signal.candidate);
        else this.pendingCandidates.push(signal.candidate);
      } else if (signal.type === 'bye') {
        this.pc?.close();
        this.pc = null;
        this.onStream(null);
        this.onState('waiting');
      }
    } catch {
      this.onState('failed');
    }
  };

  stop() {
    this.socket.off('rtc:signal', this.onSignal);
    this.send({ type: 'bye' });
    this.pc?.close();
    this.pc = null;
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
