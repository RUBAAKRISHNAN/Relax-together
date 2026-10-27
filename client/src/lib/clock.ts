import { SYNC } from '@shared/constants';
import type { AppSocket } from './socket';

interface Sample {
  /** serverTime - performance.now() at the moment the server stamped its reply. */
  offset: number;
  rtt: number;
  /** performance.now() when the sample was taken. */
  at: number;
  /** Date.now() - performance.now() then; a change means the device slept or its clock jumped. */
  wallGap: number;
}

/** Samples older than this are dropped (the two clocks drift apart very slowly). */
const SAMPLE_MAX_AGE_MS = 5 * 60_000;
/** A jump this large between Date.now() and performance.now() invalidates earlier samples. */
const WALL_JUMP_MS = 250;
/** Extra syncs shortly after joining, so a slow first measurement is replaced quickly. */
const EARLY_RESYNCS_MS = [4_000, 12_000];

const wallGap = () => Date.now() - performance.now();

/**
 * NTP-style clock sync. Each sample measures round-trip time; assuming the server stamped
 * its reply halfway through, offset = serverTime - (sendTime + rtt / 2).
 *
 * The sample with the lowest RTT has the least room for asymmetric delay, so that's the one we
 * keep. Samples are pooled across syncs (not just the latest round): on a busy connection a whole
 * round can be slow, and trusting it would shift everyone's position by hundreds of ms at random.
 *
 * Time is kept on performance.now(), which never jumps, so an OS clock correction between syncs
 * can't throw playback off. If the device sleeps, the pool is cleared and re-measured.
 */
export class ServerClock {
  rtt = 0;
  synced = false;
  private perfOffset = 0;
  private samples: Sample[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private early: ReturnType<typeof setTimeout>[] = [];
  private running: Promise<void> | null = null;

  constructor(private socket: AppSocket) {}

  /** Current time on the server's clock (ms). */
  now(): number {
    return performance.now() + this.perfOffset;
  }

  /** server time - Date.now(), for debugging. */
  get offset(): number {
    return this.now() - Date.now();
  }

  private ping(): Promise<Sample | null> {
    return new Promise((resolve) => {
      const start = performance.now();
      const gap = wallGap();
      const timeout = setTimeout(() => resolve(null), 3000);
      this.socket.emit('time:ping', (serverTime) => {
        clearTimeout(timeout);
        const end = performance.now();
        const rtt = end - start;
        resolve({ offset: serverTime - (start + rtt / 2), rtt, at: end, wallGap: gap });
      });
    });
  }

  sync(): Promise<void> {
    this.running ??= (async () => {
      // Pings go out 40 ms apart without waiting for each reply, so a sync costs about one round
      // trip instead of five (that delay sits in front of every room join), while still sampling
      // a spread of moments.
      const pings: Promise<Sample | null>[] = [];
      for (let i = 0; i < SYNC.CLOCK_SAMPLES && this.socket.connected; i++) {
        if (i > 0) await new Promise((r) => setTimeout(r, 40));
        pings.push(this.ping());
      }
      const fresh = (await Promise.all(pings)).filter((s): s is Sample => s !== null);
      const now = performance.now();
      const gap = wallGap();
      this.samples = [...this.samples, ...fresh].filter(
        (s) => now - s.at < SAMPLE_MAX_AGE_MS && Math.abs(s.wallGap - gap) < WALL_JUMP_MS,
      );
      const best = this.samples.reduce<Sample | null>((b, s) => (!b || s.rtt < b.rtt ? s : b), null);
      if (best) {
        this.perfOffset = best.offset;
        this.rtt = best.rtt;
        this.synced = true;
      }
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  start() {
    this.stop();
    const resync = () => {
      if (this.socket.connected) void this.sync();
    };
    this.timer = setInterval(resync, SYNC.CLOCK_RESYNC_MS);
    this.early = EARLY_RESYNCS_MS.map((ms) => setTimeout(resync, ms));
    document.addEventListener('visibilitychange', this.onVisible);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.early.forEach(clearTimeout);
    this.early = [];
    document.removeEventListener('visibilitychange', this.onVisible);
  }

  /** Back from a locked screen or another tab: the device may have slept, so measure again. */
  private onVisible = () => {
    if (document.visibilityState === 'visible' && this.socket.connected) void this.sync();
  };
}
