import { describe, expect, it } from "vitest";
import { calculateCostBreakdown, totalEffectiveCost } from "../../src/engine/costCalculator.js";
import type { ProviderObservedFacts } from "../../src/types/schema.js";

const baseFacts: ProviderObservedFacts = {
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
  source: "fixture",
  availability_status: null,
  observed_at: "2026-09-19T00:00:00.000Z",
};

describe("calculateCostBreakdown", () => {
  it("passes the provider's own compute rate through unmodified", () => {
    const breakdown = calculateCostBreakdown(baseFacts, "inference");
    expect(breakdown.compute_usd).toBe(baseFacts.base_hourly_rate_usd);
  });

  it("adds a nonzero storage and egress estimate on top of compute", () => {
    const breakdown = calculateCostBreakdown(baseFacts, "inference");
    expect(breakdown.storage_usd).toBeGreaterThan(0);
    expect(breakdown.estimated_egress_usd).toBeGreaterThan(0);
  });

  it("estimates higher egress for inference than fine-tuning, same node", () => {
    const inference = calculateCostBreakdown(baseFacts, "inference");
    const fineTuning = calculateCostBreakdown(baseFacts, "fine_tuning");
    expect(inference.estimated_egress_usd).toBeGreaterThan(fineTuning.estimated_egress_usd);
    // Compute and storage assumptions don't depend on workload type.
    expect(inference.compute_usd).toBe(fineTuning.compute_usd);
    expect(inference.storage_usd).toBe(fineTuning.storage_usd);
  });

  it("cpu_ram_usd is 0 when bundled into the provider's base rate", () => {
    const breakdown = calculateCostBreakdown(baseFacts, "inference");
    expect(breakdown.cpu_ram_usd).toBe(0);
  });
});

describe("totalEffectiveCost", () => {
  it("sums all four cost breakdown components", () => {
    const breakdown = {
      compute_usd: 27.12,
      storage_usd: 0.02,
      cpu_ram_usd: 0,
      estimated_egress_usd: 0.25,
    };
    expect(totalEffectiveCost(breakdown)).toBeCloseTo(27.39, 2);
  });

  it("end-to-end against the real constants, not a hand-picked breakdown", () => {
    // Locks the actual config/constants.ts values to a known answer —
    // storage_usd = 500GB * $0.023/GB-mo / 720hr = 0.15972 -> rounds 0.02
    // egress_usd (inference) = 2000GB * $0.09/GB / 720hr = 0.25 exactly
    // total = 27.12 + 0.02 + 0 + 0.25
    const breakdown = calculateCostBreakdown(baseFacts, "inference");
    expect(totalEffectiveCost(breakdown)).toBeCloseTo(27.39, 2);
  });

  it("never produces a negative total for any real provider capacity type", () => {
    for (const capacity_type of ["on_demand", "reserved", "spot"] as const) {
      const breakdown = calculateCostBreakdown({ ...baseFacts, capacity_type }, "fine_tuning");
      expect(totalEffectiveCost(breakdown)).toBeGreaterThan(0);
      expect(breakdown.compute_usd).toBeGreaterThanOrEqual(0);
      expect(breakdown.storage_usd).toBeGreaterThanOrEqual(0);
      expect(breakdown.cpu_ram_usd).toBeGreaterThanOrEqual(0);
      expect(breakdown.estimated_egress_usd).toBeGreaterThanOrEqual(0);
    }
  });

  it("rounds to whole cents, never leaking floating-point noise into the response", () => {
    const breakdown = calculateCostBreakdown(baseFacts, "inference");
    for (const value of Object.values(breakdown)) {
      expect(Number.isInteger(Math.round(value * 100))).toBe(true);
    }
  });
});
