import type { CapacityType, InterruptionRiskCategory } from "../types/schema.js";
import { INTERRUPTION_RISK_BY_CAPACITY_TYPE, RISK_CATEGORY_THRESHOLDS } from "../config/constants.js";

/**
 * CLAUDE.md §3.2 — "calculated availability/interruption risk." V1
 * scores purely off capacity_type (reserved/on_demand/spot) since that's
 * the one real, consistent signal all 3 fixture providers carry. A real
 * post-V1 model would also weight historical interruption-rate data per
 * provider/region — not available yet, so not faked here.
 */
export function scoreAvailabilityRisk(capacityType: CapacityType): number {
  return INTERRUPTION_RISK_BY_CAPACITY_TYPE[capacityType];
}

export function riskCategoryFromScore(score: number): InterruptionRiskCategory {
  if (score < RISK_CATEGORY_THRESHOLDS.low) return "low";
  if (score < RISK_CATEGORY_THRESHOLDS.medium) return "medium";
  return "high";
}

const RISK_RANK: Record<InterruptionRiskCategory, number> = { low: 0, medium: 1, high: 2 };

export function isWithinRiskTolerance(
  category: InterruptionRiskCategory,
  maxAllowed: InterruptionRiskCategory | undefined,
): boolean {
  if (!maxAllowed) return true;
  return RISK_RANK[category] <= RISK_RANK[maxAllowed];
}
