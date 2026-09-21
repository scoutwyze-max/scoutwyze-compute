import { describe, expect, it, vi, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { IngestionCache } from "../../src/ingestion/cache.js";
import { registerQuoteRoute } from "../../src/api/routes/quote.js";
import { createDatabase } from "../../src/db/connection.js";
import { ApiKeyStore } from "../../src/billing/apiKeyStore.js";
import { CreditLedger } from "../../src/billing/creditLedger.js";
import { ChallengeStore } from "../../src/api/middleware/x402.js";
import { ProcessedEventStore } from "../../src/payments/processedEvents.js";
import { FakeChainReader } from "../helpers/fakeChainReader.js";
import type { ProviderAdapter } from "../../src/providers/types.js";
import type { ProviderObservedFacts } from "../../src/types/schema.js";

const TEST_TREASURY_ADDRESS = "0xc132a315a05541a4b72c272de539eb86de977fb9";

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

const mockFacts: ProviderObservedFacts = {
  provider: "lambda_labs",
  instance_type: "gpu_8x_h100_sxm5",
  region: "us-east-1",
  base_hourly_rate_usd: 25,
  specs: {
    gpu_model: "H100 80GB",
    gpu_count: 8,
    gpu_memory_gb: 80,
    interconnect: "InfiniBand",
    vcpus: 200,
    ram_gb: 1600,
    local_storage_gb: 20000,
  },
  capacity_type: "on_demand",
  observed_at: new Date().toISOString(),
};

const db = createDatabase(":memory:");
const apiKeyStore = new ApiKeyStore(db);
const creditLedger = new CreditLedger(db);
const challengeStore = new ChallengeStore(db, TEST_TREASURY_ADDRESS);
const processedEvents = new ProcessedEventStore(db);
const chainReader = new FakeChainReader();
const { rawKey: API_KEY } = apiKeyStore.create("no-live-fetch-test-account");
creditLedger.topUp("no-live-fetch-test-account", 1000);

/**
 * CLAUDE.md §4 Background Ingestion Rule, proven behaviorally rather
 * than just structurally (router.ts only ever accepting a
 * CachedProviderState[] makes a live call impossible to reach from the
 * route handler by construction — this test confirms that's actually
 * true at runtime, not just true by the type signature).
 */
describe("Background Ingestion Rule — the route handler never fetches live", () => {
  it("adapter.fetch() is called exactly once per ingestAll() run, and zero times across N route requests", async () => {
    const fetchSpy = vi.fn(async () => ({
      provider: "lambda_labs" as const,
      facts: [mockFacts],
      rejected: [],
      fetchedAt: new Date().toISOString(),
    }));
    const spyAdapter: ProviderAdapter = { id: "lambda_labs", fetch: fetchSpy };

    const cache = new IngestionCache([spyAdapter], 300);
    await cache.ingestAll();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    app = Fastify({ logger: false });
    registerQuoteRoute(app, {
      cache,
      apiKeyStore,
      creditLedger,
      challengeStore,
      processedEvents,
      chainReader,
      treasuryAddress: TEST_TREASURY_ADDRESS,
      quoteTtlSeconds: 300,
    });

    // 5 real HTTP requests through the actual route handler.
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/v1/route/quote",
        headers: { authorization: `Bearer ${API_KEY}` },
        payload: {},
      });
      expect(res.statusCode).toBe(200);
    }

    // Still exactly 1 — five paid requests, zero additional fetches.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("a second explicit ingestAll() call refreshes the cache, and is the ONLY thing that calls fetch again", async () => {
    const fetchSpy = vi.fn(async () => ({
      provider: "lambda_labs" as const,
      facts: [mockFacts],
      rejected: [],
      fetchedAt: new Date().toISOString(),
    }));
    const spyAdapter: ProviderAdapter = { id: "lambda_labs", fetch: fetchSpy };
    const cache = new IngestionCache([spyAdapter], 300);

    await cache.ingestAll();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    app = Fastify({ logger: false });
    registerQuoteRoute(app, {
      cache,
      apiKeyStore,
      creditLedger,
      challengeStore,
      processedEvents,
      chainReader,
      treasuryAddress: TEST_TREASURY_ADDRESS,
      quoteTtlSeconds: 300,
    });
    await app.inject({ method: "POST", url: "/v1/route/quote", headers: { authorization: `Bearer ${API_KEY}` }, payload: {} });
    expect(fetchSpy).toHaveBeenCalledTimes(1); // request added nothing

    await cache.ingestAll(); // simulates the background interval firing
    expect(fetchSpy).toHaveBeenCalledTimes(2); // only the explicit refresh did
  });
});
