interface Rule {
  /** Burst size. */
  capacity: number;
  /** Tokens regained per second. */
  refillPerSec: number;
}

/** Simple token bucket keyed by action name. One instance per socket (or per IP for HTTP). */
export class RateLimiter<K extends string> {
  private buckets = new Map<K, { tokens: number; last: number }>();

  constructor(private rules: Record<K, Rule>) {}

  take(key: K): boolean {
    const rule = this.rules[key];
    const now = Date.now();
    const bucket = this.buckets.get(key) ?? { tokens: rule.capacity, last: now };
    bucket.tokens = Math.min(rule.capacity, bucket.tokens + ((now - bucket.last) / 1000) * rule.refillPerSec);
    bucket.last = now;
    const allowed = bucket.tokens >= 1;
    if (allowed) bucket.tokens -= 1;
    this.buckets.set(key, bucket);
    return allowed;
  }
}

export const SOCKET_LIMITS = {
  ping: { capacity: 20, refillPerSec: 2 },
  join: { capacity: 5, refillPerSec: 0.5 },
  control: { capacity: 15, refillPerSec: 4 },
  heartbeat: { capacity: 5, refillPerSec: 1 },
  load: { capacity: 4, refillPerSec: 0.25 },
  queue: { capacity: 8, refillPerSec: 0.5 },
  chat: { capacity: 5, refillPerSec: 1 },
  reaction: { capacity: 10, refillPerSec: 3 },
  mood: { capacity: 6, refillPerSec: 0.5 },
  uploadToken: { capacity: 5, refillPerSec: 0.1 },
  ready: { capacity: 10, refillPerSec: 1 },
  subtitles: { capacity: 3, refillPerSec: 0.1 },
  // ICE candidates arrive in bursts while a connection is negotiated.
  rtc: { capacity: 80, refillPerSec: 10 },
} satisfies Record<string, Rule>;

/** Per-IP limiter for the HTTP room-creation endpoint. */
export class IpRateLimiter {
  private limiters = new Map<string, RateLimiter<'create'>>();

  constructor(private rule: Rule) {
    setInterval(() => this.limiters.clear(), 10 * 60 * 1000).unref();
  }

  take(ip: string): boolean {
    let limiter = this.limiters.get(ip);
    if (!limiter) {
      limiter = new RateLimiter({ create: this.rule });
      this.limiters.set(ip, limiter);
    }
    return limiter.take('create');
  }
}
