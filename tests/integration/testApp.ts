import Fastify, { type FastifyInstance } from "fastify";
import { IngestionCache } from "../../src/ingestion/cache.js";
import { PROVIDER_ADAPTERS } from "../../src/providers/registry.js";
import { registerQuoteRoute } from "../../src/api/routes/quote.js";

const TEST_API_KEY = "test_key_123";

export async function buildTestApp(): Promise<{ app: FastifyInstance; cache: IngestionCache; apiKey: string }> {
  const app = Fastify({ logger: false });
  const cache = new IngestionCache(PROVIDER_ADAPTERS);
  await cache.ingestAll();

  registerQuoteRoute(app, {
    cache,
    validApiKeys: new Set([TEST_API_KEY]),
    quoteTtlSeconds: 300,
  });

  return { app, cache, apiKey: TEST_API_KEY };
}
