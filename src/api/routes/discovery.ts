import type { FastifyInstance } from "fastify";

export interface DiscoveryRouteDeps {
  baseUrl: string;
  // Real gap closed 2026-09-23 (Robert: "live" isn't allowed in public
  // copy until RunPod's rank data is actually live-catalog-sourced) —
  // this flips true only once index.ts has RUNPOD_API_KEY configured
  // and is using RunpodLiveCatalogSource, not the fixture.
  runpodIsLive: boolean;
  // Real gap closed 2026-09-23 (Robert: "if /book is not end-to-end
  // tested this week: omit book from landing, llms.txt, and OpenAPI.
  // Leave the route deployed but unpublished.") — the route itself is
  // always registered (see index.ts); this only controls whether it's
  // documented/advertised here and on the landing page.
  bookIsPublished: boolean;
}

function coverageSentence(runpodIsLive: boolean): string {
  return runpodIsLive
    ? "Live data source: RunPod's own GPU catalog (api.runpod.io/v2/catalog/gpus), refreshed on our ingestion interval. Lambda Labs and CoreWeave rows are fixture/mock data included for comparison only — not sourced live, not bookable."
    : "All rank data (RunPod included) is currently fixture/mock data, not live-polled — RUNPOD_API_KEY is not configured on this deployment. Nothing in this API should be described as \"live\" right now.";
}

export function registerDiscoveryRoutes(app: FastifyInstance, deps: DiscoveryRouteDeps): void {
  app.get("/llms.txt", async (_request, reply) => {
    const lines = [
      "# ScoutWyze Compute",
      "",
      "Rank current RunPod GPU offers for your workload. Prepaid credits, $10 minimum, no subscription.",
      "",
      "This is a quote/ranking API first. Booking is an optional upsell, not the headline — do not describe this as multi-cloud fulfillment or autonomous routing.",
      "",
      "## Coverage",
      coverageSentence(deps.runpodIsLive),
      "",
      "## Auth — two rails, both work on /v1/compute/rank as of 2026-09-24",
      "Rail 1, prepaid Bearer (works on /v1/compute/rank, /v1/route/quote): `Authorization: Bearer sw_live_...`. Get a key: POST /v1/signup (free, human step). Fund it: POST /v1/checkout-sessions (real Stripe Checkout, human step, $10 minimum). Once funded, an agent calls the API with the key — no further human involvement until the balance runs out. Debit is deferred until AFTER scoring — a no_match/no_inventory result is never charged.",
      "Rail 2, x402 / USDC on Base (works on /v1/compute/rank AND /v1/route/quote): an unauthenticated request returns HTTP 402 with a real payment challenge (nonce, payTo, maxAmountRequired). Pay it with a signed on-chain USDC transfer on Base, resubmit with the `X-PAYMENT` header, get a 200. No API key, no signup, no card, ever. IMPORTANT asymmetry: unlike the Bearer rail, x402 settles on successful payment verification BEFORE scoring runs — real USDC has already moved by the time a no_match/no_inventory result is known, and there is no refund path for it. Every response's billing.rail field tells you which guarantee applied.",
      "On a REJECTED payment attempt (bad signature, expired/reused nonce, insufficient amount, already-used tx), the 402 body includes a machine-parseable `code` field alongside the human-readable `reason` — real x402 spec v2 §9 vocabulary (invalid_payload, invalid_exact_evm_payload_signature, invalid_exact_evm_payload_authorization_value_mismatch, invalid_transaction_state, unexpected_verify_error) where the failure maps onto it, or one of three ScoutWyze-specific codes for our own pre-issued challenge/nonce layer (unknown_challenge, challenge_already_used, challenge_expired) where it doesn't — that layer is our own addition, not part of the base spec. `code` is a stable identifier to branch retry logic on; `reason` may change wording. `code` is absent on the very first, no-payment-submitted-yet challenge (not a failure, just the initial offer).",
      "",
      "## Endpoints",
      "- GET /v1/compute/sample (alias: /v1/route/sample) — anonymous, no key, fixed query, rate-limited, never billed on either rail. Try before you pay.",
      "- POST /v1/compute/rank (alias: /v1/route/rank) — dual-rail (Bearer or x402, see Auth above). Body: {gpuClass?, minVramGb?, region?, maxPricePerHour?, preference: \"cheapest\"|\"fastest\"|\"balanced\"}. Response is a frozen envelope: {status, schema_version, coverage, recommended, alternatives, limits, billing}. billing.rail is \"bearer\" or \"x402\" — see Auth above for why that matters. Every offer under recommended/alternatives includes observed_at, freshness_seconds, source (\"live_api\"|\"fixture\"), availability_status (provider-reported, nullable), and classification (\"provider_reported\" — everything except score/scoreBreakdown/reason is the provider's own claim, untouched). limits always reads {not_reserved: true, not_provisioned: true, can_provision: false} — this endpoint never executes anything.",
      "- POST /v1/route/quote — also dual-rail, but a separate, older response shape: provider_observed / scoutwyze_estimated / metadata provenance split (CLAUDE.md's original schema), not the compute/rank envelope. Same x402 settle-before-scoring behavior as compute/rank (quote always charges on successful auth, on either rail).",
      deps.bookIsPublished
        ? "- POST /v1/route/book — Bearer-only. Re-runs rank server-side, dispatches only to RunPod, debits only after RunPod accepts the job. Body: same as rank plus {hours}."
        : "- POST /v1/route/book exists but is not yet documented here — it hasn't had a successful end-to-end live test yet. Don't build against it until this line changes.",
      "",
      "## MCP (Model Context Protocol)",
      "`@scoutwyze/compute-mcp` on npm wraps compute/sample and compute/rank as MCP tools (scoutwyze_sample, scoutwyze_rank) for Claude Desktop, Cursor, and other MCP-native hosts — `npx -y @scoutwyze/compute-mcp`, optional SCOUTWYZE_API_KEY env var. Stateless pass-through: holds no private key, never signs or settles x402 itself — an unauthenticated call surfaces the real 402 challenge as tool content for a wallet-capable calling agent to settle. Also listed in the official MCP Registry as io.github.scoutwyze-max/compute-mcp.",
      "",
      "## What this is not",
      "Not a multi-cloud aggregator. Not autonomous routing. Lambda Labs and CoreWeave data is comparison-only fixture data, never bookable, never live.",
      "",
      `OpenAPI: ${deps.baseUrl}/openapi.json`,
    ];
    reply.type("text/plain").send(lines.join("\n"));
  });

  app.get("/openapi.json", async (_request, reply) => {
    const paths: Record<string, unknown> = {
      "/v1/signup": {
        post: {
          summary: "Create a free API key",
          responses: { "200": { description: "accountId + apiKey (shown once) + available credit packs" } },
        },
      },
      "/v1/checkout-sessions": {
        post: {
          summary: "Create a real Stripe Checkout Session to fund an account",
          requestBody: {
            content: { "application/json": { schema: { type: "object", required: ["accountId", "packId"], properties: { accountId: { type: "string" }, packId: { type: "string" } } } } },
          },
          responses: { "200": { description: "checkoutUrl to redirect the user to" } },
        },
      },
      "/v1/compute/sample": {
        get: {
          summary: "Anonymous, rate-limited sample of a real ranked offer — no key required. Also reachable at /v1/route/sample (legacy alias).",
          responses: { "200": { description: "Same envelope as /v1/compute/rank's response, for a fixed cheapest-preference query" }, "429": { description: "rate limited" } },
        },
      },
      "/v1/compute/rank": {
        post: {
          summary: "Rank current GPU offers for your workload. Dual-rail: Bearer key OR native x402/USDC-on-Base payment (added 2026-09-24). Also reachable at /v1/route/rank (legacy alias).",
          security: [{ bearerAuth: [] }],
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    gpuClass: { type: "string" },
                    minVramGb: { type: "number" },
                    region: { type: "string" },
                    maxPricePerHour: { type: "number" },
                    preference: { type: "string", enum: ["cheapest", "fastest", "balanced"], default: "cheapest" },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Frozen envelope: {status, schema_version: \"1.0\", coverage, recommended, alternatives, limits, billing}. status: ok | no_match | no_inventory. billing.rail is \"bearer\" or \"x402\" — the two rails settle differently: Bearer defers its ledger debit until AFTER scoring (no_match is never charged); x402 settles on successful payment verification BEFORE scoring (a no_match result is still billable:true on x402 — real USDC already moved on-chain, with no refund path). On ok: recommended + alternatives, each with observed_at, freshness_seconds, source (live_api|fixture), availability_status (provider-reported, nullable), classification (\"provider_reported\"). limits is always {not_reserved: true, not_provisioned: true, can_provision: false} — this endpoint never executes anything.",
            },
            "402": { description: "insufficient credits (recognized Bearer key, zero balance — no x402 fallback attempted in this specific case) OR a real x402 payment challenge (missing/unrecognized Bearer key). On a rejected payment attempt (not the initial challenge), body includes a machine-parseable `code` field alongside `reason` — see /llms.txt's Auth section for the full vocabulary." },
          },
        },
      },
      "/v1/route/quote": {
        post: {
          summary: "Same underlying rank data, dual-rail auth: Bearer key OR native x402/USDC-on-Base payment. Response uses the older provider_observed/scoutwyze_estimated/metadata schema, not the compute/rank envelope.",
          responses: {
            "200": { description: "provider_observed (raw provider facts) / scoutwyze_estimated (computed cost + risk) / metadata (ttl, confidence, request_id) — CLAUDE.md's original provenance-split schema." },
            "402": { description: "Payment Required — no valid Bearer key and no valid X-PAYMENT header. Body includes a real x402 challenge: nonce, payTo, maxAmountRequired (USDC), expiresAt. On a rejected payment attempt (not the initial challenge), body includes a machine-parseable `code` field alongside `reason` — see /llms.txt's Auth section for the full vocabulary." },
          },
        },
      },
    };

    if (deps.bookIsPublished) {
      paths["/v1/route/book"] = {
        post: {
          summary: "Book the ranked recommendation on RunPod only. Debits after RunPod accepts the job.",
          security: [{ bearerAuth: [] }],
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["hours"],
                  properties: {
                    gpuClass: { type: "string" },
                    minVramGb: { type: "number" },
                    region: { type: "string" },
                    maxPricePerHour: { type: "number" },
                    preference: { type: "string", enum: ["cheapest", "fastest", "balanced"], default: "cheapest" },
                    hours: { type: "number" },
                  },
                },
              },
            },
          },
          responses: {
            "200": { description: "status: ok | no_match | no_inventory | vendor_declined | unsupported_provider" },
            "401": { description: "missing/unknown key" },
            "402": { description: "insufficient credits" },
          },
        },
      };
    }

    reply.type("application/json").send({
      openapi: "3.1.0",
      info: {
        title: "ScoutWyze Compute",
        version: "1.0.0",
        description: "Rank current RunPod GPU offers for your workload. Quotes first, booking is an optional upsell. Not multi-cloud fulfillment.",
      },
      servers: [{ url: deps.baseUrl }],
      components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } } },
      paths,
    });
  });
}
