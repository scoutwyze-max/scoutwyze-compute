import "dotenv/config";
import Fastify from "fastify";
import { ethers } from "ethers";
import { IngestionCache } from "./ingestion/cache.js";
import { PROVIDER_ADAPTERS } from "./providers/registry.js";
import { createRunpodAdapter, RunpodLiveCatalogSource } from "./providers/runpod.js";
import { IngestionWorker } from "./ingestion/worker.js";
import { registerQuoteRoute } from "./api/routes/quote.js";
import { registerRankRoute } from "./api/routes/rank.js";
import { registerBookRoute } from "./api/routes/book.js";
import { registerSampleRoute } from "./api/routes/sample.js";
import { registerDiscoveryRoutes } from "./api/routes/discovery.js";
// LambdaLabsBooker/SimulatedLambdaLabsBooker deliberately NOT imported
// here — production is RunPod-only (Robert, 2026-09-22: Lambda's
// account-side auth issue was never resolved and isn't worth more
// time). The Lambda classes still exist in vendorBooker.ts, unused
// and uncalled, not deleted.
import { RunPodBooker, type VendorBooker } from "./engine/vendorBooker.js";
import { registerAdminRoutes } from "./api/routes/admin.js";
import { registerStripeWebhookRoute } from "./api/routes/stripeWebhook.js";
import { registerSignupRoute } from "./api/routes/signup.js";
import { registerPublicSignupPage } from "./api/routes/publicPage.js";
import { createDatabase } from "./db/connection.js";
import { ApiKeyStore } from "./billing/apiKeyStore.js";
import { CreditLedger } from "./billing/creditLedger.js";
import { ChallengeStore } from "./api/middleware/x402.js";
import { ProcessedEventStore } from "./payments/processedEvents.js";
import { PayAiFacilitatorClient } from "./payments/payAiFacilitator.js";
import { BASE_USDC_CONTRACT_ADDRESS } from "./payments/baseVerification.js";
import { StripeCheckoutSessionCreator } from "./payments/stripeCheckout.js";
import { RequestLogStore } from "./admin/requestLog.js";
import { AgentLogStore } from "./admin/agentLog.js";
import { OutreachRunner } from "./admin/outreachRunner.js";
import { registerAdminConsoleRoutes } from "./api/routes/adminConsole.js";
import { registerAdminConsolePage } from "./api/routes/adminConsolePage.js";
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
// `||`, not `??` — a .env line present but left blank (CHECKOUT_SUCCESS_URL=)
// parses to an empty string, not undefined, so `??` would silently skip
// the fallback and hand Stripe an empty success_url (a real 400 from
// Stripe's own API, caught live while verifying this exact config).
const CHECKOUT_SUCCESS_URL = process.env.CHECKOUT_SUCCESS_URL || "https://example.com/checkout/success";
const CHECKOUT_CANCEL_URL = process.env.CHECKOUT_CANCEL_URL || "https://example.com/checkout/cancel";
// Real RunPod dispatch when set — no simulated fallback for RunPod
// specifically (unlike Lambda): if RUNPOD_API_KEY is configured,
// RunPod bookings go through the real RunPodBooker or not at all;
// there's no "no key" state where RunPod is a supported provider.
const RUNPOD_API_KEY = process.env.RUNPOD_API_KEY;
// Real product decisions with no answer elsewhere in this codebase —
// documented defaults, not considered business choices.
const RUNPOD_IMAGE = process.env.RUNPOD_IMAGE || "runpod/pytorch:2.1.0-py3.10-cuda11.8.0-devel";
const RUNPOD_DISK_GB = Number(process.env.RUNPOD_DISK_GB ?? 50);
// Used in landing-page/llms.txt curl examples only — never used for
// anything security-sensitive (no redirect, no CORS origin check).
const BASE_URL = process.env.BASE_URL || "https://scoutwyze-compute.fly.dev";
// Real gap closed 2026-09-23 (Robert: "If /book is not end-to-end
// tested this week: omit book from landing, llms.txt, and OpenAPI.
// Leave the route deployed but unpublished."). As of this deploy, the
// only live RunPod book attempt got vendor_declined (real capacity
// response, not a bug — see vendorBooker.ts) — never a real ok:true
// accept. /v1/route/book stays fully functional and deployed either
// way; this only controls whether it's ADVERTISED. Flip to true the
// day a real booking actually succeeds end to end.
const BOOK_IS_PUBLISHED = false;

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
  const requestLog = new RequestLogStore(db);
  const agentLog = new AgentLogStore(db);
  const outreachRunner = new OutreachRunner(agentLog);

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
  const challengeStore = new ChallengeStore(BASE_TREASURY_ADDRESS, BASE_USDC_CONTRACT_ADDRESS);
  // Settlement facilitator (2026-09-26) — PayAI, genuinely
  // permissionless for our volume (no API key, no KYB; see
  // SOT.md's Registry syndication section for the verification behind
  // this). Broadcasts transferWithAuthorization only; this server
  // still verifies signature/bounds itself and independently
  // re-checks the settled transaction on-chain (see auth.ts).
  const facilitator = new PayAiFacilitatorClient();

  // Real gap closed 2026-09-23 (Robert: "live" isn't allowed in public
  // copy until rank actually sources RunPod from RunPod's own live
  // catalog, not the fixture) — registry.ts/PROVIDER_ADAPTERS stays
  // fixture-only for lambda_labs/coreweave (deliberate, they're
  // comparison-only, never bookable) AND for runpod's own default
  // export (tests must never depend on RUNPOD_API_KEY being set or
  // absent — see runpodAdapter's own doc comment). Only here, in the
  // real running app, does runpod's adapter swap to a live source.
  const runpodApiKey = RUNPOD_API_KEY;
  const runpodIsLive = !!runpodApiKey;
  const adapters = runpodApiKey
    ? PROVIDER_ADAPTERS.map((a) => (a.id === "runpod" ? createRunpodAdapter(new RunpodLiveCatalogSource(runpodApiKey), "live_api") : a))
    : PROVIDER_ADAPTERS;
  const cache = new IngestionCache(adapters, CACHE_TTL_SECONDS);
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
    facilitator,
    treasuryAddress: BASE_TREASURY_ADDRESS,
    quoteTtlSeconds: QUOTE_TTL_SECONDS,
    routePriceUsdc: ROUTE_PRICE_USDC,
  });
  // Production is RunPod-only (Robert, 2026-09-22): lambda_labs is
  // deliberately never registered here, regardless of any leftover
  // LAMBDA_API_KEY — its account-side auth issue was never resolved
  // and isn't worth more time. bookableProviders (below) is derived
  // from this SAME array, so rank and book can never recommend/dispatch
  // to a provider that isn't actually registered here.
  const bookers: VendorBooker[] = [];
  if (RUNPOD_API_KEY) {
    logger.info("RunPod dispatch: REAL (RUNPOD_API_KEY configured)");
    bookers.push(new RunPodBooker(RUNPOD_API_KEY, RUNPOD_IMAGE, RUNPOD_DISK_GB));
  } else {
    logger.warn("RUNPOD_API_KEY not set — rank/book have zero bookable providers until it's configured.");
  }
  const bookableProviders = bookers.map((b) => b.providerId);

  registerRankRoute(app, {
    cache,
    apiKeyStore,
    creditLedger,
    requestLog,
    challengeStore,
    processedEvents,
    chainReader,
    facilitator,
    treasuryAddress: BASE_TREASURY_ADDRESS,
    routePriceUsdc: ROUTE_PRICE_USDC,
    bookableProviders,
  });
  registerBookRoute(app, { cache, apiKeyStore, creditLedger, bookers });
  registerSampleRoute(app, { cache, bookableProviders, requestLog });
  registerDiscoveryRoutes(app, { baseUrl: BASE_URL, runpodIsLive, bookIsPublished: BOOK_IS_PUBLISHED });

  if (!ADMIN_SECRET) {
    logger.warn("ADMIN_SECRET not set — using an insecure dev-only default. Set a real secret before any real deployment.");
  }
  // Resolved once, shared by the operational admin API (X-Admin-Secret
  // header, curl-friendly) and the admin console (session-gated, see
  // admin/session.ts's own doc comment for why it's a separate cookie-
  // based layer rather than reusing the header directly).
  const adminSecret = ADMIN_SECRET || "dev-only-insecure-admin-secret";
  registerAdminRoutes(app, { apiKeyStore, creditLedger, adminSecret });
  registerAdminConsoleRoutes(app, { apiKeyStore, creditLedger, processedEvents, requestLog, agentLog, outreachRunner, adminSecret });
  registerAdminConsolePage(app, { adminSecret });

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
  } else if (!/^sk_(live|test)_[A-Za-z0-9]+$/.test(STRIPE_SECRET_KEY)) {
    // Real bug caught live, 2026-09-22: the Fly secret had a single
    // stray non-ASCII character prepended (a smart-quote from an
    // earlier text-editor paste) — 108 chars instead of 107, invisible
    // in `fly secrets list` (digest only). Every checkout attempt threw
    // a cryptic browser-side "Cannot convert argument to a ByteString"
    // error instead of anything pointing at the real cause, because
    // Node's fetch enforces ASCII headers on the OUTGOING call to
    // Stripe and the route handler forwards that raw error to the
    // client. This check turns that into a loud, specific startup
    // warning instead of a per-request mystery.
    logger.warn("STRIPE_SECRET_KEY is set but doesn't match the expected sk_live_/sk_test_ format — checkout session creation will fail. Check for a stray character (e.g. a smart-quote from a text editor paste) and re-set it via `fly secrets set`.");
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
  registerPublicSignupPage(app, { baseUrl: BASE_URL, runpodIsLive, bookIsPublished: BOOK_IS_PUBLISHED });

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
