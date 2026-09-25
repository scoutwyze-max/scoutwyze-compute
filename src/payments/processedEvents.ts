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

  /** Admin console — real Stripe pack purchases specifically (not
   * base_onchain), newest first, for the "credit pack purchases" feed. */
  recentStripePurchases(limit: number): { eventId: string; accountId: string; amountUsd: number; processedAt: string }[] {
    const rows = this.db
      .prepare<[number], { event_id: string; account_id: string; amount_usd_cents: number; processed_at: string }>(
        `SELECT event_id, account_id, amount_usd_cents, processed_at FROM processed_payment_events WHERE source = 'stripe' ORDER BY processed_at DESC LIMIT ?`,
      )
      .all(limit);
    return rows.map((r) => ({ eventId: r.event_id, accountId: r.account_id, amountUsd: r.amount_usd_cents / 100, processedAt: r.processed_at }));
  }

  /** Admin console — real on-chain x402/USDC settlements on Base,
   * newest first. event_id IS the real Base tx hash (recordIfNew's
   * eventId param for the base_onchain source, see verifyX402Payment
   * in auth.ts) — not a synthetic ID, safe to link straight to
   * BaseScan. account_id holds the payer's wallet address for this
   * source (there's no ScoutWyze ledger account on the x402 rail —
   * the column is shared with Stripe's real account_id, named for the
   * common case, not renamed per-source). */
  recentBaseSettlements(limit: number): { txHash: string; payerAddress: string; amountUsd: number; processedAt: string }[] {
    const rows = this.db
      .prepare<[number], { event_id: string; account_id: string; amount_usd_cents: number; processed_at: string }>(
        `SELECT event_id, account_id, amount_usd_cents, processed_at FROM processed_payment_events WHERE source = 'base_onchain' ORDER BY processed_at DESC LIMIT ?`,
      )
      .all(limit);
    return rows.map((r) => ({ txHash: r.event_id, payerAddress: r.account_id, amountUsd: r.amount_usd_cents / 100, processedAt: r.processed_at }));
  }
}
