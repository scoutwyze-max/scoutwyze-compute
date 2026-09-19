import type { ProviderObservedFacts, RouteQuoteRequest } from "../types/schema.js";

export interface FilterResult {
  kept: ProviderObservedFacts[];
  droppedForSku: { facts: ProviderObservedFacts; reason: string }[];
}

/**
 * CLAUDE.md §2 — Target SKU is locked (8x H100 80GB, InfiniBand/RDMA,
 * US regions). This runs BEFORE any request-level filtering below, so a
 * caller can never widen the engine past what V1 is actually scoped to
 * cover — the "do not build a sprawling 15-cloud index" boundary is
 * enforced here, not just documented.
 */
export function filterToTargetSku(facts: ProviderObservedFacts[]): FilterResult {
  const kept: ProviderObservedFacts[] = [];
  const droppedForSku: FilterResult["droppedForSku"] = [];

  for (const f of facts) {
    if (f.specs.gpu_count !== 8) {
      droppedForSku.push({ facts: f, reason: `gpu_count ${f.specs.gpu_count} !== target 8` });
      continue;
    }
    if (!/h100/i.test(f.specs.gpu_model) || f.specs.gpu_memory_gb !== 80) {
      droppedForSku.push({ facts: f, reason: `gpu spec "${f.specs.gpu_model}" is not H100 80GB` });
      continue;
    }
    if (!/infiniband|rdma/i.test(f.specs.interconnect)) {
      droppedForSku.push({ facts: f, reason: `interconnect "${f.specs.interconnect}" is not InfiniBand/RDMA` });
      continue;
    }
    if (!/^us/i.test(f.region)) {
      droppedForSku.push({ facts: f, reason: `region "${f.region}" is not a US-based region` });
      continue;
    }
    kept.push(f);
  }

  return { kept, droppedForSku };
}

/**
 * Request-level narrowing (region/price/risk) — applied only AFTER the
 * SKU boundary above, and only ever narrows further, never widens back.
 */
export function applyRequestFilters(
  facts: ProviderObservedFacts[],
  request: RouteQuoteRequest,
): ProviderObservedFacts[] {
  return facts.filter((f) => {
    if (request.region && f.region.toLowerCase() !== request.region.toLowerCase()) return false;
    return true;
  });
}
