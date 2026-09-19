import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ProviderObservedFacts } from "../types/schema.js";
import type { ProviderAdapter, ProviderFetchResult } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(__dirname, "fixtures", "coreweave.fixture.json");

// Raw shape as CoreWeave's own feed would plausibly return it —
// Kubernetes-native naming ("nodePoolName"), region in shouting case,
// "commitment" instead of "capacity". CoreWeave's commercial identity is
// built on InfiniBand + reserved capacity, so "reserved" nodes here map
// to a materially lower interruption-risk profile downstream.
interface CoreweaveRawEntry {
  nodePoolName: string;
  region: string;
  gpuType: string;
  gpuQty: number;
  hourlyRateUsd: number;
  vCPU: number;
  ramGiB: number;
  ephemeralStorageGiB: number;
  fabric: string;
  commitment: "reserved" | "on_demand" | "spot";
}

export const coreweaveAdapter: ProviderAdapter = {
  id: "coreweave",
  async fetch(): Promise<ProviderFetchResult> {
    const fetchedAt = new Date().toISOString();
    const raw = JSON.parse(readFileSync(FIXTURE_PATH, "utf-8")) as unknown[];

    const facts: ProviderObservedFacts[] = [];
    const rejected: { raw: unknown; reason: string }[] = [];

    for (const entry of raw) {
      const e = entry as Partial<CoreweaveRawEntry>;

      if (typeof e.hourlyRateUsd !== "number" || !e.vCPU || !e.ramGiB) {
        rejected.push({ raw: entry, reason: "missing required rate or spec fields" });
        continue;
      }

      const candidate: unknown = {
        provider: "coreweave",
        instance_type: e.nodePoolName,
        region: e.region,
        base_hourly_rate_usd: e.hourlyRateUsd,
        specs: {
          gpu_model: e.gpuType,
          gpu_count: e.gpuQty,
          gpu_memory_gb: 80,
          interconnect: e.fabric,
          vcpus: e.vCPU,
          ram_gb: e.ramGiB,
          local_storage_gb: e.ephemeralStorageGiB ?? 0,
        },
        capacity_type: e.commitment,
        observed_at: fetchedAt,
      };

      const parsed = ProviderObservedFacts.safeParse(candidate);
      if (parsed.success) {
        facts.push(parsed.data);
      } else {
        rejected.push({ raw: entry, reason: `schema validation failed: ${parsed.error.message}` });
      }
    }

    return { provider: "coreweave", facts, rejected, fetchedAt };
  },
};
