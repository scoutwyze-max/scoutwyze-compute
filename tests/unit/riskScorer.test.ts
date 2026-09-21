import { describe, expect, it } from "vitest";
import {
  isWithinRiskTolerance,
  riskCategoryFromScore,
  scoreAvailabilityRisk,
} from "../../src/engine/riskScorer.js";

describe("scoreAvailabilityRisk", () => {
  it("ranks reserved capacity as materially safer than on_demand and spot", () => {
    const reserved = scoreAvailabilityRisk("reserved");
    const onDemand = scoreAvailabilityRisk("on_demand");
    const spot = scoreAvailabilityRisk("spot");
    expect(reserved).toBeLessThan(onDemand);
    expect(onDemand).toBeLessThan(spot);
  });
});

describe("riskCategoryFromScore", () => {
  it("buckets scores into low/medium/high consistently with the configured thresholds", () => {
    expect(riskCategoryFromScore(0.05)).toBe("low");
    expect(riskCategoryFromScore(0.25)).toBe("medium");
    expect(riskCategoryFromScore(0.65)).toBe("high");
  });

  it("resolves exact boundary values deterministically (< not <=, so a score AT a threshold rounds up)", () => {
    // RISK_CATEGORY_THRESHOLDS = { low: 0.15, medium: 0.4 } — a score of
    // exactly 0.15 is NOT low (it takes the medium bucket), and exactly
    // 0.4 is NOT medium (it takes high). This is the kind of off-by-one
    // that's easy to get backwards silently, so it's locked in explicitly
    // rather than only tested via the capacity-type presets, which never
    // happen to land exactly on a boundary.
    expect(riskCategoryFromScore(0.15)).toBe("medium");
    expect(riskCategoryFromScore(0.149999)).toBe("low");
    expect(riskCategoryFromScore(0.4)).toBe("high");
    expect(riskCategoryFromScore(0.399999)).toBe("medium");
  });

  it("real capacity-type presets each land in their intended category", () => {
    // Guards against someone tweaking INTERRUPTION_RISK_BY_CAPACITY_TYPE
    // in constants.ts and accidentally shifting a capacity type into the
    // wrong risk bucket without noticing.
    expect(riskCategoryFromScore(scoreAvailabilityRisk("reserved"))).toBe("low");
    expect(riskCategoryFromScore(scoreAvailabilityRisk("on_demand"))).toBe("medium");
    expect(riskCategoryFromScore(scoreAvailabilityRisk("spot"))).toBe("high");
  });
});

describe("isWithinRiskTolerance", () => {
  it("allows anything when no max is specified", () => {
    expect(isWithinRiskTolerance("high", undefined)).toBe(true);
  });

  it("rejects a category riskier than the caller's stated max", () => {
    expect(isWithinRiskTolerance("high", "low")).toBe(false);
    expect(isWithinRiskTolerance("medium", "low")).toBe(false);
  });

  it("allows a category at or safer than the caller's stated max", () => {
    expect(isWithinRiskTolerance("low", "medium")).toBe(true);
    expect(isWithinRiskTolerance("medium", "medium")).toBe(true);
  });
});
