import type { FastifyInstance, RouteHandlerMethod } from "fastify";
import type { IngestionCache } from "../../ingestion/cache.js";
import { filterAndScore, type RankedCandidate } from "../../engine/rankedScoring.js";
import type { ProviderId } from "../../types/schema.js";
import { FixedWindowRateLimiter } from "../middleware/rateLimiter.js";

// Kept identical to rank.ts's own constants (2026-09-23 envelope
// freeze) — sample is a preview of rank's real shape, so it must not
// drift from it even by a version string or a limits value.
const SCHEMA_VERSION = "1.0";
const NOT_PROVISIONED_LIMITS = { not_reserved: true, not_provisioned: true, can_provision: false } as const;

function liveProviders(candidates: RankedCandidate[]): ProviderId[] {
  return [...new Set(candidates.filter((c) => c.source === "live_api").map((c) => c.provider))];
}

export interface SampleRouteDeps {
  cache: IngestionCache;
  bookableProviders: ProviderId[];
}

// Placeholder defaults, not a considered capacity decision — tune once
// real abuse patterns (or a real traffic volume) exist to tune against.
const SAMPLE_RATE_LIMIT_MAX_REQUESTS = 20;
const SAMPLE_RATE_LIMIT_WINDOW_MS = 60_000;

// Fixed, canned query — this route NEVER reads request body/query
// params. The whole point of "anonymous preview" is showing exactly
// what a real key would get for one representative request, not
// letting a caller probe arbitrary filters for free.
const SAMPLE_REQUEST = { preference: "cheapest" as const };

/**
 * GET /v1/compute/sample (canonical, also /v1/route/sample legacy
 * alias) — anonymous, no API key, no billing, no booking. Real gap
 * closed 2026-09-23 (Robert: "$10 must be provable before someone
 * pays it") — lets a caller see the REAL shape and REAL data (same
 * cache, same filterAndScore, same allowedProviders restriction, same
 * frozen envelope as the paid route) before ever signing up.
 */
export function registerSampleRoute(app: FastifyInstance, deps: SampleRouteDeps): void {
  const limiter = new FixedWindowRateLimiter(SAMPLE_RATE_LIMIT_MAX_REQUESTS, SAMPLE_RATE_LIMIT_WINDOW_MS);

  // Registered under both paths, same handler (see rank.ts for why
  // this isn't a single array-of-paths call — Fastify's TS shorthand
  // overloads don't support it).
  const handler: RouteHandlerMethod = async (request, reply) => {
    if (!limiter.allow(request.ip)) {
      return reply.code(429).send({
        error: "rate_limited",
        message: `Max ${SAMPLE_RATE_LIMIT_MAX_REQUESTS} sample requests per minute per IP. Sign up for a real key for unrestricted access.`,
      });
    }

    const result = filterAndScore(SAMPLE_REQUEST, deps.cache.getStates(), { allowedProviders: deps.bookableProviders });
    if (result.status !== "ok") {
      return reply.code(200).send({ status: result.status, schema_version: SCHEMA_VERSION });
    }

    const [recommended, ...alternatives] = result.ranked;
    return reply.code(200).send({
      status: "ok",
      schema_version: SCHEMA_VERSION,
      coverage: { vertical: "gpu_compute", providers_live: liveProviders(result.ranked) },
      recommended,
      alternatives,
      limits: NOT_PROVISIONED_LIMITS,
      billing: {
        billable: false,
        unit: "successful_rank",
        note: "Anonymous sample — fixed query (preference=cheapest), rate-limited, never billed. Sign up for a real key to filter by gpuClass/minVramGb/region/preference.",
      },
    });
  };

  app.get("/v1/compute/sample", handler);
  app.get("/v1/route/sample", handler);
}
