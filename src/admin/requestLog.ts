import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

/**
 * Per-request health for the two public compute endpoints — backs the
 * admin console's Endpoint Telemetry panel. Deliberately narrow scope:
 * only compute_sample/compute_rank are logged here, not a general app-
 * wide request log (see db/connection.ts's own comment on this table).
 */
export type LoggedRoute = "compute_sample" | "compute_rank";

export interface RouteTelemetry {
  route: LoggedRoute;
  count: number;
  errorCount: number;
  avgLatencyMs: number | null;
  lastRequestAt: string | null;
}

interface TelemetryRow {
  route: LoggedRoute;
  count: number;
  error_count: number;
  avg_latency_ms: number | null;
  last_at: string | null;
}

export class RequestLogStore {
  constructor(private readonly db: Database.Database) {}

  record(route: LoggedRoute, statusCode: number, latencyMs: number): void {
    this.db
      .prepare(`INSERT INTO request_log (id, route, status_code, latency_ms, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(randomUUID(), route, statusCode, latencyMs, new Date().toISOString());
  }

  /** Aggregated per-route stats since `sinceIso` — one row per route
   * that has at least one logged request in the window; a route with
   * zero traffic simply doesn't appear (caller fills in the zero). */
  getTelemetrySince(sinceIso: string): RouteTelemetry[] {
    const rows = this.db
      .prepare<[string], TelemetryRow>(
        `SELECT route,
                COUNT(*) as count,
                SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) as error_count,
                AVG(latency_ms) as avg_latency_ms,
                MAX(created_at) as last_at
         FROM request_log
         WHERE created_at >= ?
         GROUP BY route`,
      )
      .all(sinceIso);
    return rows.map((r) => ({
      route: r.route,
      count: r.count,
      errorCount: r.error_count,
      avgLatencyMs: r.avg_latency_ms === null ? null : Math.round(r.avg_latency_ms),
      lastRequestAt: r.last_at,
    }));
  }
}
