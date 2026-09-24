import type { CachedProviderState } from "../ingestion/cache.js";
import type { ProviderId, FactSource, ProviderReportedAvailability } from "../types/schema.js";

export type Preference = "cheapest" | "fastest" | "balanced";

export interface RankedQuoteRequest {
  gpuClass?: string;
  minVramGb?: number;
  region?: string;
  maxPricePerHour?: number;
  preference: Preference;
}

export interface ScoreBreakdown {
  priceScore: number;
  freshnessScore: number;
  weights: { price: number; freshness: number };
  ageMinutes: number;
}

export interface RankedCandidate {
  provider: ProviderId;
  sku: string;
  region: string;
  vendorHourly: number;
  vramGb: number;
  gpuCount: number;
  observed_at: string;
  // Real gap closed 2026-09-23 (Robert: "live" isn't allowed in public
  // copy until callers can SEE which rows are actually live) —
  // freshness_seconds/source/availability_status make provenance part
  // of the response itself, not a claim in a README.
  freshness_seconds: number;
  source: FactSource;
  availability_status: ProviderReportedAvailability | null;
  // Static tag (2026-09-23 envelope freeze): every field above this
  // line is a provider's own claim, untouched — as opposed to score/
  // scoreBreakdown/reason below, which are ScoutWyze's own
  // computation over those claims. One literal value today; not an
  // enum of one by accident, just nothing else reaches a caller yet
  // that would need a second value.
  classification: "provider_reported";
  score: number;
  scoreBreakdown: ScoreBreakdown;
  reason: string;
}

export type RankedScoringResult =
  | { status: "no_inventory" }
  | { status: "no_match" }
  | { status: "ok"; ranked: RankedCandidate[] };

/**
 * Documented weights, real factors only — two, not three. An earlier
 * version of this module also scored "availability" (weighted 0.1),
 * but every fact reaching this cache has ALREADY passed availability
 * filtering during ingestion (lambdaLabs.ts drops non-"available" raw
 * entries before they ever become a ProviderObservedFacts) — so that
 * third term was always exactly 1 for every candidate, a constant that
 * never actually discriminated the ranking. Removed rather than kept
 * as a no-op for false precision; a real availability signal (e.g.
 * live quota/capacity data) would be a genuine third dimension worth
 * adding back, once one exists to filter/score on.
 *
 * "fastest" is a documented proxy, not invented data: there's no real
 * provisioning-latency field on ProviderObservedFacts, so "fastest" is
 * approximated as "most recently observed" (freshest cache data is the
 * best available signal for "still actually there right now," which is
 * the practical meaning of "fast to get" without a real ETA field).
 */
const WEIGHTS: Record<Preference, { price: number; freshness: number }> = {
  cheapest: { price: 0.8, freshness: 0.2 },
  fastest: { price: 0.2, freshness: 0.8 },
  balanced: { price: 0.5, freshness: 0.5 },
};

interface RawCandidate {
  provider: ProviderId;
  sku: string;
  region: string;
  vendorHourly: number;
  vramGb: number;
  gpuCount: number;
  gpuModel: string;
  fetchedAt: string;
  source: FactSource;
  availabilityStatus: ProviderReportedAvailability | null;
}

/**
 * Rules-only ranking for POST /v1/route/rank (and re-run server-side,
 * never client-trusted, inside POST /v1/route/book) — no LLM, no
 * booking logic itself. Pure function: cache state + request in, a
 * ranked list (or a real "nothing to show" status) out. No I/O, no
 * billing, no dispatch — callers own auth/debit/booking around this.
 *
 * `allowedProviders`, when passed, restricts candidates to that set
 * BEFORE filtering/scoring — real gap closed 2026-09-22 (Robert:
 * "Production path is RunPod only... do not recommend a provider we
 * will 401/unsupported"). A provider with no real booking capability
 * (e.g. lambda_labs today — see index.ts's wiring) must never appear
 * in recommended/alternatives, not just get rejected later at dispatch
 * time. Omitted entirely = no restriction, still used as-is by
 * rankedScoring's own unit tests to exercise multi-provider scoring.
 */
export function filterAndScore(
  request: RankedQuoteRequest,
  providerStates: CachedProviderState[],
  options: { now?: number; allowedProviders?: ProviderId[] } = {},
): RankedScoringResult {
  const { now = Date.now(), allowedProviders } = options;
  const allFacts: RawCandidate[] = [];
  for (const state of providerStates) {
    for (const fact of state.facts) {
      // Filtered per-fact, not per-state: real CachedProviderState
      // grouping always has state.provider match every fact.provider
      // within it (one adapter = one provider = one state), but
      // filtering the fact's own field is strictly more correct and
      // doesn't lean on that invariant holding.
      if (allowedProviders && !allowedProviders.includes(fact.provider)) continue;
      allFacts.push({
        provider: fact.provider,
        sku: fact.instance_type,
        region: fact.region,
        vendorHourly: fact.base_hourly_rate_usd,
        vramGb: fact.specs.gpu_memory_gb,
        gpuCount: fact.specs.gpu_count,
        gpuModel: fact.specs.gpu_model,
        fetchedAt: fact.observed_at,
        source: fact.source,
        availabilityStatus: fact.availability_status,
      });
    }
  }

  if (allFacts.length === 0) return { status: "no_inventory" };

  const gpuClassLower = request.gpuClass?.toLowerCase();
  const regionLower = request.region?.toLowerCase();
  const filtered = allFacts.filter((c) => {
    if (gpuClassLower && !c.gpuModel.toLowerCase().includes(gpuClassLower)) return false;
    if (request.minVramGb !== undefined && c.vramGb < request.minVramGb) return false;
    if (request.maxPricePerHour !== undefined && c.vendorHourly > request.maxPricePerHour) return false;
    if (regionLower && !c.region.toLowerCase().startsWith(regionLower)) return false;
    return true;
  });

  if (filtered.length === 0) return { status: "no_match" };

  const prices = filtered.map((c) => c.vendorHourly);
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const weights = WEIGHTS[request.preference];

  const scored = filtered.map((c) => {
    const priceScore = 1 - (c.vendorHourly - minPrice) / (maxPrice - minPrice || 1);
    const ageMs = Math.max(0, now - new Date(c.fetchedAt).getTime());
    const ageMinutes = ageMs / 60000;
    const freshnessScore = 1 - Math.min(ageMinutes, 60) / 60;
    const score = priceScore * weights.price + freshnessScore * weights.freshness;
    // Computed once from the same raw ageMs as ageMinutes above, so the
    // public freshness_seconds field and the internal scoring math can
    // never drift apart from independent rounding.
    const ageSeconds = Math.round(ageMs / 1000);
    return { ...c, score, priceScore, freshnessScore, ageMinutes, ageSeconds };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.vendorHourly !== b.vendorHourly) return a.vendorHourly - b.vendorHourly;
    return new Date(b.fetchedAt).getTime() - new Date(a.fetchedAt).getTime();
  });

  const ranked: RankedCandidate[] = scored.map((c) => ({
    provider: c.provider,
    sku: c.sku,
    region: c.region,
    vendorHourly: c.vendorHourly,
    vramGb: c.vramGb,
    gpuCount: c.gpuCount,
    observed_at: c.fetchedAt,
    freshness_seconds: c.ageSeconds,
    source: c.source,
    availability_status: c.availabilityStatus,
    classification: "provider_reported",
    score: Math.round(c.score * 1000) / 1000,
    scoreBreakdown: {
      priceScore: Math.round(c.priceScore * 1000) / 1000,
      freshnessScore: Math.round(c.freshnessScore * 1000) / 1000,
      weights,
      ageMinutes: Math.round(c.ageMinutes * 10) / 10,
    },
    reason: buildReason(request.preference, c),
  }));

  return { status: "ok", ranked };
}

function buildReason(preference: Preference, c: { provider: ProviderId; vendorHourly: number; ageMinutes: number; priceScore: number; freshnessScore: number }): string {
  const price = `$${c.vendorHourly.toFixed(2)}/hr`;
  const age = c.ageMinutes < 1 ? "just now" : `${Math.round(c.ageMinutes)}m ago`;
  if (preference === "fastest") return `Freshest data on ${c.provider}: updated ${age} (freshness score ${c.freshnessScore.toFixed(2)}), ${price}.`;
  if (preference === "balanced") return `Best balance of price and freshness on ${c.provider}: ${price}, updated ${age}.`;
  return `Cheapest match on ${c.provider}: ${price} (price score ${c.priceScore.toFixed(2)}), updated ${age}.`;
}
