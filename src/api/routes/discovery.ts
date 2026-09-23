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
      "## Auth",
      "Bearer token (`Authorization: Bearer sw_live_...`). Get a key: POST /v1/signup (free). Fund it: POST /v1/checkout-sessions (real Stripe Checkout).",
      "",
      "## Endpoints",
      "- GET /v1/route/sample — anonymous, no key, fixed query, rate-limited. Try before you pay.",
      "- POST /v1/route/rank — Bearer-only (no x402 on this route). Body: {gpuClass?, minVramGb?, region?, maxPricePerHour?, preference: \"cheapest\"|\"fastest\"|\"balanced\"}. Every offer includes observed_at, freshness_seconds, source (\"live_api\"|\"fixture\"), and availability_status (provider-reported, nullable) — check these before trusting a number.",
      deps.bookIsPublished
        ? "- POST /v1/route/book — Bearer-only. Re-runs rank server-side, dispatches only to RunPod, debits only after RunPod accepts the job. Body: same as rank plus {hours}."
        : "- POST /v1/route/book exists but is not yet documented here — it hasn't had a successful end-to-end live test yet. Don't build against it until this line changes.",
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
      "/v1/route/sample": {
        get: {
          summary: "Anonymous, rate-limited sample of a real ranked offer — no key required",
          responses: { "200": { description: "Same shape as /v1/route/rank's response, for a fixed cheapest-preference query" }, "429": { description: "rate limited" } },
        },
      },
      "/v1/route/rank": {
        post: {
          summary: "Rank current GPU offers for your workload (Bearer-only, no x402 on this route)",
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
              description: "status: ok | no_match | no_inventory. On ok: recommended + alternatives, each with observed_at, freshness_seconds, source (live_api|fixture), availability_status (provider-reported, nullable).",
            },
            "401": { description: "missing/unknown key" },
            "402": { description: "insufficient credits" },
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
      openapi: "3.0.3",
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
