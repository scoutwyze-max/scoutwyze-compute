import { describe, expect, it } from "vitest";
import { runpodAdapter } from "../../src/providers/runpod.js";
import { coreweaveAdapter } from "../../src/providers/coreweave.js";

describe("runpodAdapter — fail-closed on unusable entries", () => {
  it("normalizes on-demand and spot-only entries, and rejects one with no usable rate at all", async () => {
    const result = await runpodAdapter.fetch();

    // 4 raw fixture entries: 2 on-demand, 1 spot-only (community cloud
    // with pricePerGpuHr:null but a real spotPrice), 1 genuinely
    // unusable (both null). Only the last should be rejected.
    expect(result.facts).toHaveLength(3);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.reason).toMatch(/no usable on-demand or spot rate/);

    const spotEntry = result.facts.find((f) => f.region === "US-NJ-1");
    expect(spotEntry?.capacity_type).toBe("spot");
    // 1.72/GPU * 8 GPUs — the adapter's own per-GPU -> per-node math.
    expect(spotEntry?.base_hourly_rate_usd).toBeCloseTo(13.76, 2);
  });

  it("never lets a rejected raw entry leak into the normalized facts array", async () => {
    const result = await runpodAdapter.fetch();
    const regions = result.facts.map((f) => f.region);
    expect(regions).not.toContain("US-WA-1");
  });
});

describe("coreweaveAdapter", () => {
  it("maps 'reserved' commitment through as the capacity_type ScoutWyze's risk model expects", async () => {
    const result = await coreweaveAdapter.fetch();
    expect(result.rejected).toHaveLength(0);
    const reserved = result.facts.find((f) => f.capacity_type === "reserved");
    expect(reserved).toBeDefined();
    expect(reserved?.region).toBe("US-EAST-1");
  });
});
