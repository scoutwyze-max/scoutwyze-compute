import type { FastifyInstance } from "fastify";
import type { IngestionCache } from "../../ingestion/cache.js";
import { filterAndScore } from "../../engine/rankedScoring.js";
import type { ProviderId } from "../../types/schema.js";
import { FixedWindowRateLimiter } from "../middleware/rateLimiter.js";

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
 * GET /v1/route/sample — anonymous, no API key, no billing, no
 * booking. Real gap closed 2026-09-23 (Robert: "$10 must be provable
 * before someone pays it") — lets a caller see the REAL shape and REAL
 * data (same cache, same filterAndScore, same allowedProviders
 * restriction as the paid route) before ever signing up.
 */
export function registerSampleRoute(app: FastifyInstance, deps: SampleRouteDeps): void {
  const limiter = new FixedWindowRateLimiter(SAMPLE_RATE_LIMIT_MAX_REQUESTS, SAMPLE_RATE_LIMIT_WINDOW_MS);

  app.get("/v1/route/sample", async (request, reply) => {
    if (!limiter.allow(request.ip)) {
      return reply.code(429).send({
        error: "rate_limited",
        message: `Max ${SAMPLE_RATE_LIMIT_MAX_REQUESTS} sample requests per minute per IP. Sign up for a real key for unrestricted access.`,
      });
    }

    const result = filterAndScore(SAMPLE_REQUEST, deps.cache.getStates(), { allowedProviders: deps.bookableProviders });
    if (result.status !== "ok") {
      return reply.code(200).send({ status: result.status });
    }

    const [recommended, ...alternatives] = result.ranked;
    return reply.code(200).send({
      status: "ok",
      recommended,
      alternatives,
      note: "Anonymous sample — fixed query (preference=cheapest), rate-limited, never billed. Sign up for a real key to filter by gpuClass/minVramGb/region/preference.",
    });
  });
}
