import { describe, expect, it, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { IngestionCache } from "../../src/ingestion/cache.js";
import { lambdaLabsAdapter } from "../../src/providers/lambdaLabs.js";
import { runpodAdapter } from "../../src/providers/runpod.js";
import { registerQuoteRoute } from "../../src/api/routes/quote.js";
import { createDatabase } from "../../src/db/connection.js";
import { ApiKeyStore } from "../../src/billing/apiKeyStore.js";
import { CreditLedger } from "../../src/billing/creditLedger.js";
import { ChallengeStore } from "../../src/api/middleware/x402.js";
import { ProcessedEventStore } from "../../src/payments/processedEvents.js";
import { BASE_USDC_CONTRACT_ADDRESS } from "../../src/payments/baseVerification.js";
import { FakeChainReader } from "../helpers/fakeChainReader.js";
import { FakeFacilitatorClient } from "../helpers/fakeFacilitator.js";
import type { ProviderAdapter } from "../../src/providers/types.js";

const TEST_TREASURY_ADDRESS = "0xc132a315a05541a4b72c272de539eb86de977fb9";
const TEST_PUBLIC_BASE_URL = "https://test.scoutwyze.example";

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

const brokenCoreweaveAdapter: ProviderAdapter = {
  id: "coreweave",
  async fetch() {
    throw new Error("simulated schema change / feed outage");
  },
};

// Shared across this file's tests — not exercising billing itself, just
// needs a real, funded key to get past auth so the fail-closed provider
// behavior underneath it can be tested.
const db = createDatabase(":memory:");
const apiKeyStore = new ApiKeyStore(db);
const creditLedger = new CreditLedger(db);
const challengeStore = new ChallengeStore(TEST_TREASURY_ADDRESS, BASE_USDC_CONTRACT_ADDRESS);
const processedEvents = new ProcessedEventStore(db);
const chainReader = new FakeChainReader();
const facilitator = new FakeFacilitatorClient(chainReader);
const { rawKey: API_KEY } = apiKeyStore.create("fail-closed-test-account");
creditLedger.topUp("fail-closed-test-account", 1000);

async function buildAppWithBrokenCoreweave(): Promise<FastifyInstance> {
  const built = Fastify({ logger: false });
  const cache = new IngestionCache([lambdaLabsAdapter, runpodAdapter, brokenCoreweaveAdapter], 300);
  await cache.ingestAll();
  registerQuoteRoute(built, {
    cache,
    apiKeyStore,
    creditLedger,
    challengeStore,
    processedEvents,
    chainReader,
    facilitator,
    treasuryAddress: TEST_TREASURY_ADDRESS,
    quoteTtlSeconds: 300,
    publicBaseUrl: TEST_PUBLIC_BASE_URL,
  });
  return built;
}

describe("CLAUDE.md §2 Fail-Closed Rule", () => {
  it("a broken provider feed is excluded and explicitly reported, never silently fabricated or skipped without a trace", async () => {
    app = await buildAppWithBrokenCoreweave();

    const res = await app.inject({
      method: "POST",
      url: "/v1/route/quote",
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();

    // coreweave contributes zero quotes...
    expect(body.quotes.some((q: any) => q.provider_observed.provider === "coreweave")).toBe(false);
    // ...and that absence is explained, not silent.
    const excluded = body.excluded_providers.find((e: any) => e.provider === "coreweave");
    expect(excluded).toBeDefined();
    expect(excluded.reason).toMatch(/simulated schema change/);
  });

  it("the other 2 providers' last-good data still serves normally — one broken feed does not take down the whole response", async () => {
    app = await buildAppWithBrokenCoreweave();

    const res = await app.inject({
      method: "POST",
      url: "/v1/route/quote",
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: {},
    });

    const body = res.json();
    const providers = new Set(body.quotes.map((q: any) => q.provider_observed.provider));
    expect(providers.has("lambda_labs")).toBe(true);
    expect(providers.has("runpod")).toBe(true);
  });

  it("a provider that has never successfully ingested contributes nothing rather than serving undefined/stale data", async () => {
    const cache = new IngestionCache([brokenCoreweaveAdapter], 300);
    // Deliberately not calling ingestAll() — this is the boot-time,
    // never-yet-ingested state.
    const states = cache.getStates();
    expect(states[0]?.status).toBe("failed");
    expect(states[0]?.facts).toHaveLength(0);
  });

  it("total outage (all 3 providers broken) still returns 200 with an honest empty result, not a crash or fabricated data", async () => {
    const brokenLambda: ProviderAdapter = { id: "lambda_labs", async fetch() { throw new Error("outage: lambda"); } };
    const brokenRunpod: ProviderAdapter = { id: "runpod", async fetch() { throw new Error("outage: runpod"); } };
    const brokenAll: ProviderAdapter = { id: "coreweave", async fetch() { throw new Error("outage: coreweave"); } };

    const built = Fastify({ logger: false });
    const cache = new IngestionCache([brokenLambda, brokenRunpod, brokenAll], 300);
    await cache.ingestAll();
    registerQuoteRoute(built, {
      cache,
      apiKeyStore,
      creditLedger,
      challengeStore,
      processedEvents,
      chainReader,
      facilitator,
      treasuryAddress: TEST_TREASURY_ADDRESS,
      quoteTtlSeconds: 300,
      publicBaseUrl: TEST_PUBLIC_BASE_URL,
    });
    app = built;

    const res = await app.inject({
      method: "POST",
      url: "/v1/route/quote",
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.quotes).toEqual([]);
    expect(body.confidence).toBe(0);
    expect(body.excluded_providers).toHaveLength(3);
    expect(new Set(body.excluded_providers.map((e: any) => e.provider))).toEqual(
      new Set(["lambda_labs", "runpod", "coreweave"]),
    );
  });
});
