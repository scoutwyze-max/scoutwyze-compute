/**
 * Minimal in-memory fixed-window rate limiter — no new dependency, no
 * shared state beyond this process. Correct for a single-instance Fly
 * app (see fly.toml's own "single-instance by design" note); would
 * need a shared store (Redis/DB) the moment there's more than one
 * machine, which V1 deliberately doesn't have.
 */
export class FixedWindowRateLimiter {
  private hits = new Map<string, { count: number; windowStart: number }>();

  constructor(
    private readonly maxRequests: number,
    private readonly windowMs: number,
  ) {}

  /** @param now injectable for deterministic tests. */
  allow(key: string, now: number = Date.now()): boolean {
    const entry = this.hits.get(key);
    if (!entry || now - entry.windowStart >= this.windowMs) {
      this.hits.set(key, { count: 1, windowStart: now });
      return true;
    }
    if (entry.count >= this.maxRequests) return false;
    entry.count += 1;
    return true;
  }
}
