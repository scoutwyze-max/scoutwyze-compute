import { randomUUID } from "node:crypto";
import type { CachedProviderState } from "../ingestion/cache.js";
import type { RouteQuote, RouteQuoteRequest, RouteQuoteResponse } from "../types/schema.js";
import { filterToTargetSku, applyRequestFilters } from "./constraintFilter.js";
import { calculateCostBreakdown, totalEffectiveCost } from "./costCalculator.js";
import { isWithinRiskTolerance, riskCategoryFromScore, scoreAvailabilityRisk } from "./riskScorer.js";

/**
 * CLAUDE.md §4 — "Never fetch live provider pages synchronously during
 * a paid request." This function only ever reads from the already-
 * populated background cache passed in — it has no fetch/HTTP call of
 * its own, by construction, not just by convention.
 */
export function buildRouteQuoteResponse(
  request: RouteQuoteRequest,
  cacheStates: CachedProviderState[],
  quoteTtlSeconds: number,
): RouteQuoteResponse {
  const now = Date.now();

  const excluded_providers: RouteQuoteResponse["excluded_providers"] = [];
  const allFacts = cacheStates.flatMap((state) => {
    // CLAUDE.md §2 Fail-Closed Rule — a provider whose last ingestion
    // run failed contributes NOTHING to this response, and that's
    // surfaced explicitly rather than just quietly having fewer quotes.
    if (state.status === "failed") {
      excluded_providers.push({ provider: state.provider, reason: state.lastError ?? "ingestion failed" });
      return [];
    }
    return state.facts;
  });

  const { kept: skuMatched, droppedForSku } = filterToTargetSku(allFacts);
  const regionFiltered = applyRequestFilters(skuMatched, request);

  const quotes: RouteQuote[] = [];
  for (const facts of regionFiltered) {
    const breakdown = calculateCostBreakdown(facts, request.workload_type);
    const effectiveCost = totalEffectiveCost(breakdown);
    if (request.max_hourly_cost_usd && effectiveCost > request.max_hourly_cost_usd) continue;

    const riskScore = scoreAvailabilityRisk(facts.capacity_type);
    const riskCategory = riskCategoryFromScore(riskScore);
    if (!isWithinRiskTolerance(riskCategory, request.max_interruption_risk)) continue;

    const observedAtMs = new Date(facts.observed_at).getTime();
    const freshnessSeconds = Math.max(0, Math.round((now - observedAtMs) / 1000));

    quotes.push({
      provider_observed: facts,
      scoutwyze_estimated: {
        effective_hourly_cost_usd: effectiveCost,
        cost_breakdown: breakdown,
        availability_risk_score: riskScore,
        interruption_risk_category: riskCategory,
      },
      metadata: {
        ttl_seconds: quoteTtlSeconds,
        freshness_seconds: freshnessSeconds,
        confidence: confidenceFromFreshness(freshnessSeconds, quoteTtlSeconds),
      },
    });
  }

  // Cheapest effective cost first — V1's one, explicit ranking rule.
  // Not blended with risk into a single opaque score, since that would
  // hide exactly the kind of derived-vs-observed distinction §3 exists
  // to prevent.
  quotes.sort((a, b) => a.scoutwyze_estimated.effective_hourly_cost_usd - b.scoutwyze_estimated.effective_hourly_cost_usd);

  for (const dropped of droppedForSku) {
    // Not a provider-level exclusion (the feed itself is fine) — just
    // informational context for why a specific listing never became a
    // quote. Kept out of excluded_providers (that's feed-level only).
    void dropped;
  }

  const overallConfidence = quotes.length
    ? quotes.reduce((sum, q) => sum + q.metadata.confidence, 0) / quotes.length
    : 0;

  return {
    request_id: randomUUID(),
    as_of: new Date(now).toISOString(),
    ttl_seconds: quoteTtlSeconds,
    confidence: Math.round(overallConfidence * 100) / 100,
    quotes,
    excluded_providers,
  };
}

function confidenceFromFreshness(freshnessSeconds: number, ttlSeconds: number): number {
  if (freshnessSeconds >= ttlSeconds) return 0;
  return Math.round((1 - freshnessSeconds / ttlSeconds) * 100) / 100;
}
