import Fastify, { type FastifyInstance } from "fastify";
import { IngestionCache } from "../../src/ingestion/cache.js";
import { PROVIDER_ADAPTERS } from "../../src/providers/registry.js";
import { registerQuoteRoute } from "../../src/api/routes/quote.js";
import { registerAdminRoutes } from "../../src/api/routes/admin.js";
import { ApiKeyStore } from "../../src/billing/apiKeyStore.js";
import { CreditLedger } from "../../src/billing/creditLedger.js";

const TEST_CACHE_TTL_SECONDS = 300; // generous — tests here aren't exercising TTL behavior itself
const TEST_ACCOUNT_ID = "test-account";
const TEST_STARTING_BALANCE_USD = 1000; // generous — most tests aren't exercising billing exhaustion itself
export const TEST_ADMIN_SECRET = "test-admin-secret";

export interface TestApp {
  app: FastifyInstance;
  cache: IngestionCache;
  apiKey: string;
  accountId: string;
  apiKeyStore: ApiKeyStore;
  creditLedger: CreditLedger;
  adminSecret: string;
}

export async function buildTestApp(): Promise<TestApp> {
  const app = Fastify({ logger: false });
  const cache = new IngestionCache(PROVIDER_ADAPTERS, TEST_CACHE_TTL_SECONDS);
  await cache.ingestAll();

  const apiKeyStore = new ApiKeyStore();
  const creditLedger = new CreditLedger();
  const { rawKey } = apiKeyStore.create(TEST_ACCOUNT_ID);
  creditLedger.topUp(TEST_ACCOUNT_ID, TEST_STARTING_BALANCE_USD);

  registerQuoteRoute(app, { cache, apiKeyStore, creditLedger, quoteTtlSeconds: 300 });
  registerAdminRoutes(app, { apiKeyStore, creditLedger, adminSecret: TEST_ADMIN_SECRET });

  return { app, cache, apiKey: rawKey, accountId: TEST_ACCOUNT_ID, apiKeyStore, creditLedger, adminSecret: TEST_ADMIN_SECRET };
}
