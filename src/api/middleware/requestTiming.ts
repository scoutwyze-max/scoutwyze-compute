import type { FastifyReply, FastifyRequest } from "fastify";
import type { LoggedRoute, RequestLogStore } from "../../admin/requestLog.js";

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
 */
export function createRequestTimingHooks(route: LoggedRoute, requestLog: RequestLogStore) {
  return {
    onRequest: async (request: FastifyRequest): Promise<void> => {
      request.startTimeMs = Date.now();
    },
    onResponse: async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      const latencyMs = request.startTimeMs ? Date.now() - request.startTimeMs : 0;
      requestLog.record(route, reply.statusCode, latencyMs);
    },
  };
}
