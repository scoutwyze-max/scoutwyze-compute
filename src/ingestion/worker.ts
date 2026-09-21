import { logger } from "../utils/logger.js";
import type { IngestionCache } from "./cache.js";

/**
 * CLAUDE.md §4 Background Ingestion Rule — Phase 1. Owns the actual
 * polling loop; IngestionCache just holds state. Kept as its own class
 * (not a bare setInterval) for three real reasons, not ceremony:
 *  1. Overlap protection — if a cycle takes longer than the interval
 *     (a slow/hanging adapter), a second concurrent ingestAll() would
 *     race writes to the same cache. Skipped, not queued, with a
 *     logged warning so a genuinely stuck adapter is visible in logs.
 *  2. start()/stop()/isRunning() are independently testable without
 *     touching real wall-clock time (see tests/unit/worker.test.ts).
 *  3. Every cycle is logged (start, per-provider result, or the skip)
 *     — CLAUDE.md's Fail-Closed Rule is only trustworthy in production
 *     if failures are actually observable, not just handled silently.
 */
export class IngestionWorker {
  private timer: NodeJS.Timeout | null = null;
  private cycleInFlight = false;
  private cycleCount = 0;

  constructor(
    private readonly cache: IngestionCache,
    private readonly intervalSeconds: number,
  ) {}

  isRunning(): boolean {
    return this.timer !== null;
  }

  get completedCycles(): number {
    return this.cycleCount;
  }

  /**
   * Runs one ingestion cycle immediately (so the cache is warm before
   * the server accepts its first request), then starts the recurring
   * poll. Idempotent — calling start() while already running is a no-op.
   */
  async start(): Promise<void> {
    if (this.timer) return;
    await this.runCycle();
    this.timer = setInterval(() => {
      void this.runCycle();
    }, this.intervalSeconds * 1000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async runCycle(): Promise<void> {
    if (this.cycleInFlight) {
      logger.warn("ingestion cycle skipped — previous cycle still in flight", {
        completedCycles: this.cycleCount,
      });
      return;
    }
    this.cycleInFlight = true;
    try {
      logger.info("ingestion cycle starting", { cycleNumber: this.cycleCount + 1 });
      await this.cache.ingestAll();
      this.cycleCount += 1;
      logger.info("ingestion cycle complete", {
        cycleNumber: this.cycleCount,
        providers: this.cache.getStates().map((s) => ({
          provider: s.provider,
          status: s.status,
          facts: s.facts.length,
        })),
      });
    } finally {
      this.cycleInFlight = false;
    }
  }
}
