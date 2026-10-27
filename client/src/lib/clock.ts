import { SYNC } from '@shared/constants';
import type { AppSocket } from './socket';

interface Sample {
  offset: number;
  rtt: number;
}

/**
 * NTP-style clock sync. Each sample measures round-trip time; assuming the server stamped
 * its reply halfway through, offset = serverTime - (sendTime + rtt / 2). The sample with the
 * lowest RTT has the least room for asymmetric delay, so that's the one we keep.
 */
export class ServerClock {
  offset = 0;
  rtt = 0;
  synced = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;

  constructor(private socket: AppSocket) {}

  /** Current time on the server's clock (ms). */
  now(): number {
    return Date.now() + this.offset;
  }

  private ping(): Promise<Sample | null> {
    return new Promise((resolve) => {
      const wallStart = Date.now();
      const start = performance.now();
      const timeout = setTimeout(() => resolve(null), 3000);
      this.socket.emit('time:ping', (serverTime) => {
        clearTimeout(timeout);
        const rtt = performance.now() - start;
        resolve({ offset: serverTime - (wallStart + rtt / 2), rtt });
      });
    });
  }

  sync(): Promise<void> {
    this.running ??= (async () => {
      const samples: Sample[] = [];
      for (let i = 0; i < SYNC.CLOCK_SAMPLES && this.socket.connected; i++) {
        const s = await this.ping();
        if (s) samples.push(s);
      }
      const best = samples.sort((a, b) => a.rtt - b.rtt)[0];
      if (best) {
        this.offset = best.offset;
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
    this.timer = setInterval(() => {
      if (this.socket.connected) void this.sync();
    }, SYNC.CLOCK_RESYNC_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
