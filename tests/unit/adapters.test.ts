import { describe, expect, it } from "vitest";
import { runpodAdapter, createRunpodAdapter } from "../../src/providers/runpod.js";
import { coreweaveAdapter, createCoreweaveAdapter } from "../../src/providers/coreweave.js";
import { createLambdaLabsAdapter } from "../../src/providers/lambdaLabs.js";
import type { RawEntrySource } from "../../src/providers/rawSource.js";

describe("runpodAdapter — fail-closed on unusable entries", () => {
  it("normalizes on-demand and spot-only entries, and rejects one with no usable rate at all", async () => {
    const result = await runpodAdapter.fetch();

    // 4 raw fixture entries: 2 on-demand, 1 spot-only (community cloud
    // with pricePerGpuHr:null but a real spotPrice), 1 genuinely
    // unusable (both null). Only the last should be rejected.
    expect(result.facts).toHaveLength(3);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.reason).toMatch(/no usable on-demand or spot rate/);

    const spotEntry = result.facts.find((f) => f.region === "US-GA-2" && f.capacity_type === "spot");
    expect(spotEntry?.capacity_type).toBe("spot");
    // 1.72/GPU * 8 GPUs — the adapter's own per-GPU -> per-node math.
    expect(spotEntry?.base_hourly_rate_usd).toBeCloseTo(13.76, 2);
  });

  it("never lets a rejected raw entry leak into the normalized facts array", async () => {
    const result = await runpodAdapter.fetch();
    const regions = result.facts.map((f) => f.region);
    expect(regions).not.toContain("US-NE-1");
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

/** Real proof the live-polling/webhook-ready refactor (rawSource.ts)
 * actually wired through, not just present as unused exports — each
 * adapter factory must call the INJECTED source, not silently still
 * read its own fixture file underneath. */
describe("adapter factories honor an injected RawEntrySource (not just the default fixture)", () => {
  function fakeSource(entries: unknown[]): RawEntrySource {
    return { async fetchRawEntries() { return entries; } };
  }

  it("createLambdaLabsAdapter normalizes entries from a custom source", async () => {
    const adapter = createLambdaLabsAdapter(fakeSource([
      {
        name: "custom-instance",
        region_name: "custom-region",
        price_cents_per_hour: 500,
        specs: { gpus: 8, gpu_description: "H100 80GB", vcpus: 100, memory_gib: 800, storage_gib: 5000 },
        interconnect: "InfiniBand",
        capacity: "on_demand",
        availability: "available",
      },
    ]));
    const result = await adapter.fetch();
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0]?.region).toBe("custom-region");
    expect(result.facts[0]?.base_hourly_rate_usd).toBe(5);
  });

  it("createRunpodAdapter normalizes entries from a custom source", async () => {
    const adapter = createRunpodAdapter(fakeSource([
      {
        gpuTypeId: "custom-gpu",
        gpuCount: 8,
        dataCenter: "custom-dc",
        cloudType: "SECURE",
        pricePerGpuHr: 2,
        vcpuCount: 64,
        memoryInGb: 512,
        containerDiskInGb: 1000,
        networkFabric: "custom-fabric",
        spotPrice: null,
      },
    ]));
    const result = await adapter.fetch();
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0]?.region).toBe("custom-dc");
    expect(result.facts[0]?.base_hourly_rate_usd).toBe(16);
  });

  it("createCoreweaveAdapter normalizes entries from a custom source", async () => {
    const adapter = createCoreweaveAdapter(fakeSource([
      {
        nodePoolName: "custom-pool",
        region: "CUSTOM-REGION",
        gpuType: "H100 80GB",
        gpuQty: 8,
        hourlyRateUsd: 22.5,
        vCPU: 128,
        ramGiB: 1000,
        ephemeralStorageGiB: 8000,
        fabric: "InfiniBand",
        commitment: "reserved",
      },
    ]));
    const result = await adapter.fetch();
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0]?.region).toBe("CUSTOM-REGION");
    expect(result.facts[0]?.capacity_type).toBe("reserved");
  });

  it("a source that throws (e.g. a live HTTP failure) propagates rather than being swallowed", async () => {
    const failingSource: RawEntrySource = {
      async fetchRawEntries(): Promise<unknown[]> {
        throw new Error("simulated live feed outage");
      },
    };
    const adapter = createRunpodAdapter(failingSource);
    await expect(adapter.fetch()).rejects.toThrow(/simulated live feed outage/);
  });
});
