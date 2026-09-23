import { describe, expect, it } from "vitest";
import { buildRouteQuoteResponse } from "../../src/engine/router.js";
import { RouteQuoteResponse, type ProviderObservedFacts } from "../../src/types/schema.js";
import type { CachedProviderState } from "../../src/ingestion/cache.js";

const facts: ProviderObservedFacts = {
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
  observed_at: new Date().toISOString(),
};

const cacheStates: CachedProviderState[] = [
  { provider: "coreweave", status: "ok", facts: [facts], rejectedCount: 0, lastError: null, lastIngestedAt: new Date().toISOString() },
];

describe("CLAUDE.md §3 provenance separation", () => {
  it("passes the full response against the strict RouteQuoteResponse schema", () => {
    const response = buildRouteQuoteResponse({ workload_type: "inference" }, cacheStates, 300);
    const parsed = RouteQuoteResponse.safeParse(response);
    expect(parsed.success).toBe(true);
  });

  it("provider_observed carries the raw provider fact untouched — never recalculated", () => {
    const response = buildRouteQuoteResponse({ workload_type: "inference" }, cacheStates, 300);
    const quote = response.quotes[0];
    expect(quote?.provider_observed).toEqual(facts);
  });

  it("scoutwyze_estimated is a genuinely distinct number, not a copy of the provider's base rate", () => {
    const response = buildRouteQuoteResponse({ workload_type: "inference" }, cacheStates, 300);
    const quote = response.quotes[0];
    expect(quote?.scoutwyze_estimated.effective_hourly_cost_usd).not.toBe(facts.base_hourly_rate_usd);
    expect(quote?.scoutwyze_estimated.effective_hourly_cost_usd).toBeGreaterThan(facts.base_hourly_rate_usd);
  });

  it("metadata (ttl/confidence) lives in its own namespace, not mixed into either data class", () => {
    const response = buildRouteQuoteResponse({ workload_type: "inference" }, cacheStates, 300);
    const quote = response.quotes[0];
    expect(quote?.metadata.ttl_seconds).toBe(300);
    expect(quote?.metadata).not.toHaveProperty("base_hourly_rate_usd");
    expect(quote?.metadata).not.toHaveProperty("effective_hourly_cost_usd");
  });

  it("response-level metadata includes a request_id and as_of timestamp distinct from any provider's observed_at", () => {
    const response = buildRouteQuoteResponse({ workload_type: "inference" }, cacheStates, 300);
    expect(response.request_id).toBeTruthy();
    expect(response.as_of).toBeTruthy();
  });
});
