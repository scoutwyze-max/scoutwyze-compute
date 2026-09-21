import { describe, expect, it } from "vitest";
import { ProviderObservedFacts, RouteQuoteResponse } from "../../src/types/schema.js";

// CLAUDE.md §2 Fail-Closed Rule, tested at its actual foundation: the
// Zod schema itself. Every adapter's fail-closed behavior (tested in
// adapters.test.ts) is only as trustworthy as this layer actually
// rejecting bad shapes — these tests don't touch fixtures or adapters
// at all, just the schema's own boundary enforcement against the kinds
// of breaks a real provider feed could plausibly introduce.

const validFacts = {
  provider: "lambda_labs",
  instance_type: "gpu_8x_h100_sxm5",
  region: "us-east-1",
  base_hourly_rate_usd: 27.12,
  specs: {
    gpu_model: "H100 80GB SXM5",
    gpu_count: 8,
    gpu_memory_gb: 80,
    interconnect: "InfiniBand (3.2 Tbps)",
    vcpus: 208,
    ram_gb: 1800,
    local_storage_gb: 24576,
  },
  capacity_type: "on_demand",
  observed_at: "2026-09-19T00:00:00.000Z",
};

describe("ProviderObservedFacts — schema-break rejections", () => {
  it("accepts a genuinely well-formed record", () => {
    expect(ProviderObservedFacts.safeParse(validFacts).success).toBe(true);
  });

  it("rejects a field with the wrong TYPE, not just a missing field — the real 'schema changed' case", () => {
    // A provider quietly switching gpu_count from a number to a numeric
    // string is exactly the kind of silent schema drift the Fail-Closed
    // Rule exists for — this is not the same failure mode as a field
    // being absent (already covered by the adapter-level reject tests).
    const drifted = { ...validFacts, specs: { ...validFacts.specs, gpu_count: "8" } };
    expect(ProviderObservedFacts.safeParse(drifted).success).toBe(false);
  });

  it("rejects an unknown capacity_type value a provider might introduce", () => {
    const drifted = { ...validFacts, capacity_type: "preemptible" };
    expect(ProviderObservedFacts.safeParse(drifted).success).toBe(false);
  });

  it("rejects a non-positive base_hourly_rate_usd (a provider bug, not a real free node)", () => {
    expect(ProviderObservedFacts.safeParse({ ...validFacts, base_hourly_rate_usd: 0 }).success).toBe(false);
    expect(ProviderObservedFacts.safeParse({ ...validFacts, base_hourly_rate_usd: -5 }).success).toBe(false);
  });

  it("rejects a malformed observed_at that isn't a real ISO datetime", () => {
    expect(ProviderObservedFacts.safeParse({ ...validFacts, observed_at: "not-a-date" }).success).toBe(false);
    expect(ProviderObservedFacts.safeParse({ ...validFacts, observed_at: "2026-09-19" }).success).toBe(false);
  });

  it("rejects a completely missing specs object outright", () => {
    const { specs, ...withoutSpecs } = validFacts;
    expect(ProviderObservedFacts.safeParse(withoutSpecs).success).toBe(false);
  });
});

describe("RouteQuoteResponse — confidence/probability bounds are enforced, not just documented", () => {
  const baseResponse = {
    request_id: "req-1",
    as_of: "2026-09-19T00:00:00.000Z",
    ttl_seconds: 300,
    confidence: 0.9,
    quotes: [],
    excluded_providers: [],
  };

  it("accepts a well-formed empty-quotes response (the real 'all providers down' shape)", () => {
    expect(RouteQuoteResponse.safeParse(baseResponse).success).toBe(true);
  });

  it("rejects a confidence value outside [0,1] — a calculation bug, not a valid edge case", () => {
    expect(RouteQuoteResponse.safeParse({ ...baseResponse, confidence: 1.5 }).success).toBe(false);
    expect(RouteQuoteResponse.safeParse({ ...baseResponse, confidence: -0.1 }).success).toBe(false);
  });

  it("rejects an excluded_providers entry naming a provider outside the 3 configured ones", () => {
    const drifted = {
      ...baseResponse,
      excluded_providers: [{ provider: "aws_ec2", reason: "not one of ours" }],
    };
    expect(RouteQuoteResponse.safeParse(drifted).success).toBe(false);
  });
});
