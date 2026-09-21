import type { ProviderId, ProviderObservedFacts } from "../types/schema.js";
import type { ProviderAdapter } from "../providers/types.js";

export interface CachedProviderState {
  provider: ProviderId;
  status: "ok" | "failed" | "stale";
  facts: ProviderObservedFacts[];
  rejectedCount: number;
  lastError: string | null;
  lastIngestedAt: string | null;
}

/**
 * CLAUDE.md §4 Background Ingestion Rule. This is the entire reason a
 * separate cache module exists instead of adapters being called
 * directly from the route handler: the handler must only ever read
 * `state`, never trigger a fetch — that's structurally impossible to
 * violate as long as buildRouteQuoteResponse() (router.ts) only takes
 * a CachedProviderState[] as input, which it does.
 *
 * CLAUDE.md §2/§3 — strict TTL enforcement lives HERE, not just as a
 * decaying confidence number computed downstream in router.ts. Real gap
 * this closes: previously, if the background worker silently stopped
 * ticking, the last-good data would keep being served as "ok" forever
 * — confidence would decay toward 0 in the response, but nothing ever
 * actually refused to serve it. `getStates()` now re-derives status on
 * every read against `ttlSeconds`, so data past its TTL is reported as
 * "stale" (facts cleared) regardless of what status it was written
 * with — a cache that's stopped being refreshed fails closed the same
 * way a cache that's actively erroring does.
 */
export class IngestionCache {
  private state = new Map<ProviderId, CachedProviderState>();

  constructor(
    private readonly adapters: ProviderAdapter[],
    private readonly ttlSeconds: number,
  ) {
    for (const adapter of adapters) {
      this.state.set(adapter.id, {
        provider: adapter.id,
        status: "failed",
        facts: [],
        rejectedCount: 0,
        lastError: "not yet ingested",
        lastIngestedAt: null,
      });
    }
  }

  /**
   * @param now injectable for deterministic tests — defaults to real
   * wall-clock time for production use.
   */
  getStates(now: number = Date.now()): CachedProviderState[] {
    return [...this.state.values()].map((entry) => this.withTtlApplied(entry, now));
  }

  private withTtlApplied(entry: CachedProviderState, now: number): CachedProviderState {
    // Only "ok" entries can go stale — a "failed" entry is already
    // excluded downstream for its own, more specific reason, and
    // re-labeling it "stale" would bury the real error.
    if (entry.status !== "ok" || !entry.lastIngestedAt) return entry;

    const ageSeconds = (now - new Date(entry.lastIngestedAt).getTime()) / 1000;
    if (ageSeconds <= this.ttlSeconds) return entry;

    return {
      ...entry,
      status: "stale",
      facts: [],
      lastError: `cache entry exceeded ${this.ttlSeconds}s TTL (last refreshed ${Math.round(ageSeconds)}s ago)`,
    };
  }

  /**
   * Runs every adapter and refreshes the cache. Failures are isolated
   * per-provider — CLAUDE.md §2's Fail-Closed Rule applies at the
   * provider level, not the whole system: one broken feed marks itself
   * failed and every other provider's last-good data stays servable.
   */
  async ingestAll(): Promise<void> {
    await Promise.all(
      this.adapters.map(async (adapter) => {
        try {
          const result = await adapter.fetch();
          this.state.set(adapter.id, {
            provider: adapter.id,
            status: "ok",
            facts: result.facts,
            rejectedCount: result.rejected.length,
            lastError: null,
            lastIngestedAt: result.fetchedAt,
          });
        } catch (err) {
          const previous = this.state.get(adapter.id);
          this.state.set(adapter.id, {
            provider: adapter.id,
            status: "failed",
            // Fail closed, not fail stale — a broken feed serves
            // nothing rather than silently aging data presented as current.
            facts: [],
            rejectedCount: 0,
            lastError: err instanceof Error ? err.message : String(err),
            lastIngestedAt: previous?.lastIngestedAt ?? null,
          });
        }
      }),
    );
  }
}
