import { readFileSync } from "node:fs";

/**
 * Where an adapter's raw, provider-shaped entries come from — separated
 * out from the normalization/validation logic in each adapter file
 * (lambdaLabs.ts / runpod.ts / coreweave.ts), which stays completely
 * unchanged by this. Each adapter already only cares about "an array of
 * raw entries in this provider's shape"; this is the seam that decides
 * HOW that array gets produced. V1 wires every adapter to
 * FixtureRawEntrySource (CLAUDE.md's locked "3 mock provider feeds"
 * scope); swapping a provider to a real feed later is a one-line change
 * at that adapter's own const export, not a rewrite of its parsing
 * logic.
 */
export interface RawEntrySource {
  fetchRawEntries(): Promise<unknown[]>;
}

/** V1 default for every adapter — reads a local fixture file, simulating
 * a provider feed. */
export class FixtureRawEntrySource implements RawEntrySource {
  constructor(private readonly fixturePath: string) {}

  async fetchRawEntries(): Promise<unknown[]> {
    return JSON.parse(readFileSync(this.fixturePath, "utf-8")) as unknown[];
  }
}

/**
 * Live polling, ready to wire in once a provider's real API key exists
 * — a real HTTP GET against that provider's actual instance-listing
 * endpoint. `extractEntries` handles the one thing that's genuinely
 * different per provider: where the array of listings actually lives in
 * their response envelope (top-level array vs. `{data: [...]}` vs.
 * `{data: {...}}` needing Object.values, etc.) — everything downstream
 * of that (the raw entry shape itself, normalization, schema
 * validation) is unchanged, still lives in the adapter file.
 */
export class HttpRawEntrySource implements RawEntrySource {
  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string> = {},
    private readonly extractEntries: (body: unknown) => unknown[] = (body) => body as unknown[],
  ) {}

  async fetchRawEntries(): Promise<unknown[]> {
    const res = await fetch(this.url, { headers: this.headers });
    if (!res.ok) {
      throw new Error(`live provider feed fetch failed (HTTP ${res.status}): ${await res.text()}`);
    }
    const body = await res.json();
    return this.extractEntries(body);
  }
}

/**
 * Webhook-fed polling, ready for a provider that pushes updates rather
 * than being polled — same RawEntrySource contract (fetchRawEntries()
 * returns whatever's currently known), just backed by whatever a
 * webhook route last wrote into `getLatest` (e.g. an in-memory ref or a
 * DB read) instead of an on-demand network call. The ingestion cache
 * (ingest.ts) calls fetchRawEntries() on its own interval either way —
 * it doesn't need to know or care whether the adapter is pull- or
 * push-fed underneath.
 */
export class WebhookRawEntrySource implements RawEntrySource {
  constructor(private readonly getLatest: () => unknown[]) {}

  async fetchRawEntries(): Promise<unknown[]> {
    return this.getLatest();
  }
}
