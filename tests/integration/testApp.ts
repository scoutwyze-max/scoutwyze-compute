import Fastify, { type FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { IngestionCache } from "../../src/ingestion/cache.js";
import { PROVIDER_ADAPTERS } from "../../src/providers/registry.js";
import { registerQuoteRoute } from "../../src/api/routes/quote.js";
import { registerAdminRoutes } from "../../src/api/routes/admin.js";
import { createDatabase } from "../../src/db/connection.js";
import { ApiKeyStore } from "../../src/billing/apiKeyStore.js";
import { CreditLedger } from "../../src/billing/creditLedger.js";
import { ChallengeStore } from "../../src/api/middleware/x402.js";

const TEST_CACHE_TTL_SECONDS = 300; // generous — tests here aren't exercising TTL behavior itself
const TEST_ACCOUNT_ID = "test-account";
const TEST_STARTING_BALANCE_USD = 1000; // generous — most tests aren't exercising billing exhaustion itself
export const TEST_ADMIN_SECRET = "test-admin-secret";

export interface TestApp {
  app: FastifyInstance;
  cache: IngestionCache;
  db: Database.Database;
  apiKey: string;
  accountId: string;
  apiKeyStore: ApiKeyStore;
  creditLedger: CreditLedger;
  challengeStore: ChallengeStore;
  adminSecret: string;
}

export async function buildTestApp(): Promise<TestApp> {
  const app = Fastify({ logger: false });
  const cache = new IngestionCache(PROVIDER_ADAPTERS, TEST_CACHE_TTL_SECONDS);
  await cache.ingestAll();

  // Fresh, isolated in-memory database per test — no cross-test bleed,
  // no leftover file on disk, no need to reset shared state between
  // runs (requirement #4: real persistence layer under test, without
  // real test flakiness from a shared DB file).
  const db = createDatabase(":memory:");
  const apiKeyStore = new ApiKeyStore(db);
  const creditLedger = new CreditLedger(db);
  const challengeStore = new ChallengeStore(db);
  const { rawKey } = apiKeyStore.create(TEST_ACCOUNT_ID);
  creditLedger.topUp(TEST_ACCOUNT_ID, TEST_STARTING_BALANCE_USD);

  registerQuoteRoute(app, { cache, apiKeyStore, creditLedger, challengeStore, quoteTtlSeconds: 300 });
  registerAdminRoutes(app, { apiKeyStore, creditLedger, adminSecret: TEST_ADMIN_SECRET });

  app.addHook("onClose", async () => {
    db.close();
  });

  return { app, cache, db, apiKey: rawKey, accountId: TEST_ACCOUNT_ID, apiKeyStore, creditLedger, challengeStore, adminSecret: TEST_ADMIN_SECRET };
}
