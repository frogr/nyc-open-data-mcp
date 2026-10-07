import { describe, expect, it } from "vitest";
import { configFromEnv, DEFAULT_CONFIG } from "../src/app.js";
import { DailyCap, RateLimiter } from "../src/rateLimit.js";

function clock(start = Date.parse("2026-10-07T12:00:00Z")) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("RateLimiter", () => {
  it("allows a burst up to capacity, then blocks with a retry hint", () => {
    const c = clock();
    const rl = new RateLimiter(3, 60_000, c.now);
    expect([rl.take("a"), rl.take("a"), rl.take("a")].map((r) => r.allowed)).toEqual([true, true, true]);
    const blocked = rl.take("a");
    expect(blocked).toEqual({ allowed: false, remaining: 0, retryAfterSec: 20 });
  });

  it("refills continuously over the window", () => {
    const c = clock();
    const rl = new RateLimiter(3, 60_000, c.now);
    for (let i = 0; i < 3; i++) rl.take("a");
    c.advance(19_000);
    expect(rl.take("a").allowed).toBe(false);
    c.advance(1_000);
    expect(rl.take("a").allowed).toBe(true);
    c.advance(10 * 60_000);
    expect(rl.take("a").remaining).toBe(2); // refill caps at capacity
  });

  it("tracks keys independently", () => {
    const rl = new RateLimiter(1, 60_000, clock().now);
    expect(rl.take("1.1.1.1").allowed).toBe(true);
    expect(rl.take("1.1.1.1").allowed).toBe(false);
    expect(rl.take("2.2.2.2").allowed).toBe(true);
  });

  it("bounds memory: evicts the oldest key past maxKeys and sweeps idle keys", () => {
    const c = clock();
    const rl = new RateLimiter(1, 60_000, c.now, 2);
    rl.take("a");
    rl.take("b");
    rl.take("c");
    expect(rl.size).toBe(2);
    expect(rl.take("a").allowed).toBe(true); // "a" was evicted, so it starts fresh
    c.advance(60_000);
    rl.take("d");
    expect(rl.size).toBe(1);
  });

  it("rejects nonsense configuration", () => {
    expect(() => new RateLimiter(0, 60_000)).toThrow(RangeError);
  });
});

describe("DailyCap", () => {
  it("caps requests per UTC day and resets at midnight", () => {
    const c = clock(Date.parse("2026-10-07T23:59:00Z"));
    const cap = new DailyCap(2, c.now);
    expect(cap.take().allowed).toBe(true);
    expect(cap.take().allowed).toBe(true);
    const blocked = cap.take();
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBe(60);
    c.advance(60_000);
    expect(cap.take()).toMatchObject({ allowed: true, remaining: 1 });
    expect(cap.used).toBe(1);
  });
});

describe("configFromEnv", () => {
  it("reads numbers and falls back on missing or invalid values", () => {
    expect(configFromEnv({})).toEqual(DEFAULT_CONFIG);
    expect(
      configFromEnv({ RATE_LIMIT_PER_MINUTE: "5", DAILY_REQUEST_LIMIT: "abc", MAX_BODY_BYTES: "-1", REQUEST_TIMEOUT_MS: "1000", CORS_ORIGINS: " https://a.example " }),
    ).toEqual({ ...DEFAULT_CONFIG, rateLimitPerMinute: 5, requestTimeoutMs: 1000, corsOrigins: "https://a.example" });
  });
});
