import { describe, expect, it } from "vitest";
import { IngestionCache } from "../../src/ingestion/cache.js";
import { buildRouteQuoteResponse } from "../../src/engine/router.js";
import type { ProviderAdapter } from "../../src/providers/types.js";
import type { ProviderObservedFacts } from "../../src/types/schema.js";

const mockFacts: ProviderObservedFacts = {
  provider: "coreweave",
  instance_type: "hgx-h100-8x-ib",
  region: "us-east-1",
  base_hourly_rate_usd: 32.5,
  specs: {
    gpu_model: "H100-80GB-HGX",
    gpu_count: 8,
    gpu_memory_gb: 80,
    interconnect: "InfiniBand NDR400",
    vcpus: 224,
    ram_gb: 2048,
    local_storage_gb: 20000,
  },
  capacity_type: "reserved",
  source: "fixture",
  availability_status: null,
  observed_at: new Date(0).toISOString(), // overwritten per-test via fetchedAt below
};

const TTL_SECONDS = 60;

function makeAdapter(fetchedAt: string): ProviderAdapter {
  return {
    id: "coreweave",
    async fetch() {
      return { provider: "coreweave" as const, facts: [{ ...mockFacts, observed_at: fetchedAt }], rejected: [], fetchedAt };
    },
  };
}

describe("IngestionCache — strict TTL enforcement (CLAUDE.md §2/§3)", () => {
  it("serves data as 'ok' while within the TTL window", async () => {
    const ingestedAt = new Date("2026-01-01T00:00:00.000Z");
    const cache = new IngestionCache([makeAdapter(ingestedAt.toISOString())], TTL_SECONDS);
    await cache.ingestAll();

    const justUnderTtl = ingestedAt.getTime() + (TTL_SECONDS - 1) * 1000;
    const [state] = cache.getStates(justUnderTtl);
    expect(state?.status).toBe("ok");
    expect(state?.facts).toHaveLength(1);
  });

  it("flips to 'stale' with facts cleared the instant it exceeds the TTL — not a soft decay", async () => {
    const ingestedAt = new Date("2026-01-01T00:00:00.000Z");
    const cache = new IngestionCache([makeAdapter(ingestedAt.toISOString())], TTL_SECONDS);
    await cache.ingestAll();

    const justOverTtl = ingestedAt.getTime() + (TTL_SECONDS + 1) * 1000;
    const [state] = cache.getStates(justOverTtl);
    expect(state?.status).toBe("stale");
    expect(state?.facts).toHaveLength(0);
    expect(state?.lastError).toMatch(/exceeded 60s TTL/);
  });

  it("does not mutate internal state on a stale read — a later read at an earlier 'now' still sees it correctly", async () => {
    // Guards against a real bug shape: if getStates() mutated the map in
    // place, a test/tool that reads with a stale `now` then a fresh
    // `now` would see corrupted data. IngestionCache.getStates() must
    // return derived copies, not write through.
    const ingestedAt = new Date("2026-01-01T00:00:00.000Z");
    const cache = new IngestionCache([makeAdapter(ingestedAt.toISOString())], TTL_SECONDS);
    await cache.ingestAll();

    const farFuture = ingestedAt.getTime() + 10_000 * 1000;
    expect(cache.getStates(farFuture)[0]?.status).toBe("stale");

    const stillFresh = ingestedAt.getTime() + 5 * 1000;
    expect(cache.getStates(stillFresh)[0]?.status).toBe("ok");
    expect(cache.getStates(stillFresh)[0]?.facts).toHaveLength(1);
  });

  it("a genuinely failed provider is never reclassified as merely 'stale' — the real error stays visible", async () => {
    const brokenAdapter: ProviderAdapter = {
      id: "coreweave",
      async fetch() {
        throw new Error("simulated feed outage, not staleness");
      },
    };
    const cache = new IngestionCache([brokenAdapter], TTL_SECONDS);
    await cache.ingestAll();

    const muchLater = Date.now() + 999_000 * 1000;
    const [state] = cache.getStates(muchLater);
    expect(state?.status).toBe("failed");
    expect(state?.lastError).toMatch(/simulated feed outage/);
  });

  it("router.ts fail-closes on a stale cache entry exactly like a failed one — excluded, reason surfaced, other providers unaffected", async () => {
    const ingestedAt = new Date("2026-01-01T00:00:00.000Z");
    const freshLambda: ProviderObservedFacts = {
      provider: "lambda_labs",
      instance_type: "gpu_8x_h100_sxm5",
      region: "us-east-1",
      base_hourly_rate_usd: 27.12,
      specs: { gpu_model: "H100 80GB SXM5", gpu_count: 8, gpu_memory_gb: 80, interconnect: "InfiniBand", vcpus: 208, ram_gb: 1800, local_storage_gb: 24576 },
      capacity_type: "on_demand",
      source: "fixture",
      availability_status: null,
      observed_at: new Date().toISOString(),
    };

    const cache = new IngestionCache([makeAdapter(ingestedAt.toISOString())], TTL_SECONDS);
    await cache.ingestAll();

    const staleReadTime = ingestedAt.getTime() + (TTL_SECONDS + 30) * 1000;
    const states = cache.getStates(staleReadTime);
    // Inject one fresh provider alongside the now-stale one, same shape
    // buildRouteQuoteResponse() would actually receive from a real cache.
    const mixedStates = [
      ...states,
      { provider: "lambda_labs" as const, status: "ok" as const, facts: [freshLambda], rejectedCount: 0, lastError: null, lastIngestedAt: new Date().toISOString() },
    ];

    const response = buildRouteQuoteResponse({ workload_type: "inference" }, mixedStates, 300);

    expect(response.quotes.some((q) => q.provider_observed.provider === "coreweave")).toBe(false);
    expect(response.quotes.some((q) => q.provider_observed.provider === "lambda_labs")).toBe(true);
    const excluded = response.excluded_providers.find((e) => e.provider === "coreweave");
    expect(excluded?.reason).toMatch(/exceeded 60s TTL/);
  });
});
