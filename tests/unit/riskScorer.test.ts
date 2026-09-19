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
