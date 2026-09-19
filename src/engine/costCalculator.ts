import type { CostBreakdown, ProviderObservedFacts, RouteQuoteRequest } from "../types/schema.js";
import {
  ASSUMED_MONTHLY_EGRESS_GB_BY_WORKLOAD,
  ASSUMED_PERSISTENT_STORAGE_GB,
  CPU_RAM_UNBUNDLED_USD,
  EGRESS_RATE_USD_PER_GB,
  HOURS_PER_MONTH,
  STORAGE_RATE_USD_PER_GB_MONTH,
} from "../config/constants.js";

/**
 * CLAUDE.md §3.2 — "Total effective cost (including storage, CPU/RAM,
 * and estimated egress)". This is the whole reason the provenance split
 * exists: base_hourly_rate_usd is what the provider states, this
 * function is ScoutWyze's own estimate layered on top of it.
 */
export function calculateCostBreakdown(
  facts: ProviderObservedFacts,
  workloadType: RouteQuoteRequest["workload_type"],
): CostBreakdown {
  const storage_usd =
    (ASSUMED_PERSISTENT_STORAGE_GB * STORAGE_RATE_USD_PER_GB_MONTH) / HOURS_PER_MONTH;

  const monthlyEgressGb = ASSUMED_MONTHLY_EGRESS_GB_BY_WORKLOAD[workloadType];
  const estimated_egress_usd = (monthlyEgressGb * EGRESS_RATE_USD_PER_GB) / HOURS_PER_MONTH;

  return {
    compute_usd: facts.base_hourly_rate_usd,
    storage_usd: roundCents(storage_usd),
    cpu_ram_usd: CPU_RAM_UNBUNDLED_USD,
    estimated_egress_usd: roundCents(estimated_egress_usd),
  };
}

export function totalEffectiveCost(breakdown: CostBreakdown): number {
  return roundCents(
    breakdown.compute_usd + breakdown.storage_usd + breakdown.cpu_ram_usd + breakdown.estimated_egress_usd,
  );
}

function roundCents(value: number): number {
  return Math.round(value * 100) / 100;
}
