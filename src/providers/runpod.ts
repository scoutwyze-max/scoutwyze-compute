import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ProviderObservedFacts } from "../types/schema.js";
import type { ProviderAdapter, ProviderFetchResult } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(__dirname, "fixtures", "runpod.fixture.json");

// Raw shape as RunPod's own feed would plausibly return it — camelCase,
// per-GPU pricing (not per-node), and a real quirk their actual API has:
// Community Cloud entries often carry pricePerGpuHr:null with only a
// spotPrice populated. That's not malformed data, it's just a different
// capacity type — the adapter has to know the domain, not just validate
// a shape.
interface RunpodRawEntry {
  gpuTypeId: string;
  gpuCount: number;
  dataCenter: string;
  cloudType: "SECURE" | "COMMUNITY";
  pricePerGpuHr: number | null;
  vcpuCount: number;
  memoryInGb: number;
  containerDiskInGb: number;
  networkFabric: string;
  spotPrice: number | null;
}

export const runpodAdapter: ProviderAdapter = {
  id: "runpod",
  async fetch(): Promise<ProviderFetchResult> {
    const fetchedAt = new Date().toISOString();
    const raw = JSON.parse(readFileSync(FIXTURE_PATH, "utf-8")) as unknown[];

    const facts: ProviderObservedFacts[] = [];
    const rejected: { raw: unknown; reason: string }[] = [];

    for (const entry of raw) {
      const e = entry as Partial<RunpodRawEntry>;

      // On-demand (SECURE) rate is per-GPU — multiply by count for the
      // node-level rate our schema expects. Community-cloud entries with
      // no on-demand rate fall back to spot pricing, capacity_type "spot".
      let hourlyRate: number | null = null;
      let capacityType: "on_demand" | "spot" | null = null;
      if (typeof e.pricePerGpuHr === "number" && typeof e.gpuCount === "number") {
        hourlyRate = e.pricePerGpuHr * e.gpuCount;
        capacityType = "on_demand";
      } else if (typeof e.spotPrice === "number" && typeof e.gpuCount === "number") {
        hourlyRate = e.spotPrice * e.gpuCount;
        capacityType = "spot";
      }

      if (hourlyRate === null || !capacityType) {
        rejected.push({ raw: entry, reason: "no usable on-demand or spot rate present" });
        continue;
      }
      if (!e.vcpuCount || !e.memoryInGb || e.containerDiskInGb === undefined) {
        rejected.push({ raw: entry, reason: "missing required spec fields" });
        continue;
      }

      const candidate: unknown = {
        provider: "runpod",
        instance_type: e.gpuTypeId,
        region: e.dataCenter,
        base_hourly_rate_usd: hourlyRate,
        specs: {
          gpu_model: e.gpuTypeId,
          gpu_count: e.gpuCount,
          gpu_memory_gb: 80,
          interconnect: e.networkFabric,
          vcpus: e.vcpuCount,
          ram_gb: e.memoryInGb,
          local_storage_gb: e.containerDiskInGb,
        },
        capacity_type: capacityType,
        observed_at: fetchedAt,
      };

      const parsed = ProviderObservedFacts.safeParse(candidate);
      if (parsed.success) {
        facts.push(parsed.data);
      } else {
        rejected.push({ raw: entry, reason: `schema validation failed: ${parsed.error.message}` });
      }
    }

    return { provider: "runpod", facts, rejected, fetchedAt };
  },
};
