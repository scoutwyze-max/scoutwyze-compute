import type { ProviderId, ProviderObservedFacts } from "../types/schema.js";
import type { ProviderAdapter } from "../providers/types.js";

export interface CachedProviderState {
  provider: ProviderId;
  status: "ok" | "failed";
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
 */
export class IngestionCache {
  private state = new Map<ProviderId, CachedProviderState>();

  constructor(private readonly adapters: ProviderAdapter[]) {
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

  getStates(): CachedProviderState[] {
    return [...this.state.values()];
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
