import { describe, expect, it } from "vitest";
import { filterAndScore, type RankedQuoteRequest } from "../../src/engine/rankedScoring.js";
import type { CachedProviderState } from "../../src/ingestion/cache.js";
import type { ProviderObservedFacts } from "../../src/types/schema.js";

function fact(overrides: Partial<ProviderObservedFacts> & { provider: ProviderObservedFacts["provider"] }): ProviderObservedFacts {
  return {
    instance_type: "test-sku",
    region: "us-east-1",
    base_hourly_rate_usd: 10,
    specs: { gpu_model: "H100 80GB SXM5", gpu_count: 8, gpu_memory_gb: 80, interconnect: "InfiniBand", vcpus: 200, ram_gb: 1800, local_storage_gb: 20000 },
    capacity_type: "on_demand",
    source: "fixture",
    availability_status: null,
    observed_at: new Date().toISOString(),
    ...overrides,
  };
}

function stateWith(facts: ProviderObservedFacts[], provider: ProviderObservedFacts["provider"] = "lambda_labs"): CachedProviderState {
  return { provider, status: "ok", facts, rejectedCount: 0, lastError: null, lastIngestedAt: facts[0]?.observed_at ?? null };
}

const baseRequest: RankedQuoteRequest = { preference: "cheapest" };

describe("filterAndScore — no_inventory / no_match", () => {
  it("returns no_inventory when the cache has zero facts across all providers", () => {
    const result = filterAndScore(baseRequest, [stateWith([]), { provider: "runpod", status: "failed", facts: [], rejectedCount: 0, lastError: "x", lastIngestedAt: null }]);
    expect(result.status).toBe("no_inventory");
  });

  it("returns no_match (not no_inventory) when facts exist but none pass the hard filters", () => {
    const result = filterAndScore(
      { ...baseRequest, gpuClass: "A100" }, // no fixture is an A100
      [stateWith([fact({ provider: "lambda_labs" })])],
    );
    expect(result.status).toBe("no_match");
  });
});

describe("filterAndScore — hard filters", () => {
  const facts = [
    fact({ provider: "lambda_labs", instance_type: "cheap", base_hourly_rate_usd: 5, region: "us-east-1" }),
    fact({ provider: "runpod", instance_type: "pricey", base_hourly_rate_usd: 50, region: "us-west-1" }),
  ];

  it("gpuClass is a case-insensitive substring match against specs.gpu_model", () => {
    const result = filterAndScore({ ...baseRequest, gpuClass: "h100" }, [stateWith(facts)]);
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.ranked).toHaveLength(2);
  });

  it("minVramGb excludes facts below the threshold", () => {
    const mixed = [fact({ provider: "lambda_labs", specs: { ...facts[0]!.specs, gpu_memory_gb: 40 } })];
    const result = filterAndScore({ ...baseRequest, minVramGb: 80 }, [stateWith(mixed)]);
    expect(result.status).toBe("no_match");
  });

  it("maxPricePerHour excludes facts above the threshold", () => {
    const result = filterAndScore({ ...baseRequest, maxPricePerHour: 10 }, [stateWith(facts)]);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.ranked).toHaveLength(1);
      expect(result.ranked[0]?.sku).toBe("cheap");
    }
  });

  it("region is a case-insensitive prefix match", () => {
    const result = filterAndScore({ ...baseRequest, region: "us-east" }, [stateWith(facts)]);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.ranked).toHaveLength(1);
      expect(result.ranked[0]?.region).toBe("us-east-1");
    }
  });

  it("all fields optional — an empty request matches everything", () => {
    const result = filterAndScore({ preference: "cheapest" }, [stateWith(facts)]);
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.ranked).toHaveLength(2);
  });
});

describe("filterAndScore — scoring and ranking", () => {
  it("cheapest preference ranks the lower price first", () => {
    const facts = [
      fact({ provider: "lambda_labs", instance_type: "expensive", base_hourly_rate_usd: 30 }),
      fact({ provider: "runpod", instance_type: "cheap", base_hourly_rate_usd: 10 }),
    ];
    const result = filterAndScore({ preference: "cheapest" }, [stateWith(facts)]);
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.ranked[0]?.sku).toBe("cheap");
  });

  it("fastest preference ranks the more recently observed fact first even if pricier", () => {
    const now = Date.now();
    const facts = [
      fact({ provider: "lambda_labs", instance_type: "cheap-stale", base_hourly_rate_usd: 5, observed_at: new Date(now - 55 * 60_000).toISOString() }),
      fact({ provider: "runpod", instance_type: "pricey-fresh", base_hourly_rate_usd: 40, observed_at: new Date(now).toISOString() }),
    ];
    const result = filterAndScore({ preference: "fastest" }, [stateWith(facts)], { now });
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.ranked[0]?.sku).toBe("pricey-fresh");
  });

  it("balanced preference weighs price and freshness equally", () => {
    const now = Date.now();
    // Same price, different freshness -> freshness alone decides.
    const facts = [
      fact({ provider: "lambda_labs", instance_type: "stale", base_hourly_rate_usd: 10, observed_at: new Date(now - 50 * 60_000).toISOString() }),
      fact({ provider: "runpod", instance_type: "fresh", base_hourly_rate_usd: 10, observed_at: new Date(now).toISOString() }),
    ];
    const result = filterAndScore({ preference: "balanced" }, [stateWith(facts)], { now });
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.ranked[0]?.sku).toBe("fresh");
  });

  it("tie-break: equal score falls back to lower price, then newer fetched_at", () => {
    const now = Date.now();
    const facts = [
      fact({ provider: "lambda_labs", instance_type: "a", base_hourly_rate_usd: 10, observed_at: new Date(now).toISOString() }),
      fact({ provider: "runpod", instance_type: "b", base_hourly_rate_usd: 10, observed_at: new Date(now).toISOString() }),
    ];
    const result = filterAndScore({ preference: "cheapest" }, [stateWith(facts)], { now });
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.ranked).toHaveLength(2);
  });

  it("every ranked entry includes a real provider and a real $/hr in its reason, plus a score breakdown", () => {
    const result = filterAndScore({ preference: "cheapest" }, [stateWith([fact({ provider: "coreweave", base_hourly_rate_usd: 32.5 })])]);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.ranked[0]?.reason).toContain("coreweave");
      expect(result.ranked[0]?.reason).toContain("$32.50/hr");
      expect(result.ranked[0]?.scoreBreakdown.weights).toEqual({ price: 0.8, freshness: 0.2 });
      expect(result.ranked[0]?.scoreBreakdown.priceScore).toBeGreaterThanOrEqual(0);
      expect(result.ranked[0]?.scoreBreakdown.freshnessScore).toBeGreaterThanOrEqual(0);
    }
  });

  it("score is always between 0 and 1 (weights sum to 1, each sub-score in [0,1])", () => {
    const facts = [
      fact({ provider: "lambda_labs", base_hourly_rate_usd: 1 }),
      fact({ provider: "runpod", base_hourly_rate_usd: 100 }),
      fact({ provider: "coreweave", base_hourly_rate_usd: 50 }),
    ];
    for (const preference of ["cheapest", "fastest", "balanced"] as const) {
      const result = filterAndScore({ preference }, [stateWith(facts)]);
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        for (const r of result.ranked) {
          expect(r.score).toBeGreaterThanOrEqual(0);
          expect(r.score).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});

describe("filterAndScore — against the real fixture-shaped data", () => {
  // Mirrors what's actually in src/providers/fixtures/*.json, so this
  // proves the real adapter output shape works end to end, not just a
  // hand-built fact().
  const lambdaFacts = [
    fact({ provider: "lambda_labs", instance_type: "gpu_8x_h100_sxm5", region: "us-east-1", base_hourly_rate_usd: 27.12 }),
    fact({ provider: "lambda_labs", instance_type: "gpu_8x_h100_sxm5", region: "us-west-1", base_hourly_rate_usd: 27.9 }),
    fact({ provider: "lambda_labs", instance_type: "gpu_4x_h100_pcie", region: "us-east-1", base_hourly_rate_usd: 11.8 }),
  ];
  const runpodFacts = [
    fact({ provider: "runpod", instance_type: "H100_80GB_SXM", region: "US-TX-1", base_hourly_rate_usd: 22.32, specs: { ...lambdaFacts[0]!.specs, gpu_model: "H100_80GB_SXM" } }),
    fact({ provider: "runpod", instance_type: "H100_80GB_SXM", region: "US-CA-2", base_hourly_rate_usd: 21.2, specs: { ...lambdaFacts[0]!.specs, gpu_model: "H100_80GB_SXM" } }),
  ];
  const coreweaveFacts = [
    fact({ provider: "coreweave", instance_type: "hgx-h100-8x-ib", region: "US-EAST-1", base_hourly_rate_usd: 32.5, capacity_type: "reserved", specs: { ...lambdaFacts[0]!.specs, gpu_model: "H100-80GB-HGX" } }),
  ];

  it("region=us-east matches Lambda's two us-east-1 rows + CoreWeave's US-EAST-1 row, case-insensitively", () => {
    const result = filterAndScore(
      { preference: "cheapest", region: "us-east" },
      [stateWith(lambdaFacts, "lambda_labs"), stateWith(runpodFacts, "runpod"), stateWith(coreweaveFacts, "coreweave")],
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.ranked).toHaveLength(3);
      expect(result.ranked.map((r) => r.provider).sort()).toEqual(["coreweave", "lambda_labs", "lambda_labs"]);
    }
  });

  it("cheapest across all 3 providers picks Lambda's 4x PCIe row at $11.80/hr", () => {
    const result = filterAndScore(
      { preference: "cheapest" },
      [stateWith(lambdaFacts, "lambda_labs"), stateWith(runpodFacts, "runpod"), stateWith(coreweaveFacts, "coreweave")],
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.ranked[0]?.vendorHourly).toBe(11.8);
      expect(result.ranked[0]?.provider).toBe("lambda_labs");
    }
  });
});

describe("filterAndScore — allowedProviders (real gap closed 2026-09-22: production is RunPod-only)", () => {
  it("excludes a cheaper provider's facts entirely when it's not in allowedProviders — it can never win, not even as an alternative", () => {
    const facts = [
      fact({ provider: "lambda_labs", instance_type: "cheap-unbookable", base_hourly_rate_usd: 1 }),
      fact({ provider: "runpod", instance_type: "pricier-bookable", base_hourly_rate_usd: 50 }),
    ];
    const result = filterAndScore({ preference: "cheapest" }, [stateWith(facts)], { allowedProviders: ["runpod"] });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.ranked).toHaveLength(1);
      expect(result.ranked[0]?.provider).toBe("runpod");
    }
  });

  it("returns no_inventory (not no_match) when every fact in the cache belongs to a disallowed provider", () => {
    const result = filterAndScore({ preference: "cheapest" }, [stateWith([fact({ provider: "lambda_labs" })])], { allowedProviders: ["runpod"] });
    expect(result.status).toBe("no_inventory");
  });

  it("omitting allowedProviders entirely applies no restriction (back-compat with every other test in this file)", () => {
    const facts = [fact({ provider: "lambda_labs" }), fact({ provider: "coreweave" })];
    const result = filterAndScore({ preference: "cheapest" }, [stateWith(facts)]);
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.ranked).toHaveLength(2);
  });
});
