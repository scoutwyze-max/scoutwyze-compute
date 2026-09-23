import { fileURLToPath } from "node:url";
import path from "node:path";
import { ProviderObservedFacts } from "../types/schema.js";
import type { ProviderAdapter, ProviderFetchResult } from "./types.js";
import { FixtureRawEntrySource, type RawEntrySource } from "./rawSource.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(__dirname, "fixtures", "lambda-labs.fixture.json");

// Raw shape as Lambda Labs' own feed would plausibly return it —
// snake_case, price in cents, region as "region_name". Normalizing this
// into ProviderObservedFacts is the adapter's whole job; nothing else in
// the engine ever sees this shape.
interface LambdaLabsRawEntry {
  name: string;
  region_name: string;
  price_cents_per_hour: number;
  specs: {
    gpus: number;
    gpu_description: string;
    vcpus: number;
    memory_gib: number;
    storage_gib: number;
  };
  interconnect: string;
  capacity: "on_demand" | "reserved" | "spot";
  availability: string;
}

/** Normalization/validation logic — genuinely provider-specific domain
 * knowledge, unchanged by where `raw` came from. See rawSource.ts for
 * the live-polling/webhook-ready seam this now goes through. */
export function createLambdaLabsAdapter(source: RawEntrySource): ProviderAdapter {
  return {
    id: "lambda_labs",
    async fetch(): Promise<ProviderFetchResult> {
      const fetchedAt = new Date().toISOString();
      const raw = await source.fetchRawEntries();

      const facts: ProviderObservedFacts[] = [];
      const rejected: { raw: unknown; reason: string }[] = [];

      for (const entry of raw) {
        const e = entry as Partial<LambdaLabsRawEntry>;

        if (e.availability !== "available") {
          rejected.push({ raw: entry, reason: "not currently available" });
          continue;
        }
        if (!e.specs || typeof e.price_cents_per_hour !== "number") {
          rejected.push({ raw: entry, reason: "missing required fields (specs or price)" });
          continue;
        }

        const candidate: unknown = {
          provider: "lambda_labs",
          instance_type: e.name,
          region: e.region_name,
          base_hourly_rate_usd: e.price_cents_per_hour / 100,
          specs: {
            gpu_model: e.specs.gpu_description,
            gpu_count: e.specs.gpus,
            gpu_memory_gb: 80, // Lambda's own feed doesn't split this out per-GPU; H100 80GB is the only SXM5 SKU they list under this name
            interconnect: e.interconnect,
            vcpus: e.specs.vcpus,
            ram_gb: e.specs.memory_gib,
            local_storage_gb: e.specs.storage_gib,
          },
          capacity_type: e.capacity,
          // Fixture-sourced by deliberate choice, not a gap to hide —
          // production booking is RunPod-only (2026-09-22); Lambda's
          // quote data stays fixture/comparison-only, never claimed live.
          source: "fixture",
          availability_status: null, // Lambda's fixture doesn't model a provider-reported availability tier
          observed_at: fetchedAt,
        };

        const parsed = ProviderObservedFacts.safeParse(candidate);
        if (parsed.success) {
          facts.push(parsed.data);
        } else {
          rejected.push({ raw: entry, reason: `schema validation failed: ${parsed.error.message}` });
        }
      }

      return { provider: "lambda_labs", facts, rejected, fetchedAt };
    },
  };
}

// V1 wiring — CLAUDE.md's locked "3 mock provider feeds" scope. Swap to
// a real HttpRawEntrySource here (once a real Lambda Labs API key
// exists) without touching anything above.
export const lambdaLabsAdapter: ProviderAdapter = createLambdaLabsAdapter(new FixtureRawEntrySource(FIXTURE_PATH));
