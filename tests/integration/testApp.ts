import Fastify, { type FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { IngestionCache } from "../../src/ingestion/cache.js";
import { PROVIDER_ADAPTERS } from "../../src/providers/registry.js";
import { registerQuoteRoute } from "../../src/api/routes/quote.js";
import { registerAdminRoutes } from "../../src/api/routes/admin.js";
import { registerStripeWebhookRoute } from "../../src/api/routes/stripeWebhook.js";
import { registerSignupRoute } from "../../src/api/routes/signup.js";
import { registerPublicSignupPage } from "../../src/api/routes/publicPage.js";
import { registerRankRoute } from "../../src/api/routes/rank.js";
import { registerBookRoute } from "../../src/api/routes/book.js";
import { registerSampleRoute } from "../../src/api/routes/sample.js";
import { registerDiscoveryRoutes } from "../../src/api/routes/discovery.js";
import { createDatabase } from "../../src/db/connection.js";
import { ApiKeyStore } from "../../src/billing/apiKeyStore.js";
import { CreditLedger } from "../../src/billing/creditLedger.js";
import { ChallengeStore } from "../../src/api/middleware/x402.js";
import { ProcessedEventStore } from "../../src/payments/processedEvents.js";
import { RequestLogStore } from "../../src/admin/requestLog.js";
import { AgentLogStore } from "../../src/admin/agentLog.js";
import { OutreachRunner } from "../../src/admin/outreachRunner.js";
import { registerAdminConsoleRoutes } from "../../src/api/routes/adminConsole.js";
import { registerAdminConsolePage } from "../../src/api/routes/adminConsolePage.js";
import { FakeChainReader } from "../helpers/fakeChainReader.js";
import { FakeFacilitatorClient } from "../helpers/fakeFacilitator.js";
import { FakeCheckoutSessionCreator } from "../helpers/fakeCheckoutSessionCreator.js";
import { FakeVendorBooker } from "../helpers/fakeVendorBooker.js";
import { BASE_USDC_CONTRACT_ADDRESS } from "../../src/payments/baseVerification.js";
import type { ProviderId } from "../../src/types/schema.js";

const TEST_CACHE_TTL_SECONDS = 300; // generous — tests here aren't exercising TTL behavior itself
const TEST_ACCOUNT_ID = "test-account";
const TEST_STARTING_BALANCE_USD = 1000; // generous — most tests aren't exercising billing exhaustion itself
export const TEST_ADMIN_SECRET = "test-admin-secret";
export const TEST_STRIPE_WEBHOOK_SECRET = "test-stripe-webhook-secret";
export const TEST_TREASURY_ADDRESS = "0xc132a315a05541a4b72c272de539eb86de977fb9";
export const TEST_PUBLIC_BASE_URL = "https://test.scoutwyze.example";

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
  facilitator: FakeFacilitatorClient;
  treasuryAddress: string;
  adminSecret: string;
  stripeWebhookSecret: string;
  checkoutSessionCreator: FakeCheckoutSessionCreator;
  lambdaLabsBooker: FakeVendorBooker;
  runpodBooker: FakeVendorBooker;
  requestLog: RequestLogStore;
  agentLog: AgentLogStore;
}

export interface BuildTestAppOptions {
  // Defaults to ["runpod"] — mirrors index.ts's real production
  // wiring (RunPod-only, 2026-09-22: Lambda is left in the repo but
  // never registered as a booker). Tests that specifically want to
  // exercise the generic multi-booker dispatch mechanism itself (not
  // the production policy) can opt in with e.g. ["lambda_labs", "runpod"].
  bookableProviders?: ProviderId[];
  // Defaults to false — mirrors index.ts's BOOK_IS_PUBLISHED default
  // (no successful live RunPod booking yet, 2026-09-23).
  bookIsPublished?: boolean;
}

export async function buildTestApp(options: BuildTestAppOptions = {}): Promise<TestApp> {
  const app = Fastify({ logger: false });
  const cache = new IngestionCache(PROVIDER_ADAPTERS, TEST_CACHE_TTL_SECONDS);
  await cache.ingestAll();

  // Fresh, isolated in-memory database per test — no cross-test bleed,
  // no leftover file on disk, no need to reset shared state between
  // runs.
  const db = createDatabase(":memory:");
  const apiKeyStore = new ApiKeyStore(db);
  const creditLedger = new CreditLedger(db);
  const challengeStore = new ChallengeStore(TEST_TREASURY_ADDRESS, BASE_USDC_CONTRACT_ADDRESS);
  const processedEvents = new ProcessedEventStore(db);
  const requestLog = new RequestLogStore(db);
  const agentLog = new AgentLogStore(db);
  // Fake script, no real GitHub API calls from the test suite — see
  // outreachRunner.ts's own doc comment on why this is injectable.
  const fakeOutreachScript = join(dirname(fileURLToPath(import.meta.url)), "..", "helpers", "fakeOutreachScript.mjs");
  const outreachRunner = new OutreachRunner(agentLog, fakeOutreachScript, []);
  const chainReader = new FakeChainReader(); // no real network, ever, in tests
  const facilitator = new FakeFacilitatorClient(chainReader); // no real call to PayAI, ever, in tests
  const { rawKey } = apiKeyStore.create(TEST_ACCOUNT_ID);
  creditLedger.topUp(TEST_ACCOUNT_ID, TEST_STARTING_BALANCE_USD);

  registerQuoteRoute(app, {
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
  registerAdminRoutes(app, { apiKeyStore, creditLedger, adminSecret: TEST_ADMIN_SECRET });
  registerStripeWebhookRoute(app, { db, creditLedger, webhookSecret: TEST_STRIPE_WEBHOOK_SECRET });
  const checkoutSessionCreator = new FakeCheckoutSessionCreator();
  registerSignupRoute(app, {
    apiKeyStore,
    checkoutSessionCreator,
    checkoutSuccessUrl: "https://example.com/success",
    checkoutCancelUrl: "https://example.com/cancel",
  });
  const lambdaLabsBooker = new FakeVendorBooker("lambda_labs");
  const runpodBooker = new FakeVendorBooker("runpod");
  const fakeBookersByProvider: Record<string, FakeVendorBooker> = { lambda_labs: lambdaLabsBooker, runpod: runpodBooker };
  const bookableProviders = options.bookableProviders ?? ["runpod"];
  const bookers = bookableProviders.map((id) => fakeBookersByProvider[id]!);
  const bookIsPublished = options.bookIsPublished ?? false;

  registerPublicSignupPage(app, { baseUrl: "https://example.com", runpodIsLive: false, bookIsPublished });
  registerRankRoute(app, {
    cache,
    apiKeyStore,
    creditLedger,
    requestLog,
    challengeStore,
    processedEvents,
    chainReader,
    facilitator,
    treasuryAddress: TEST_TREASURY_ADDRESS,
    routePriceUsdc: 0.15,
    bookableProviders,
    publicBaseUrl: TEST_PUBLIC_BASE_URL,
  });
  registerBookRoute(app, { cache, apiKeyStore, creditLedger, bookers });
  registerSampleRoute(app, { cache, bookableProviders, requestLog });
  registerDiscoveryRoutes(app, { baseUrl: "https://example.com", runpodIsLive: false, bookIsPublished });
  registerAdminConsoleRoutes(app, { apiKeyStore, creditLedger, processedEvents, requestLog, agentLog, outreachRunner, adminSecret: TEST_ADMIN_SECRET });
  registerAdminConsolePage(app, { adminSecret: TEST_ADMIN_SECRET });

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
    facilitator,
    treasuryAddress: TEST_TREASURY_ADDRESS,
    adminSecret: TEST_ADMIN_SECRET,
    stripeWebhookSecret: TEST_STRIPE_WEBHOOK_SECRET,
    checkoutSessionCreator,
    lambdaLabsBooker,
    runpodBooker,
    requestLog,
    agentLog,
  };
}
