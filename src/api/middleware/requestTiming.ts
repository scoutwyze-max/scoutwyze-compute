import type { FastifyReply, FastifyRequest } from "fastify";
import type { LoggedRoute, RequestLogStore } from "../../admin/requestLog.js";
// Import for its `declare module "fastify"` side effect only (adds
// request.authContext to the FastifyRequest type) — auth.ts is the
// module that actually sets it, on both the bearer and x402 branches
// of rank.ts/quote.ts, before this hook's onResponse fires.
import "../middleware/auth.js";

declare module "fastify" {
  interface FastifyRequest {
    startTimeMs?: number;
  }
}

/**
 * Route-level onRequest/onResponse hook pair, logging latency+status
 * to request_log for the admin console's telemetry panel. Deliberately
 * NOT a global app.addHook — only compute/rank and compute/sample opt
 * in (see db/connection.ts's own comment on why this table is
 * narrowly scoped), so this is attached per-route, not app-wide.
 *
 * rail/identifier (2026-09-25) come from request.authContext, set by
 * rank.ts/auth.ts once the rail is determined — sample.ts never sets
 * it (anonymous route), so those rows just log rail=null.
 */
export function createRequestTimingHooks(route: LoggedRoute, requestLog: RequestLogStore) {
  return {
    onRequest: async (request: FastifyRequest): Promise<void> => {
      request.startTimeMs = Date.now();
    },
    onResponse: async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      const latencyMs = request.startTimeMs ? Date.now() - request.startTimeMs : 0;
      requestLog.record(route, reply.statusCode, latencyMs, request.authContext?.rail ?? null, request.authContext?.identifier ?? null);
    },
  };
}
