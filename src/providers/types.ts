import type { ProviderId, ProviderObservedFacts } from "../types/schema.js";

// CLAUDE.md §2 Fail-Closed Rule — an adapter never throws its way past a
// bad record and never silently drops it either. Every raw fixture entry
// either normalizes cleanly into ProviderObservedFacts, or is reported
// here with a reason. The ingestion layer decides what to do with
// rejects (log + exclude); the adapter's job is just honest reporting.
export interface ProviderFetchResult {
  provider: ProviderId;
  facts: ProviderObservedFacts[];
  rejected: { raw: unknown; reason: string }[];
  fetchedAt: string;
}

export interface ProviderAdapter {
  id: ProviderId;
  /**
   * V1: reads a local fixture file, simulating a provider feed.
   * Signature is intentionally async — a real HTTP-backed adapter drops
   * in later without changing any caller.
   */
  fetch(): Promise<ProviderFetchResult>;
}
