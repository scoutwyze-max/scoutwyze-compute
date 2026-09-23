import { z } from "zod";

// CLAUDE.md §2 — Target SKU is locked to one shape for V1. Not a config
// option a caller can widen; narrowing (region/workload) is all that's
// exposed, per the "do not build a sprawling 15-cloud index" rule.
export const TARGET_SKU = {
  gpuModel: "H100_80GB",
  gpuCount: 8,
  interconnect: "InfiniBand/RDMA",
} as const;

export const ProviderId = z.enum(["lambda_labs", "runpod", "coreweave"]);
export type ProviderId = z.infer<typeof ProviderId>;

export const CapacityType = z.enum(["on_demand", "reserved", "spot"]);
export type CapacityType = z.infer<typeof CapacityType>;

// Real gap closed 2026-09-23 (Robert: rank must show WHERE a number
// came from, not just claim "live"): a fact's own provenance is now
// part of what a provider "observed," not an implicit assumption.
// "fixture" is an honest label, not a euphemism for broken — Lambda
// Labs/CoreWeave stay fixture-sourced by deliberate choice (production
// is RunPod-only for booking; see book.ts), never silently upgraded to
// look live.
export const FactSource = z.enum(["live_api", "fixture"]);
export type FactSource = z.infer<typeof FactSource>;

// Provider-REPORTED availability, distinct from ScoutWyzeEstimatedReality's
// own computed interruption_risk_category below — this is literally
// what the vendor's feed says (RunPod's catalog API reports this per
// GPU/data-center), never a ScoutWyze judgment call. null when a
// provider's feed doesn't report this concept at all (e.g. today's
// fixture-sourced Lambda/CoreWeave rows) — never guessed to fill the gap.
export const ProviderReportedAvailability = z.enum(["low", "medium", "high", "none"]);
export type ProviderReportedAvailability = z.infer<typeof ProviderReportedAvailability>;

// ── Provider-observed facts ──────────────────────────────────────────
// CLAUDE.md §3.1 — exactly what a provider's own feed states, unmodified.
// Nothing in this shape is ever derived or estimated by ScoutWyze.
export const ProviderObservedFacts = z.object({
  provider: ProviderId,
  instance_type: z.string(),
  region: z.string(),
  base_hourly_rate_usd: z.number().positive(),
  specs: z.object({
    gpu_model: z.string(),
    gpu_count: z.number().int().positive(),
    gpu_memory_gb: z.number().positive(),
    interconnect: z.string(),
    vcpus: z.number().int().positive(),
    ram_gb: z.number().positive(),
    local_storage_gb: z.number().nonnegative(),
  }),
  capacity_type: CapacityType,
  source: FactSource,
  availability_status: ProviderReportedAvailability.nullable(),
  observed_at: z.string().datetime(),
});
export type ProviderObservedFacts = z.infer<typeof ProviderObservedFacts>;

// ── ScoutWyze-estimated reality ──────────────────────────────────────
// CLAUDE.md §3.2 — derived by our own cost/risk model, never presented
// as a provider-stated fact. Always kept in its own namespace in the
// response so a caller can tell "PropertyRadar said" from "we computed."
export const CostBreakdown = z.object({
  compute_usd: z.number().nonnegative(),
  storage_usd: z.number().nonnegative(),
  cpu_ram_usd: z.number().nonnegative(),
  estimated_egress_usd: z.number().nonnegative(),
});
export type CostBreakdown = z.infer<typeof CostBreakdown>;

export const InterruptionRiskCategory = z.enum(["low", "medium", "high"]);
export type InterruptionRiskCategory = z.infer<typeof InterruptionRiskCategory>;

export const ScoutWyzeEstimatedReality = z.object({
  effective_hourly_cost_usd: z.number().positive(),
  cost_breakdown: CostBreakdown,
  availability_risk_score: z.number().min(0).max(1),
  interruption_risk_category: InterruptionRiskCategory,
});
export type ScoutWyzeEstimatedReality = z.infer<typeof ScoutWyzeEstimatedReality>;

// ── Metadata & confidence ────────────────────────────────────────────
// CLAUDE.md §3.3 — per-quote freshness/confidence, distinct from the
// request-level metadata (request_id, overall ttl) in RouteQuoteResponse.
export const QuoteMetadata = z.object({
  ttl_seconds: z.number().int().positive(),
  freshness_seconds: z.number().int().nonnegative(),
  confidence: z.number().min(0).max(1),
});
export type QuoteMetadata = z.infer<typeof QuoteMetadata>;

export const RouteQuote = z.object({
  provider_observed: ProviderObservedFacts,
  scoutwyze_estimated: ScoutWyzeEstimatedReality,
  metadata: QuoteMetadata,
});
export type RouteQuote = z.infer<typeof RouteQuote>;

// ── Request ───────────────────────────────────────────────────────────
export const RouteQuoteRequest = z.object({
  region: z.string().optional(),
  workload_type: z.enum(["inference", "fine_tuning"]).default("inference"),
  max_hourly_cost_usd: z.number().positive().optional(),
  max_interruption_risk: InterruptionRiskCategory.optional(),
});
export type RouteQuoteRequest = z.infer<typeof RouteQuoteRequest>;

// ── Response ──────────────────────────────────────────────────────────
// CLAUDE.md §2 — Fail-Closed Rule: excluded_providers surfaces WHICH
// feeds were dropped and WHY, instead of silently returning fewer
// quotes with no explanation (that would be "fabricating precision").
export const RouteQuoteResponse = z.object({
  request_id: z.string(),
  as_of: z.string().datetime(),
  ttl_seconds: z.number().int().positive(),
  confidence: z.number().min(0).max(1),
  quotes: z.array(RouteQuote),
  excluded_providers: z.array(
    z.object({ provider: ProviderId, reason: z.string() }),
  ),
});
export type RouteQuoteResponse = z.infer<typeof RouteQuoteResponse>;
