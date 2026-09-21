import "dotenv/config";
import Fastify from "fastify";
import { createIngestionCache } from "./ingestion/ingest.js";
import { IngestionWorker } from "./ingestion/worker.js";
import { registerQuoteRoute } from "./api/routes/quote.js";
import { logger } from "./utils/logger.js";

const PORT = Number(process.env.PORT ?? 8787);
const INGESTION_REFRESH_INTERVAL_SECONDS = Number(process.env.INGESTION_REFRESH_INTERVAL_SECONDS ?? 60);
const QUOTE_TTL_SECONDS = Number(process.env.QUOTE_TTL_SECONDS ?? 300);
// Strict cache-entry TTL (CLAUDE.md §2/§3) — separate from the two
// above. INGESTION_REFRESH_INTERVAL_SECONDS is how often the worker
// TRIES to refresh; QUOTE_TTL_SECONDS is how long a SERVED response
// claims to be valid; CACHE_TTL_SECONDS is how long cached provider
// data is trusted at all before the cache itself refuses to serve it,
// regardless of the other two. Defaults to 3x the refresh interval —
// enough slack for one or two missed/slow cycles without instantly
// going stale, while still bounding worst-case staleness if the worker
// dies silently.
const CACHE_TTL_SECONDS = Number(process.env.CACHE_TTL_SECONDS ?? INGESTION_REFRESH_INTERVAL_SECONDS * 3);
const VALID_API_KEYS = new Set(
  (process.env.SCOUTWYZE_API_KEYS ?? "").split(",").map((k) => k.trim()).filter(Boolean),
);

async function main() {
  const app = Fastify({ logger: false });
  const cache = createIngestionCache(CACHE_TTL_SECONDS);
  const worker = new IngestionWorker(cache, INGESTION_REFRESH_INTERVAL_SECONDS);

  // CLAUDE.md §4 — populate the cache once at boot BEFORE serving any
  // traffic, then keep it warm on an interval. The route handler never
  // triggers ingestion itself.
  await worker.start();

  registerQuoteRoute(app, { cache, validApiKeys: VALID_API_KEYS, quoteTtlSeconds: QUOTE_TTL_SECONDS });

  app.get("/healthz", async () => ({
    status: "ok",
    worker: { running: worker.isRunning(), completedCycles: worker.completedCycles },
    providers: cache.getStates().map((s) => ({ provider: s.provider, status: s.status, lastIngestedAt: s.lastIngestedAt })),
  }));

  app.addHook("onClose", async () => {
    worker.stop();
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
