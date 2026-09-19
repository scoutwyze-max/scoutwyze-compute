import "dotenv/config";
import Fastify from "fastify";
import { createIngestionCache, startBackgroundIngestion } from "./ingestion/ingest.js";
import { registerQuoteRoute } from "./api/routes/quote.js";
import { logger } from "./utils/logger.js";

const PORT = Number(process.env.PORT ?? 8787);
const INGESTION_REFRESH_INTERVAL_SECONDS = Number(process.env.INGESTION_REFRESH_INTERVAL_SECONDS ?? 60);
const QUOTE_TTL_SECONDS = Number(process.env.QUOTE_TTL_SECONDS ?? 300);
const VALID_API_KEYS = new Set(
  (process.env.SCOUTWYZE_API_KEYS ?? "").split(",").map((k) => k.trim()).filter(Boolean),
);

async function main() {
  const app = Fastify({ logger: false });
  const cache = createIngestionCache();

  // CLAUDE.md §4 — populate the cache once at boot BEFORE serving any
  // traffic, then keep it warm on an interval. The route handler never
  // triggers ingestion itself.
  await cache.ingestAll();
  const ingestionLoop = startBackgroundIngestion(cache, INGESTION_REFRESH_INTERVAL_SECONDS);

  registerQuoteRoute(app, { cache, validApiKeys: VALID_API_KEYS, quoteTtlSeconds: QUOTE_TTL_SECONDS });

  app.get("/healthz", async () => ({
    status: "ok",
    providers: cache.getStates().map((s) => ({ provider: s.provider, status: s.status, lastIngestedAt: s.lastIngestedAt })),
  }));

  app.addHook("onClose", async () => {
    ingestionLoop.stop();
  });

  try {
    await app.listen({ port: PORT, host: "0.0.0.0" });
    logger.info(`ScoutWyze Compute listening on :${PORT}`);
  } catch (err) {
    logger.error("Failed to start server", { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  }
}

main();
