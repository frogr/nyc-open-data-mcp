/**
 * Small in-memory limiters for the HTTP server. One process, no Redis:
 * good enough for a single free-tier instance. If you run several
 * instances, each one keeps its own counts.
 */

export type Clock = () => number;

export interface LimitResult {
  allowed: boolean;
  /** Requests left in the current window (0 when blocked). */
  remaining: number;
  /** Seconds until the caller can try again (0 when allowed). */
  retryAfterSec: number;
}

/**
 * Per-key token bucket. Each key gets `capacity` requests, refilled
 * continuously at `capacity` per `windowMs`. Allows short bursts but
 * holds the long-run rate to capacity / window.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; updated: number }>();
  private readonly refillPerMs: number;
  private lastSweep: number;

  constructor(
    readonly capacity: number,
    readonly windowMs: number,
    private readonly now: Clock = Date.now,
    /** Upper bound on tracked keys, so a flood of distinct IPs can't grow memory without limit. */
    private readonly maxKeys = 10_000,
  ) {
    if (!(capacity > 0) || !(windowMs > 0)) throw new RangeError("capacity and windowMs must be positive");
    this.refillPerMs = capacity / windowMs;
    this.lastSweep = now();
  }

  take(key: string): LimitResult {
    const t = this.now();
    this.sweep(t);
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= this.maxKeys) {
        const oldest = this.buckets.keys().next().value;
        if (oldest !== undefined) this.buckets.delete(oldest);
      }
      b = { tokens: this.capacity, updated: t };
      this.buckets.set(key, b);
    } else {
      b.tokens = Math.min(this.capacity, b.tokens + (t - b.updated) * this.refillPerMs);
      b.updated = t;
    }
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { allowed: true, remaining: Math.floor(b.tokens), retryAfterSec: 0 };
    }
    return { allowed: false, remaining: 0, retryAfterSec: Math.max(1, Math.ceil((1 - b.tokens) / this.refillPerMs / 1000)) };
  }

  get size(): number {
    return this.buckets.size;
  }

  /** Drop buckets that have been idle long enough to be full again. */
  private sweep(t: number) {
    if (t - this.lastSweep < this.windowMs) return;
    this.lastSweep = t;
    for (const [key, b] of this.buckets) {
      if (t - b.updated >= this.windowMs) this.buckets.delete(key);
    }
  }
}

/** Global cap on requests per UTC day, across all callers. */
export class DailyCap {
  private day = "";
  private count = 0;

  constructor(
    readonly limit: number,
    private readonly now: Clock = Date.now,
  ) {}

  take(): LimitResult {
    const t = this.now();
    const today = new Date(t).toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.count = 0;
    }
    if (this.count >= this.limit) {
      const tomorrow = Date.parse(`${today}T00:00:00Z`) + 86_400_000;
      return { allowed: false, remaining: 0, retryAfterSec: Math.max(1, Math.ceil((tomorrow - t) / 1000)) };
    }
    this.count++;
    return { allowed: true, remaining: this.limit - this.count, retryAfterSec: 0 };
  }

  get used(): number {
    return this.count;
  }
}
