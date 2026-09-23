import { describe, expect, it } from "vitest";
import { FixedWindowRateLimiter } from "../../src/api/middleware/rateLimiter.js";

describe("FixedWindowRateLimiter", () => {
  it("allows up to maxRequests within a window, then blocks", () => {
    const limiter = new FixedWindowRateLimiter(3, 60_000);
    const now = Date.now();
    expect(limiter.allow("1.2.3.4", now)).toBe(true);
    expect(limiter.allow("1.2.3.4", now)).toBe(true);
    expect(limiter.allow("1.2.3.4", now)).toBe(true);
    expect(limiter.allow("1.2.3.4", now)).toBe(false);
  });

  it("tracks each key independently — one IP being blocked doesn't affect another", () => {
    const limiter = new FixedWindowRateLimiter(1, 60_000);
    const now = Date.now();
    expect(limiter.allow("1.2.3.4", now)).toBe(true);
    expect(limiter.allow("1.2.3.4", now)).toBe(false);
    expect(limiter.allow("5.6.7.8", now)).toBe(true);
  });

  it("resets once the window has elapsed", () => {
    const limiter = new FixedWindowRateLimiter(1, 60_000);
    const now = Date.now();
    expect(limiter.allow("1.2.3.4", now)).toBe(true);
    expect(limiter.allow("1.2.3.4", now + 59_999)).toBe(false);
    expect(limiter.allow("1.2.3.4", now + 60_000)).toBe(true);
  });
});
