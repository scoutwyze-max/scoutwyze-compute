import { describe, expect, it } from "vitest";
import { filterToTargetSku, applyRequestFilters } from "../../src/engine/constraintFilter.js";
import { lambdaLabsAdapter } from "../../src/providers/lambdaLabs.js";
import type { ProviderObservedFacts } from "../../src/types/schema.js";

describe("filterToTargetSku", () => {
  it("keeps only 8x H100 80GB InfiniBand US-region listings from a real adapter's output", async () => {
    const result = await lambdaLabsAdapter.fetch();
    // Fixture deliberately includes a 4x H100 PCIe entry that must NOT
    // survive the SKU filter — this is the real CLAUDE.md §2 boundary,
    // not just a schema check.
    expect(result.facts.length).toBe(3);

    const { kept, droppedForSku } = filterToTargetSku(result.facts);
    expect(kept).toHaveLength(2);
    expect(kept.every((f) => f.specs.gpu_count === 8)).toBe(true);
    expect(kept.every((f) => /infiniband/i.test(f.specs.interconnect))).toBe(true);

    expect(droppedForSku).toHaveLength(1);
    expect(droppedForSku[0]?.facts.instance_type).toBe("gpu_4x_h100_pcie");
  });

  it("drops non-US regions", () => {
    const nonUs: ProviderObservedFacts = {
      provider: "coreweave",
      instance_type: "hgx-h100-8x-ib",
      region: "EU-LONDON-1",
      base_hourly_rate_usd: 33,
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
      observed_at: new Date().toISOString(),
    };
    const { kept, droppedForSku } = filterToTargetSku([nonUs]);
    expect(kept).toHaveLength(0);
    expect(droppedForSku[0]?.reason).toMatch(/US-based region/);
  });
});

describe("applyRequestFilters", () => {
  it("narrows to a specific region when the request asks for one", async () => {
    const result = await lambdaLabsAdapter.fetch();
    const { kept } = filterToTargetSku(result.facts);
    const filtered = applyRequestFilters(kept, { region: "us-east-1", workload_type: "inference" });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.region).toBe("us-east-1");
  });

  it("passes everything through when no region is requested", async () => {
    const result = await lambdaLabsAdapter.fetch();
    const { kept } = filterToTargetSku(result.facts);
    const filtered = applyRequestFilters(kept, { workload_type: "inference" });
    expect(filtered).toHaveLength(kept.length);
  });
});
