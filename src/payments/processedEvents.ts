import type Database from "better-sqlite3";

export type PaymentEventSource = "stripe" | "base_onchain";

// Thrown inside recordIfNew()'s transaction to force a rollback when
// the event_id was already recorded — never escapes the function.
class AlreadyProcessedError extends Error {}

/**
 * Idempotency guard for real payment intake. Two real hazards this
 * closes: Stripe delivers webhooks at-least-once (a network blip on
 * our 200 response means a guaranteed retry with the SAME event.id),
 * and a client could resubmit the same real Base transaction hash
 * hoping to get credited twice. Both are the same shape of problem —
 * "have we already turned this specific real-world event into a
 * credit ledger topUp" — solved once, here, not duplicated per-rail.
 */
export class ProcessedEventStore {
  constructor(private readonly db: Database.Database) {}

  isProcessed(eventId: string): boolean {
    const row = this.db.prepare(`SELECT 1 FROM processed_payment_events WHERE event_id = ?`).get(eventId);
    return row !== undefined;
  }

  /**
   * Atomically checks-and-records in one transaction — the same
   * reasoning as CreditLedger.charge() and ChallengeStore.consume():
   * two concurrent deliveries of the same event (a real Stripe retry
   * racing itself, for instance) can't both pass.
   */
  recordIfNew(
    eventId: string,
    source: PaymentEventSource,
    accountId: string,
    amountUsd: number,
  ): { recorded: true } | { recorded: false } {
    const run = this.db.transaction(() => {
      const existing = this.db.prepare(`SELECT 1 FROM processed_payment_events WHERE event_id = ?`).get(eventId);
      if (existing) throw new AlreadyProcessedError();
      this.db
        .prepare(
          `INSERT INTO processed_payment_events (event_id, source, account_id, amount_usd_cents, processed_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(eventId, source, accountId, Math.round(amountUsd * 100), new Date().toISOString());
    });

    try {
      run();
      return { recorded: true };
    } catch (err) {
      if (err instanceof AlreadyProcessedError) return { recorded: false };
      throw err;
    }
  }
}
