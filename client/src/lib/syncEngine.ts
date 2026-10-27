import { SYNC } from '@shared/constants';
import type { RoomSnapshot, SyncEvent } from '@shared/types';
import type { ServerClock } from './clock';
import type { MediaPlayer } from './mediaPlayer';
import type { AppSocket } from './socket';
import { PlayerState, describePlayerError } from './youtubeApi';

/** The playback state everyone should converge on, in server-clock terms. */
interface Target {
  videoId: string;
  isPlaying: boolean;
  videoTime: number;
  serverTimestamp: number;
  playbackRate: number;
}

export type SyncStatus = 'in-sync' | 'syncing' | 'reconnecting';

export interface EngineState {
  playerReady: boolean;
  videoId: string | null;
  /** Intended state (what the room is doing), not the raw player state. */
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  /** Stuck buffering long enough that we show "Catching up…". */
  catchingUp: boolean;
  /** Autoplay was blocked: show the "Tap to join playback" overlay. */
  needsInteraction: boolean;
  status: SyncStatus;
  /** Seconds ahead (+) or behind (-) the room, for viewers. */
  drift: number | null;
  muted: boolean;
  volume: number;
  error: string | null;
  isLive: boolean;
  /** Live streams only: seconds behind the live edge (0 = watching live). */
  liveBehind: number | null;
}

const INITIAL_STATE: EngineState = {
  playerReady: false,
  videoId: null,
  isPlaying: false,
  currentTime: 0,
  duration: 0,
  catchingUp: false,
  needsInteraction: false,
  status: 'in-sync',
  drift: null,
  muted: false,
  volume: 100,
  error: null,
  isLive: false,
  liveBehind: null,
};

/** How long programmatic player changes are ignored by the echo detector. */
const GUARD_MS = 1200;
const BUFFERING_UI_DELAY_MS = 1500;
const AUTOPLAY_CHECK_MS = 2000;
const HARD_SEEK_COOLDOWN_MS = 2500;
const MAX_SEEK_LEAD = 1.0;
/** Buffering longer than this turns the sync pill yellow. */
const BUFFERING_STATUS_DELAY_MS = 500;
/** After a seek/load, players land a little apart (different buffering), so for a short
 * "settle" window viewers nudge from a tighter threshold than the steady-state 0.3s. */
const SETTLE_MS = 5000;
const SETTLE_NUDGE_THRESHOLD = 0.12;
/**
 * Movie files on this device (own copies) can be held much tighter than YouTube: the <video>
 * element changes speed smoothly at any rate and seeks almost instantly. Small gaps are closed
 * with a ±5% speed nudge (inaudible with pitch kept) rather than a seek, which would hiccup.
 */
const FINE = { HARD_SEEK: 0.6, NUDGE: 0.06, SETTLE_NUDGE: 0.04, CAUGHT_UP: 0.015 };
/** Within this many seconds of the live edge we show the red "LIVE" badge. */
const LIVE_EDGE_TOLERANCE = 10;
/** YouTube's own live latency rarely exceeds this, which caps how far behind "live" can be. */
const MAX_LIVE_LATENCY = 30;
/** seekTo() past the end of a live stream lands on the live edge. */
const LIVE_EDGE_SEEK = Number.MAX_SAFE_INTEGER / 1000;

/**
 * Keeps one YouTube player in lockstep with the room.
 *
 * - Viewers follow `target` (derived from server events) with a 1s drift loop:
 *   >1s → hard seek, 0.3–1s → playback-rate nudge, ≤0.3s → leave it alone
 *   (for a few seconds after a seek/load/command the nudge starts at 0.12s to mop up
 *   the gap left by uneven buffering).
 * - The host is the reference: its controls emit commands and it sends a heartbeat every 3s.
 * - Every programmatic player call opens a short guard window so the resulting
 *   onStateChange events aren't mistaken for user actions (no echo loops).
 */
export class SyncEngine {
  private player: MediaPlayer | null = null;
  private target: Target | null = null;
  private loadedVideoId: string | null = null;
  private isHost = false;
  private connected = false;
  private started = false;

  private guardUntil = 0;
  private lastPlayerState: number = PlayerState.UNSTARTED;
  private bufferingSince: number | null = null;
  private awaitingFirstPlay = false;
  private playAttempts = 0;

  private lastHardSeekAt = 0;
  private pendingSeekCheck = false;
  /** Learned compensation for seek latency: we seek this far ahead of the target. */
  private seekLead = 0;
  private settleUntil = 0;
  /** Smallest gap between wall clock and the frame on screen seen for this live stream (≈ YouTube's latency). */
  private liveLagFloor: number | null = null;
  /** Host: re-broadcast our real position as soon as playback resumes after a seek/play. */
  private reanchorPending = false;

  private nudgeDirection: -1 | 0 | 1 = 0;
  private nudgeRate: number | null = null;
  private nudgeTimer: ReturnType<typeof setTimeout> | null = null;
  private autoplayTimer: ReturnType<typeof setTimeout> | null = null;
  private intervals: ReturnType<typeof setInterval>[] = [];

  private state: EngineState = INITIAL_STATE;
  private listeners = new Set<() => void>();

  /** Called on the host when the video finishes (used to auto-advance the queue). */
  onHostEnded: (() => void) | null = null;

  constructor(
    private socket: AppSocket,
    private clock: ServerClock,
    private selfId: string,
  ) {}

  // ---------------------------------------------------------------- lifecycle

  start() {
    if (this.started) return;
    this.started = true;
    this.socket.on('player:sync', this.handleSync);
    document.addEventListener('visibilitychange', this.onVisible);
    this.intervals = [
      setInterval(this.correctDrift, SYNC.DRIFT_CHECK_MS),
      setInterval(this.sendHeartbeat, SYNC.HEARTBEAT_MS),
      setInterval(this.refreshUi, 250),
    ];
  }

  stop() {
    this.started = false;
    this.socket.off('player:sync', this.handleSync);
    document.removeEventListener('visibilitychange', this.onVisible);
    this.intervals.forEach(clearInterval);
    this.intervals = [];
    this.clearNudge();
    if (this.autoplayTimer) clearTimeout(this.autoplayTimer);
  }

  /**
   * Back on the tab (or the phone was unlocked): timers were throttled meanwhile, so catch up now.
   * Waits a moment for the clock re-measure that also runs on visibility.
   */
  private onVisible = () => {
    if (document.visibilityState !== 'visible') return;
    setTimeout(() => {
      if (this.isHost) this.sendHeartbeat();
      else {
        this.guardUntil = 0;
        this.lastHardSeekAt = 0;
        this.correctDrift();
      }
    }, 600);
  };

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = () => this.state;

  private setState(patch: Partial<EngineState>) {
    let changed = false;
    for (const key of Object.keys(patch) as (keyof EngineState)[]) {
      if (this.state[key] !== patch[key]) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }

  // ---------------------------------------------------------------- wiring

  attachPlayer(player: MediaPlayer) {
    this.player = player;
    this.loadedVideoId = null;
    this.setState({ playerReady: true, volume: player.getVolume(), muted: player.isMuted() });
    if (this.target) this.loadTarget();
  }

  detachPlayer() {
    this.player = null;
    this.loadedVideoId = null;
    this.setState({ playerReady: false });
  }

  setHost(isHost: boolean) {
    if (this.isHost === isHost) return;
    this.isHost = isHost;
    this.clearNudge();
    this.setState({ drift: null });
    this.updateStatus();
  }

  setConnected(connected: boolean) {
    this.connected = connected;
    this.updateStatus();
  }

  /** Initial join / reconnect: jump straight to where the room is now. */
  applySnapshot(snapshot: RoomSnapshot) {
    const p = snapshot.playback;
    this.applyRemote({
      action: 'state',
      videoId: p.videoId,
      isPlaying: p.isPlaying,
      videoTime: p.currentTime,
      serverTimestamp: p.lastUpdatedAt,
      playbackRate: p.playbackRate,
      by: null,
    });
  }

  private handleSync = (ev: SyncEvent) => this.applyRemote(ev);

  private applyRemote(ev: SyncEvent) {
    if (!ev.videoId) {
      this.target = null;
      this.loadedVideoId = null;
      this.player?.stopVideo();
      this.setState({ videoId: null, isPlaying: false, currentTime: 0, duration: 0, error: null, needsInteraction: false });
      return;
    }
    // The host already applied its own commands locally.
    if (this.isHost && ev.by === this.selfId && ev.action !== 'load' && ev.action !== 'state') return;

    this.target = {
      videoId: ev.videoId,
      isPlaying: ev.isPlaying,
      videoTime: ev.videoTime,
      serverTimestamp: ev.serverTimestamp,
      playbackRate: ev.playbackRate || 1,
    };
    this.setState({ videoId: ev.videoId, isPlaying: ev.isPlaying });
    if (!ev.isPlaying) this.setState({ needsInteraction: false });

    if (!this.player) return;
    if (ev.action === 'load' || this.loadedVideoId !== ev.videoId) {
      this.loadTarget();
    } else if (ev.action === 'heartbeat') {
      this.correctDrift();
    } else {
      this.applyTarget(ev.action === 'seek');
    }
  }

  // ---------------------------------------------------------------- math

  /** Where the video should be right now: videoTime + elapsed server time while playing. */
  private expectedTime(): number {
    const t = this.target!;
    let expected = t.videoTime;
    if (t.isPlaying) expected += ((this.clock.now() - t.serverTimestamp) / 1000) * t.playbackRate;
    const duration = this.player?.getDuration() ?? 0;
    if (duration > 0) expected = Math.min(expected, duration);
    return Math.max(0, expected);
  }

  private playerTime(): number {
    return this.player?.getCurrentTime() ?? 0;
  }

  private playerState(): number {
    return this.player?.getPlayerState() ?? PlayerState.UNSTARTED;
  }

  // ---------------------------------------------------------------- guarded player calls

  private guard(ms = GUARD_MS) {
    this.guardUntil = performance.now() + ms;
  }

  private hardSeek(time: number) {
    if (!this.player) return;
    const lead = this.target?.isPlaying && !this.isHost ? this.seekLead : 0;
    this.guard();
    this.clearNudge();
    this.player.seekTo(time + lead, true);
    this.lastHardSeekAt = performance.now();
    this.settleUntil = this.lastHardSeekAt + SETTLE_MS;
    this.pendingSeekCheck = !!this.target?.isPlaying && !this.isHost;
  }

  private playLocal() {
    const s = this.playerState();
    if (!this.player || s === PlayerState.PLAYING || s === PlayerState.BUFFERING) return;
    this.guard();
    this.player.playVideo();
    this.scheduleAutoplayCheck();
  }

  private pauseLocal() {
    const s = this.playerState();
    if (!this.player || (s !== PlayerState.PLAYING && s !== PlayerState.BUFFERING)) return;
    this.guard();
    this.player.pauseVideo();
  }

  /** If play() didn't take effect, the browser most likely blocked autoplay. */
  private scheduleAutoplayCheck() {
    if (this.autoplayTimer) clearTimeout(this.autoplayTimer);
    this.autoplayTimer = setTimeout(() => {
      const s = this.playerState();
      if (this.target?.isPlaying && s !== PlayerState.PLAYING && s !== PlayerState.BUFFERING) {
        this.setState({ needsInteraction: true });
        this.updateStatus();
      }
    }, AUTOPLAY_CHECK_MS);
  }

  private loadTarget() {
    const t = this.target;
    if (!t || !this.player) return;
    const start = this.expectedTime();
    this.guard(2000);
    this.clearNudge();
    this.loadedVideoId = t.videoId;
    this.awaitingFirstPlay = true;
    this.playAttempts = 0;
    this.bufferingSince = null;
    this.liveLagFloor = null;
    // With no explicit position, omit startSeconds: on a live stream "0" means the start of its
    // DVR window (hours ago), while omitting it opens at the live edge. For normal videos the two
    // are the same, and the host's first-play anchor corrects any small difference.
    const options = t.videoTime > 0 ? { videoId: t.videoId, startSeconds: start } : { videoId: t.videoId };
    if (t.isPlaying) {
      this.player.loadVideoById(options);
      this.scheduleAutoplayCheck();
    } else {
      this.player.cueVideoById(options);
    }
    this.setState({ currentTime: start, duration: 0, error: null, catchingUp: false, isLive: false, liveBehind: null });
    this.updateStatus();
  }

  /** Bring the player to the target immediately (used for explicit play/pause/seek events). */
  private applyTarget(forceSeek: boolean) {
    const t = this.target;
    if (!this.player || !t || this.loadedVideoId !== t.videoId) return;
    const expected = this.expectedTime();
    const drift = Math.abs(this.playerTime() - expected);
    // Paused frames should match exactly (a paused seek is cheap); while playing, small gaps
    // are left to the drift loop so we don't stutter.
    const threshold = !t.isPlaying ? 0.05 : forceSeek ? 0.15 : SYNC.NUDGE_THRESHOLD;
    if (drift > threshold) this.hardSeek(expected);
    if (t.isPlaying && !this.isHost) this.settleUntil = performance.now() + SETTLE_MS;
    if (t.isPlaying) this.playLocal();
    else this.pauseLocal();
  }

  // ---------------------------------------------------------------- drift correction (viewers)

  private correctDrift = () => {
    const p = this.player;
    const t = this.target;
    if (!p || !t || this.isHost || this.loadedVideoId !== t.videoId) return;
    if (performance.now() < this.guardUntil) return; // let programmatic changes settle first

    const state = this.playerState();

    if (!t.isPlaying) {
      if (state === PlayerState.PLAYING || state === PlayerState.BUFFERING) this.pauseLocal();
      // A cued video already sits at its start position, and seekTo() on a cued video would start playback.
      const drift = state === PlayerState.CUED ? 0 : this.playerTime() - t.videoTime;
      if (Math.abs(drift) > 0.25) this.hardSeek(t.videoTime);
      this.setState({ drift });
      this.updateStatus();
      return;
    }

    if (state === PlayerState.BUFFERING) return;

    const expected = this.expectedTime();
    if (state !== PlayerState.PLAYING) {
      const duration = p.getDuration();
      if (state === PlayerState.ENDED && duration > 0 && expected >= duration - 0.5) return; // room is at the end too
      if (this.state.needsInteraction) return;
      // Something stopped us (or autoplay was blocked). Retry, then ask the user to tap.
      if (++this.playAttempts > 2) {
        this.setState({ needsInteraction: true });
        this.updateStatus();
        return;
      }
      this.applyTarget(true);
      return;
    }

    const drift = this.playerTime() - expected;
    const abs = Math.abs(drift);
    const settling = performance.now() < this.settleUntil;
    const fine = !!p.hasInstantSeek?.();
    const hardSeekAt = fine ? FINE.HARD_SEEK : SYNC.HARD_SEEK_THRESHOLD;
    const nudgeAt = fine ? (settling ? FINE.SETTLE_NUDGE : FINE.NUDGE) : settling ? SETTLE_NUDGE_THRESHOLD : SYNC.NUDGE_THRESHOLD;
    const caughtUp = fine ? FINE.CAUGHT_UP : SYNC.CAUGHT_UP_THRESHOLD;

    // Learn how long seeks take on this connection so the next hard seek lands on time.
    // Only from ordinary seeks: a long stall (e.g. network outage) says nothing about seek latency.
    if (this.pendingSeekCheck && performance.now() - this.lastHardSeekAt > 1200) {
      this.pendingSeekCheck = false;
      if (abs < hardSeekAt) {
        this.seekLead = Math.min(MAX_SEEK_LEAD, Math.max(0, this.seekLead - drift * 0.6));
      }
    }

    if (abs > hardSeekAt) {
      // Own copies seek almost instantly, so they don't need the long cooldown.
      const cooldown = fine ? 1200 : HARD_SEEK_COOLDOWN_MS;
      if (performance.now() - this.lastHardSeekAt > cooldown) this.hardSeek(expected);
    } else if (abs > nudgeAt) {
      this.nudge(drift);
    } else if (this.nudgeDirection !== 0 && (abs < caughtUp || Math.sign(-drift) !== this.nudgeDirection)) {
      this.clearNudge();
    }

    this.setState({ drift });
    this.updateStatus();
  };

  /** Speed up (behind) or slow down (ahead) briefly instead of a jarring seek. */
  private nudge(drift: number) {
    const p = this.player;
    if (!p) return;
    const direction: 1 | -1 = drift > 0 ? -1 : 1;
    const rate = this.pickNudgeRate(direction, Math.abs(drift));
    if (this.nudgeDirection === direction && rate === this.nudgeRate) {
      // The YouTube player silently drops a rate set while a video is starting; re-apply it.
      if (rate && Math.abs(p.getPlaybackRate() - rate) > 0.001) p.setPlaybackRate(rate);
      return;
    }

    if (!rate) {
      // No usable speed on this player: a seek is the only way to close the gap.
      if (performance.now() - this.lastHardSeekAt > HARD_SEEK_COOLDOWN_MS) this.hardSeek(this.expectedTime());
      return;
    }
    p.setPlaybackRate(rate);
    this.nudgeDirection = direction;
    this.nudgeRate = rate;

    // Stop exactly when the gap should be closed; the drift loop also stops it on overshoot.
    const ms = Math.min((Math.abs(drift) / Math.abs(rate - 1)) * 1000, 15_000);
    if (this.nudgeTimer) clearTimeout(this.nudgeTimer);
    this.nudgeTimer = setTimeout(() => this.clearNudge(), ms);
  }

  /**
   * Prefer 1.05 / 0.95 (1.08 / 0.92 for bigger gaps where the player offers it, so a half-second
   * gap closes in ~6 s); fall back to the closest speed the player supports (often 1.25 / 0.75).
   */
  private pickNudgeRate(direction: 1 | -1, gap: number): number | null {
    const rates = this.player?.getAvailablePlaybackRates() ?? [];
    const has = (r: number) => rates.some((x) => Math.abs(x - r) < 0.001);
    if (gap > 0.25 && has(1 + direction * 0.08)) return 1 + direction * 0.08;
    const preferred = 1 + direction * 0.05;
    if (has(preferred)) return preferred;
    const candidates = rates
      .filter((r) => (direction > 0 ? r > 1 && r <= 1.5 : r < 1 && r >= 0.5))
      .sort((a, b) => Math.abs(a - 1) - Math.abs(b - 1));
    return candidates[0] ?? null;
  }

  private clearNudge() {
    if (this.nudgeTimer) clearTimeout(this.nudgeTimer);
    this.nudgeTimer = null;
    if (this.nudgeDirection !== 0) {
      this.nudgeDirection = 0;
      this.nudgeRate = null;
      this.player?.setPlaybackRate(this.target?.playbackRate ?? 1);
    }
  }

  // ---------------------------------------------------------------- host side

  private canControl(): boolean {
    return this.isHost && !!this.player && !!this.target && this.loadedVideoId === this.target.videoId;
  }

  private emitCommand(action: 'play' | 'pause' | 'seek', videoTime: number) {
    this.socket.emit('player:command', { action, videoTime, sentAt: this.clock.now() });
  }

  private setHostTarget(isPlaying: boolean, videoTime: number) {
    this.target = { ...this.target!, isPlaying, videoTime, serverTimestamp: this.clock.now() };
    this.setState({ isPlaying, currentTime: videoTime });
  }

  play() {
    if (!this.canControl()) return;
    let time = this.playerTime();
    if (this.playerState() === PlayerState.ENDED) {
      time = 0;
      this.player!.seekTo(0, true);
    }
    this.guard();
    this.player!.playVideo();
    this.reanchorPending = true;
    this.setHostTarget(true, time);
    this.setState({ needsInteraction: false });
    this.emitCommand('play', time);
  }

  pause() {
    if (!this.canControl()) return;
    const time = this.playerTime();
    this.guard();
    this.player!.pauseVideo();
    this.setHostTarget(false, time);
    this.emitCommand('pause', time);
  }

  togglePlay() {
    if (this.target?.isPlaying) this.pause();
    else this.play();
  }

  seek(time: number) {
    if (!this.canControl()) return;
    const duration = this.player!.getDuration();
    const clamped = Math.max(0, duration > 0 ? Math.min(time, duration - 0.5) : time);
    this.guard();
    this.player!.seekTo(clamped, true);
    this.reanchorPending = this.target!.isPlaying;
    this.setHostTarget(this.target!.isPlaying, clamped);
    this.emitCommand('seek', clamped);
  }

  seekBy(delta: number) {
    // Right after a seek the player still reports the old position, so rapid presses
    // (→ → →) build on the intended position instead.
    const inFlight = performance.now() < this.guardUntil && this.target;
    this.seek((inFlight ? this.expectedTime() : this.playerTime()) + delta);
  }

  /** Host: jump to the live edge. The real position is broadcast once the player lands there. */
  goLive() {
    if (!this.canControl() || !this.state.isLive) return;
    this.guard(2000);
    this.player!.seekTo(LIVE_EDGE_SEEK, true);
    this.player!.playVideo();
    this.reanchorPending = true;
    this.target = { ...this.target!, isPlaying: true };
    this.setState({ isPlaying: true, liveBehind: 0 });
  }

  /** Every 3s the host re-states its position so late joiners and drifting viewers stay correct. */
  private sendHeartbeat = () => {
    const t = this.target;
    if (!this.canControl() || !t || !this.socket.connected || this.state.needsInteraction) return;
    // Never broadcast a position we're not actually at (e.g. still buffering after a load).
    if (t.isPlaying && this.playerState() !== PlayerState.PLAYING) return;
    const videoTime = this.playerTime();
    const sentAt = this.clock.now();
    this.target = { ...t, videoTime, serverTimestamp: sentAt };
    this.socket.emit('player:heartbeat', { videoTime, isPlaying: t.isPlaying, sentAt });
  };

  // ---------------------------------------------------------------- local-only controls

  setVolume(volume: number) {
    if (!this.player) return;
    this.player.setVolume(volume);
    if (volume > 0 && this.player.isMuted()) this.player.unMute();
    this.setState({ volume, muted: volume === 0 });
  }

  toggleMute() {
    if (!this.player) return;
    if (this.player.isMuted() || this.state.muted) {
      this.player.unMute();
      if (this.player.getVolume() === 0) this.player.setVolume(60);
      this.setState({ muted: false, volume: this.player.getVolume() || 60 });
    } else {
      this.player.mute();
      this.setState({ muted: true });
    }
  }

  /** Called from the "Tap to join playback" overlay: a real user gesture, so play() is allowed. */
  unlock() {
    if (!this.player) return;
    this.player.unMute();
    this.playAttempts = 0;
    this.setState({ needsInteraction: false, muted: false });
    if (this.target) {
      const expected = this.expectedTime();
      this.guard();
      this.player.seekTo(expected, true);
      if (this.target.isPlaying) this.player.playVideo();
    }
    this.updateStatus();
  }

  // ---------------------------------------------------------------- player events

  onPlayerStateChange(state: number) {
    const previous = this.lastPlayerState;
    this.lastPlayerState = state;
    const now = performance.now();
    const guarded = now < this.guardUntil;

    if (state === PlayerState.BUFFERING) {
      this.bufferingSince ??= now;
    } else {
      const wasCatchingUp = this.state.catchingUp;
      this.bufferingSince = null;
      this.setState({ catchingUp: false });
      // Recovered from a long stall: resync right away rather than waiting for the next tick.
      if (wasCatchingUp && state === PlayerState.PLAYING && !this.isHost) {
        this.guardUntil = 0;
        queueMicrotask(this.correctDrift);
      }
    }

    if (state === PlayerState.PLAYING) {
      this.playAttempts = 0;
      this.setState({ needsInteraction: false, duration: this.player?.getDuration() ?? 0 });
      if (this.isHost && !this.awaitingFirstPlay && (this.reanchorPending || previous === PlayerState.BUFFERING)) {
        // Our player stalled (seek or network); the room kept going without us, so tell
        // everyone where we really are instead of waiting for the next 3s heartbeat.
        this.reanchorPending = false;
        this.sendHeartbeat();
      }
      if (this.awaitingFirstPlay) {
        this.awaitingFirstPlay = false;
        if (!this.isHost) this.settleUntil = now + SETTLE_MS;
        // After a load the host anchors everyone to where it actually started; viewers correct.
        if (this.isHost && this.target?.isPlaying) {
          const time = this.playerTime();
          this.setHostTarget(true, time);
          this.emitCommand('play', time);
        }
      }
    }

    if (state === PlayerState.ENDED && this.isHost && this.target?.isPlaying) {
      const time = this.player?.getDuration() ?? this.playerTime();
      this.setHostTarget(false, time);
      this.emitCommand('pause', time);
      this.onHostEnded?.();
    }

    // Echo detection: state changes we didn't cause (e.g. a hardware media key).
    if (!guarded && this.target && this.loadedVideoId === this.target.videoId) {
      if (this.isHost) {
        if (previous === PlayerState.PLAYING && state === PlayerState.PAUSED && this.target.isPlaying) {
          const time = this.playerTime();
          this.setHostTarget(false, time);
          this.emitCommand('pause', time);
        } else if (previous === PlayerState.PAUSED && state === PlayerState.PLAYING && !this.target.isPlaying) {
          const time = this.playerTime();
          this.setHostTarget(true, time);
          this.emitCommand('play', time);
        }
      } else if (state === PlayerState.PAUSED && this.target.isPlaying && previous === PlayerState.PLAYING) {
        this.playLocal(); // viewers can't pause the room
      } else if (state === PlayerState.PLAYING && !this.target.isPlaying) {
        this.pauseLocal();
      }
    }

    this.updateStatus();
  }

  onPlayerError(code: number) {
    this.setState({ error: describePlayerError(code) });
  }

  /** Re-load the current target, e.g. once a movie file becomes available on this device. */
  reload() {
    if (this.target && this.player) this.loadTarget();
  }

  /** Where the room is right now (server clock), regardless of this device's player. */
  positionNow(): number {
    return this.target ? this.expectedTime() : 0;
  }

  /** Live, unthrottled readings for debugging and the e2e sync check. */
  debug() {
    return {
      wallTime: Date.now(),
      playerTime: this.playerTime(),
      duration: this.player?.getDuration() ?? 0,
      isLive: this.state.isLive,
      playerState: this.playerState(),
      rate: this.player?.getPlaybackRate() ?? 1,
      expected: this.target ? this.expectedTime() : null,
      isHost: this.isHost,
      clockOffset: this.clock.offset,
      seekLead: this.seekLead,
    };
  }

  // ---------------------------------------------------------------- UI

  private refreshUi = () => {
    const p = this.player;
    if (!p || !this.loadedVideoId) return;
    const catchingUp = this.bufferingSince !== null && performance.now() - this.bufferingSince > BUFFERING_UI_DELAY_MS;
    const isLive = !!(p.getVideoData?.() as { isLive?: boolean } | undefined)?.isLive;
    this.setState({
      currentTime: p.getCurrentTime() ?? 0,
      duration: p.getDuration() ?? 0,
      catchingUp,
      isLive,
      liveBehind: isLive ? this.measureLiveBehind(p) : null,
    });
    this.updateStatus();
  };

  /**
   * getDuration() isn't the live edge on live streams, but getMediaReferenceTime() is the wall-clock
   * time of the frame on screen. Its gap to "now" minus the smallest gap seen (YouTube's own
   * latency, capped) is how far behind live this player is.
   */
  private measureLiveBehind(p: MediaPlayer): number | null {
    const ref = p.getMediaReferenceTime?.();
    if (!ref || this.playerState() !== PlayerState.PLAYING) return this.state.liveBehind;
    const lag = Date.now() / 1000 - ref;
    if (!Number.isFinite(lag) || lag < 0) return this.state.liveBehind;
    this.liveLagFloor = Math.min(this.liveLagFloor ?? lag, lag);
    const behind = Math.max(0, lag - Math.min(this.liveLagFloor, MAX_LIVE_LATENCY));
    return behind < LIVE_EDGE_TOLERANCE ? 0 : Math.round(behind);
  }

  private updateStatus() {
    let status: SyncStatus = 'in-sync';
    if (!this.connected) status = 'reconnecting';
    else if (this.target) {
      const drifting = !this.isHost && this.state.drift !== null && Math.abs(this.state.drift) > SYNC.NUDGE_THRESHOLD;
      const loading = this.awaitingFirstPlay && this.target.isPlaying;
      const buffering =
        !this.isHost && this.bufferingSince !== null && performance.now() - this.bufferingSince > BUFFERING_STATUS_DELAY_MS;
      if (this.state.catchingUp || this.state.needsInteraction || drifting || loading || buffering) status = 'syncing';
    }
    this.setState({ status });
  }
}
