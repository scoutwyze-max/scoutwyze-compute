import { fileURLToPath } from "node:url";
import path from "node:path";
import { ProviderObservedFacts, type FactSource, type ProviderReportedAvailability } from "../types/schema.js";
import type { ProviderAdapter, ProviderFetchResult } from "./types.js";
import { FixtureRawEntrySource, type RawEntrySource } from "./rawSource.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(__dirname, "fixtures", "runpod.fixture.json");

// Raw shape as RunPod's own feed would plausibly return it — camelCase,
// per-GPU pricing (not per-node), and a real quirk their actual API has:
// Community Cloud entries often carry pricePerGpuHr:null with only a
// spotPrice populated. That's not malformed data, it's just a different
// capacity type — the adapter has to know the domain, not just validate
// a shape.
//
// gpuTypeId/dataCenter values in the fixture are real, verified strings
// (not invented) — confirmed 2026-09-22 against RunPod's own
// GET /v2/catalog/gpus?include=AVAILABILITY&product=POD, after an
// earlier fixture version used a Lambda-style invented ID
// ("H100_80GB_SXM") that RunPod's real /v2/pods rejected with a 422.
// These pass straight through to RunPodBooker's real launch request
// (gpu.id / dataCenterIds) unchanged, same as Lambda Labs' fixture.
//
// availability, when present, is RunPod's own per-data-center reported
// tier (LOW/MEDIUM/HIGH/NONE from the live catalog) — undefined for
// fixture rows, which don't model this concept.
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
  gpuMemoryGb?: number;
  availability?: string;
}

function normalizeAvailability(raw: string | undefined): ProviderReportedAvailability | null {
  const lower = raw?.toLowerCase();
  if (lower === "low" || lower === "medium" || lower === "high" || lower === "none") return lower;
  return null; // unrecognized/absent — never guessed
}

/** Normalization/validation logic — genuinely provider-specific domain
 * knowledge, unchanged by where `raw` came from. See rawSource.ts for
 * the live-polling/webhook-ready seam this now goes through.
 *
 * `factSource` is an explicit, required label (not inferred from which
 * RawEntrySource was passed) — real gap closed 2026-09-23: a caller
 * saying "this is live" should be a deliberate statement at the call
 * site, not something that can drift silently if the source strategy
 * ever changes underneath it. */
export function createRunpodAdapter(source: RawEntrySource, factSource: FactSource): ProviderAdapter {
  return {
    id: "runpod",
    async fetch(): Promise<ProviderFetchResult> {
      const fetchedAt = new Date().toISOString();
      const raw = await source.fetchRawEntries();

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
            gpu_memory_gb: e.gpuMemoryGb ?? 80,
            interconnect: e.networkFabric,
            vcpus: e.vcpuCount,
            ram_gb: e.memoryInGb,
            local_storage_gb: e.containerDiskInGb,
          },
          capacity_type: capacityType,
          source: factSource,
          availability_status: normalizeAvailability(e.availability),
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
}

// Real shape of RunPod's live catalog response
// (GET /v2/catalog/gpus?include=AVAILABILITY&product=POD), verified
// directly 2026-09-22/23 — not from memory. One entry per GPU type,
// with a nested per-data-center availability list and separate
// SECURE/COMMUNITY pricing tiers.
interface RunpodCatalogDataCenter {
  id: string;
  availability: string;
}
interface RunpodCatalogGpu {
  id: string;
  memory: number;
  maxCount?: { community?: number; secure?: number };
  price?: { community?: number; secure?: number; serverless?: number };
  dataCenters?: RunpodCatalogDataCenter[];
}
interface RunpodCatalogResponse {
  gpus?: RunpodCatalogGpu[];
}

/**
 * Real, live RunPod v2 catalog dispatch — flattens RunPod's per-GPU,
 * nested-per-data-center response into the same per-(gpu,datacenter,
 * tier) row shape createRunpodAdapter already expects, so the
 * normalization logic above doesn't need to know or care that this
 * source is live instead of fixture.
 *
 * vcpuCount/memoryInGb/containerDiskInGb/networkFabric have NO real
 * analog in this catalog endpoint — RunPod doesn't report per-node
 * vcpu/ram/disk/interconnect at this level (that's pod-template detail,
 * a different, narrower endpoint this doesn't call). Rather than
 * fabricate plausible-looking numbers (the exact mistake the old
 * fixture made with "H100_80GB_SXM"), these get honest, structurally-
 * required minimums with a comment, not invented precision. The real,
 * visible consequence: /v1/route/quote's TARGET_SKU filter
 * (constraintFilter.ts) requires InfiniBand/RDMA and will correctly
 * exclude these rows with a stated reason — that's the fail-closed
 * behavior working as designed, not a bug to work around.
 */
export class RunpodLiveCatalogSource implements RawEntrySource {
  constructor(private readonly apiKey: string) {}

  async fetchRawEntries(): Promise<unknown[]> {
    const res = await fetch("https://api.runpod.io/v2/catalog/gpus?include=AVAILABILITY&product=POD", {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    if (!res.ok) {
      throw new Error(`RunPod catalog fetch failed (HTTP ${res.status}): ${await res.text()}`);
    }
    const body = (await res.json()) as RunpodCatalogResponse;

    const entries: RunpodRawEntry[] = [];
    for (const gpu of body.gpus ?? []) {
      for (const dc of gpu.dataCenters ?? []) {
        const base = {
          gpuTypeId: gpu.id,
          dataCenter: dc.id,
          gpuMemoryGb: gpu.memory,
          availability: dc.availability,
          // Not reported by this endpoint — see class doc comment.
          vcpuCount: 1,
          memoryInGb: 1,
          containerDiskInGb: 0,
          networkFabric: "unspecified",
        };
        if (typeof gpu.price?.secure === "number" && gpu.maxCount?.secure) {
          entries.push({ ...base, gpuCount: gpu.maxCount.secure, cloudType: "SECURE", pricePerGpuHr: gpu.price.secure, spotPrice: null });
        }
        if (typeof gpu.price?.community === "number" && gpu.maxCount?.community) {
          entries.push({ ...base, gpuCount: gpu.maxCount.community, cloudType: "COMMUNITY", pricePerGpuHr: null, spotPrice: gpu.price.community });
        }
      }
    }
    return entries;
  }
}

// V1 default wiring — fixture-backed, used by registry.ts and every
// test in this repo. Deliberately NOT env-var-conditional here (that
// would make tests' behavior depend on whatever happens to be in the
// environment they run in, including a real network call if
// RUNPOD_API_KEY were ever set locally) — index.ts is the one place
// that decides fixture vs. live, explicitly, for the real running app.
export const runpodAdapter: ProviderAdapter = createRunpodAdapter(new FixtureRawEntrySource(FIXTURE_PATH), "fixture");
