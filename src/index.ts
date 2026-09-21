import "dotenv/config";
import Fastify from "fastify";
import { ethers } from "ethers";
import { createIngestionCache } from "./ingestion/ingest.js";
import { IngestionWorker } from "./ingestion/worker.js";
import { registerQuoteRoute } from "./api/routes/quote.js";
import { registerAdminRoutes } from "./api/routes/admin.js";
import { registerStripeWebhookRoute } from "./api/routes/stripeWebhook.js";
import { registerSignupRoute } from "./api/routes/signup.js";
import { createDatabase } from "./db/connection.js";
import { ApiKeyStore } from "./billing/apiKeyStore.js";
import { CreditLedger } from "./billing/creditLedger.js";
import { ChallengeStore } from "./api/middleware/x402.js";
import { ProcessedEventStore } from "./payments/processedEvents.js";
import { StripeCheckoutSessionCreator } from "./payments/stripeCheckout.js";
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
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
// Real treasury wallet on Base — Robert, 2026-09-21. Real funds settle
// here; there is no dev-only fallback for this one (see the startup
// check below).
const BASE_TREASURY_ADDRESS = process.env.BASE_TREASURY_ADDRESS ?? "0xc132a315a05541a4b72c272de539eb86de977fb9";
const BASE_RPC_URL = process.env.BASE_RPC_URL ?? "https://mainnet.base.org";
// Customer-facing signup/checkout (src/api/routes/signup.ts). No dev-
// only fallback for the secret key, same reasoning as
// STRIPE_WEBHOOK_SECRET — an empty/wrong key just makes every checkout
// session creation fail loudly (502), never silently. Success/cancel
// URLs have no real default either — there's no actual page at either
// URL yet (that's front-end work outside this repo), so an unset env
// var falls back to an obvious placeholder rather than a guessed real
// scoutwyze.com path, and logs a warning below so it's not silently wrong.
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY ?? "";
const CHECKOUT_SUCCESS_URL = process.env.CHECKOUT_SUCCESS_URL ?? "https://example.com/checkout/success";
const CHECKOUT_CANCEL_URL = process.env.CHECKOUT_CANCEL_URL ?? "https://example.com/checkout/cancel";

async function main() {
  const app = Fastify({ logger: false });

  // Durable storage (src/db/connection.ts) — API keys, credit ledger,
  // x402 challenge nonces, and processed-payment-event idempotency all
  // survive a restart now. The ingestion cache deliberately does NOT
  // persist here (see ingest.ts's own reasoning) — it's rapidly-
  // refreshed, perishable-by-design provider data, not billing state.
  const db = createDatabase(DATABASE_PATH);
  const apiKeyStore = new ApiKeyStore(db);
  const creditLedger = new CreditLedger(db);
  const processedEvents = new ProcessedEventStore(db);

  // Real Base RPC connection — used only to READ transaction receipts
  // (verifying a real USDC transfer happened), never to send
  // transactions or hold keys. Public endpoint by default (free,
  // rate-limited, fine for V1); BASE_RPC_URL overrides it for a real
  // provider (Alchemy/Infura/etc.) later without any code change.
  const chainReader = new ethers.JsonRpcProvider(BASE_RPC_URL);
  try {
    ethers.getAddress(BASE_TREASURY_ADDRESS);
  } catch {
    logger.error("BASE_TREASURY_ADDRESS is not a valid address — x402 on-chain verification will reject every payment", { value: BASE_TREASURY_ADDRESS });
  }
  const challengeStore = new ChallengeStore(db, BASE_TREASURY_ADDRESS);

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
    processedEvents,
    chainReader,
    treasuryAddress: BASE_TREASURY_ADDRESS,
    quoteTtlSeconds: QUOTE_TTL_SECONDS,
    routePriceUsdc: ROUTE_PRICE_USDC,
  });

  if (!ADMIN_SECRET) {
    logger.warn("ADMIN_SECRET not set — using an insecure dev-only default. Set a real secret before any real deployment.");
  }
  registerAdminRoutes(app, { apiKeyStore, creditLedger, adminSecret: ADMIN_SECRET || "dev-only-insecure-admin-secret" });

  if (!STRIPE_WEBHOOK_SECRET) {
    // Deliberately no insecure fallback for this one, unlike
    // ADMIN_SECRET/X402_RECEIPT_SIGNING_SECRET — a wrong-but-present
    // secret just rejects every webhook (loud, safe); a missing one
    // defaulting to something guessable would mean anyone could forge
    // a "payment succeeded" webhook and mint themselves free credits.
    logger.warn("STRIPE_WEBHOOK_SECRET not set — /v1/webhooks/stripe will reject every request until it's configured.");
  }
  registerStripeWebhookRoute(app, { db, creditLedger, webhookSecret: STRIPE_WEBHOOK_SECRET ?? "" });

  if (!STRIPE_SECRET_KEY) {
    logger.warn("STRIPE_SECRET_KEY not set — /v1/checkout-sessions will fail every request with a 502 until it's configured.");
  }
  if (!process.env.CHECKOUT_SUCCESS_URL || !process.env.CHECKOUT_CANCEL_URL) {
    logger.warn("CHECKOUT_SUCCESS_URL/CHECKOUT_CANCEL_URL not set — using placeholder example.com URLs, real Checkout Sessions will redirect nowhere useful.");
  }
  registerSignupRoute(app, {
    apiKeyStore,
    checkoutSessionCreator: new StripeCheckoutSessionCreator(STRIPE_SECRET_KEY),
    checkoutSuccessUrl: CHECKOUT_SUCCESS_URL,
    checkoutCancelUrl: CHECKOUT_CANCEL_URL,
  });

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
