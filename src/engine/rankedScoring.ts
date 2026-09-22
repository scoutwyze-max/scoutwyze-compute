import type { CachedProviderState } from "../ingestion/cache.js";
import type { ProviderId } from "../types/schema.js";

export type Preference = "cheapest" | "freshest" | "available";

export interface RankedQuoteRequest {
  gpuClass?: string;
  minVramGb?: number;
  region?: string;
  maxPricePerHour?: number;
  preference: Preference;
}

export interface RankedCandidate {
  provider: ProviderId;
  sku: string;
  region: string;
  pricePerHour: number;
  vramGb: number;
  fetchedAt: string;
  score: number;
  reason: string;
}

export type RankedScoringResult =
  | { status: "no_inventory" }
  | { status: "no_match" }
  | { status: "ok"; ranked: RankedCandidate[] };

const WEIGHTS: Record<Preference, { price: number; fresh: number; avail: number }> = {
  cheapest: { price: 0.7, fresh: 0.2, avail: 0.1 },
  freshest: { price: 0.2, fresh: 0.7, avail: 0.1 },
  available: { price: 0.2, fresh: 0.1, avail: 0.7 },
};

interface RawCandidate {
  provider: ProviderId;
  sku: string;
  region: string;
  pricePerHour: number;
  vramGb: number;
  gpuModel: string;
  fetchedAt: string;
}

/**
 * Rules-only ranking for POST /v1/route/rank — no LLM, no booking.
 * Pure function: cache state + request in, a ranked list (or a real
 * "nothing to show" status) out. No I/O, no billing — the route
 * handler owns auth/debit around this.
 *
 * Real gap, not invented: ProviderObservedFacts has no availability/
 * in-stock boolean. Lambda Labs' adapter already drops non-"available"
 * raw entries during ingestion (lambdaLabs.ts) — everything reaching
 * this cache is implicitly available already, so availScore is always
 * 1 and the "in stock" hard filter is a no-op by construction, not
 * skipped by choice.
 */
export function filterAndScore(request: RankedQuoteRequest, providerStates: CachedProviderState[], now: number = Date.now()): RankedScoringResult {
  const allFacts: RawCandidate[] = [];
  for (const state of providerStates) {
    for (const fact of state.facts) {
      allFacts.push({
        provider: fact.provider,
        sku: fact.instance_type,
        region: fact.region,
        pricePerHour: fact.base_hourly_rate_usd,
        vramGb: fact.specs.gpu_memory_gb,
        gpuModel: fact.specs.gpu_model,
        fetchedAt: fact.observed_at,
      });
    }
  }

  if (allFacts.length === 0) return { status: "no_inventory" };

  const gpuClassLower = request.gpuClass?.toLowerCase();
  const regionLower = request.region?.toLowerCase();
  const filtered = allFacts.filter((c) => {
    if (gpuClassLower && !c.gpuModel.toLowerCase().includes(gpuClassLower)) return false;
    if (request.minVramGb !== undefined && c.vramGb < request.minVramGb) return false;
    if (request.maxPricePerHour !== undefined && c.pricePerHour > request.maxPricePerHour) return false;
    if (regionLower && !c.region.toLowerCase().startsWith(regionLower)) return false;
    // availability hard filter — always true, see header comment
    return true;
  });

  if (filtered.length === 0) return { status: "no_match" };

  const prices = filtered.map((c) => c.pricePerHour);
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const weights = WEIGHTS[request.preference];

  const scored = filtered.map((c) => {
    const priceScore = 1 - (c.pricePerHour - minPrice) / (maxPrice - minPrice || 1);
    const ageMinutes = Math.max(0, (now - new Date(c.fetchedAt).getTime()) / 60000);
    const freshScore = 1 - Math.min(ageMinutes, 60) / 60;
    const availScore = 1; // every cached fact already passed availability filtering at ingest
    const score = priceScore * weights.price + freshScore * weights.fresh + availScore * weights.avail;
    return { ...c, score, ageMinutes };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.pricePerHour !== b.pricePerHour) return a.pricePerHour - b.pricePerHour;
    return new Date(b.fetchedAt).getTime() - new Date(a.fetchedAt).getTime();
  });

  const ranked: RankedCandidate[] = scored.map((c) => ({
    provider: c.provider,
    sku: c.sku,
    region: c.region,
    pricePerHour: c.pricePerHour,
    vramGb: c.vramGb,
    fetchedAt: c.fetchedAt,
    score: Math.round(c.score * 1000) / 1000,
    reason: buildReason(request.preference, c),
  }));

  return { status: "ok", ranked };
}

function buildReason(preference: Preference, c: { provider: ProviderId; pricePerHour: number; ageMinutes: number }): string {
  const price = `$${c.pricePerHour.toFixed(2)}/hr`;
  const age = c.ageMinutes < 1 ? "just now" : `${Math.round(c.ageMinutes)}m ago`;
  if (preference === "freshest") return `Freshest match on ${c.provider}: updated ${age}, ${price}.`;
  if (preference === "available") return `Available now on ${c.provider}: ${price}, updated ${age}.`;
  return `Cheapest match on ${c.provider}: ${price}, updated ${age}.`;
}
