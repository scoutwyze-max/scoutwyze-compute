import Fastify, { type FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { IngestionCache } from "../../src/ingestion/cache.js";
import { PROVIDER_ADAPTERS } from "../../src/providers/registry.js";
import { registerQuoteRoute } from "../../src/api/routes/quote.js";
import { registerAdminRoutes } from "../../src/api/routes/admin.js";
import { registerStripeWebhookRoute } from "../../src/api/routes/stripeWebhook.js";
import { registerSignupRoute } from "../../src/api/routes/signup.js";
import { registerPublicSignupPage } from "../../src/api/routes/publicPage.js";
import { registerRankRoute } from "../../src/api/routes/rank.js";
import { createDatabase } from "../../src/db/connection.js";
import { ApiKeyStore } from "../../src/billing/apiKeyStore.js";
import { CreditLedger } from "../../src/billing/creditLedger.js";
import { ChallengeStore } from "../../src/api/middleware/x402.js";
import { ProcessedEventStore } from "../../src/payments/processedEvents.js";
import { FakeChainReader } from "../helpers/fakeChainReader.js";
import { FakeCheckoutSessionCreator } from "../helpers/fakeCheckoutSessionCreator.js";

const TEST_CACHE_TTL_SECONDS = 300; // generous — tests here aren't exercising TTL behavior itself
const TEST_ACCOUNT_ID = "test-account";
const TEST_STARTING_BALANCE_USD = 1000; // generous — most tests aren't exercising billing exhaustion itself
export const TEST_ADMIN_SECRET = "test-admin-secret";
export const TEST_STRIPE_WEBHOOK_SECRET = "test-stripe-webhook-secret";
export const TEST_TREASURY_ADDRESS = "0xc132a315a05541a4b72c272de539eb86de977fb9";

export interface TestApp {
  app: FastifyInstance;
  cache: IngestionCache;
  db: Database.Database;
  apiKey: string;
  accountId: string;
  apiKeyStore: ApiKeyStore;
  creditLedger: CreditLedger;
  challengeStore: ChallengeStore;
  processedEvents: ProcessedEventStore;
  chainReader: FakeChainReader;
  treasuryAddress: string;
  adminSecret: string;
  stripeWebhookSecret: string;
  checkoutSessionCreator: FakeCheckoutSessionCreator;
}

export async function buildTestApp(): Promise<TestApp> {
  const app = Fastify({ logger: false });
  const cache = new IngestionCache(PROVIDER_ADAPTERS, TEST_CACHE_TTL_SECONDS);
  await cache.ingestAll();

  // Fresh, isolated in-memory database per test — no cross-test bleed,
  // no leftover file on disk, no need to reset shared state between
  // runs.
  const db = createDatabase(":memory:");
  const apiKeyStore = new ApiKeyStore(db);
  const creditLedger = new CreditLedger(db);
  const challengeStore = new ChallengeStore(db, TEST_TREASURY_ADDRESS);
  const processedEvents = new ProcessedEventStore(db);
  const chainReader = new FakeChainReader(); // no real network, ever, in tests
  const { rawKey } = apiKeyStore.create(TEST_ACCOUNT_ID);
  creditLedger.topUp(TEST_ACCOUNT_ID, TEST_STARTING_BALANCE_USD);

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
  registerAdminRoutes(app, { apiKeyStore, creditLedger, adminSecret: TEST_ADMIN_SECRET });
  registerStripeWebhookRoute(app, { db, creditLedger, webhookSecret: TEST_STRIPE_WEBHOOK_SECRET });
  const checkoutSessionCreator = new FakeCheckoutSessionCreator();
  registerSignupRoute(app, {
    apiKeyStore,
    checkoutSessionCreator,
    checkoutSuccessUrl: "https://example.com/success",
    checkoutCancelUrl: "https://example.com/cancel",
  });
  registerPublicSignupPage(app);
  registerRankRoute(app, { cache, apiKeyStore, creditLedger, routePriceUsdc: 0.15 });

  app.addHook("onClose", async () => {
    db.close();
  });

  return {
    app,
    cache,
    db,
    apiKey: rawKey,
    accountId: TEST_ACCOUNT_ID,
    apiKeyStore,
    creditLedger,
    challengeStore,
    processedEvents,
    chainReader,
    treasuryAddress: TEST_TREASURY_ADDRESS,
    adminSecret: TEST_ADMIN_SECRET,
    stripeWebhookSecret: TEST_STRIPE_WEBHOOK_SECRET,
    checkoutSessionCreator,
  };
}
