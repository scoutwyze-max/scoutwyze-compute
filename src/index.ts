import "dotenv/config";
import Fastify from "fastify";
import { createIngestionCache } from "./ingestion/ingest.js";
import { IngestionWorker } from "./ingestion/worker.js";
import { registerQuoteRoute } from "./api/routes/quote.js";
import { registerAdminRoutes } from "./api/routes/admin.js";
import { createDatabase } from "./db/connection.js";
import { ApiKeyStore } from "./billing/apiKeyStore.js";
import { CreditLedger } from "./billing/creditLedger.js";
import { ChallengeStore } from "./api/middleware/x402.js";
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
const ADMIN_SECRET = process.env.ADMIN_SECRET;
// Shared price for both auth rails — undefined lets createAuthMiddleware
// fall back to x402.ts's own DEFAULT_ROUTE_PRICE_USDC, keeping one
// source of truth for the default instead of duplicating it here.
const ROUTE_PRICE_USDC = process.env.ROUTE_PRICE_USDC ? Number(process.env.ROUTE_PRICE_USDC) : undefined;
const DATABASE_PATH = process.env.DATABASE_PATH ?? "./data/scoutwyze-compute.db";

async function main() {
  const app = Fastify({ logger: false });

  // Durable storage (src/db/connection.ts) — API keys, credit ledger,
  // and x402 challenge nonces all survive a restart now. The
  // ingestion cache deliberately does NOT persist here (see
  // ingest.ts's own reasoning) — it's rapidly-refreshed, perishable-
  // by-design provider data, not account/billing state.
  const db = createDatabase(DATABASE_PATH);
  const apiKeyStore = new ApiKeyStore(db);
  const creditLedger = new CreditLedger(db);
  const challengeStore = new ChallengeStore(db);

  const cache = createIngestionCache(CACHE_TTL_SECONDS);
  const worker = new IngestionWorker(cache, INGESTION_REFRESH_INTERVAL_SECONDS);

  // CLAUDE.md §4 — populate the cache once at boot BEFORE serving any
  // traffic, then keep it warm on an interval. The route handler never
  // triggers ingestion itself.
  await worker.start();

  registerQuoteRoute(app, {
    cache,
    apiKeyStore,
    creditLedger,
    challengeStore,
    quoteTtlSeconds: QUOTE_TTL_SECONDS,
    routePriceUsdc: ROUTE_PRICE_USDC,
  });

  if (!ADMIN_SECRET) {
    logger.warn("ADMIN_SECRET not set — using an insecure dev-only default. Set a real secret before any real deployment.");
  }
  registerAdminRoutes(app, { apiKeyStore, creditLedger, adminSecret: ADMIN_SECRET || "dev-only-insecure-admin-secret" });

  app.get("/healthz", async () => ({
    status: "ok",
    worker: { running: worker.isRunning(), completedCycles: worker.completedCycles },
    providers: cache.getStates().map((s) => ({ provider: s.provider, status: s.status, lastIngestedAt: s.lastIngestedAt })),
  }));

  app.addHook("onClose", async () => {
    worker.stop();
    db.close();
  });

  try {
    await app.listen({ port: PORT, host: "0.0.0.0" });
    logger.info(`ScoutWyze Compute listening on :${PORT}`, { database: DATABASE_PATH });
  } catch (err) {
    logger.error("Failed to start server", { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  }
}

main();
