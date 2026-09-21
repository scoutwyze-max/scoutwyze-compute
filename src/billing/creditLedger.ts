import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

/**
 * Prepaid credit ledger, denominated in USD at the public API boundary
 * (same unit the x402 rail already prices routes in), but stored
 * internally as INTEGER CENTS — this removes the floating-point-drift
 * class of bug entirely (the old in-memory version had to
 * Math.round(x*100)/100 defensively after every operation; here it's
 * structurally impossible for a balance to end up as something like
 * 0.30000000000000004).
 *
 * Backed by SQLite. charge()'s check-and-deduct now runs inside a real
 * db.transaction() — genuinely atomic against concurrent access at the
 * database level (a real lock, not just "safe because JS has no await
 * in between" the way the in-memory Map version was).
 */
export interface LedgerEntry {
  id: string;
  accountId: string;
  type: "charge" | "topup";
  amountUsd: number;
  requestHash: string | null;
  balanceAfterUsd: number;
  createdAt: string;
}

interface LedgerRow {
  id: string;
  account_id: string;
  type: "charge" | "topup";
  amount_usd_cents: number;
  request_hash: string | null;
  balance_after_usd_cents: number;
  created_at: string;
}

function rowToEntry(row: LedgerRow): LedgerEntry {
  return {
    id: row.id,
    accountId: row.account_id,
    type: row.type,
    amountUsd: row.amount_usd_cents / 100,
    requestHash: row.request_hash,
    balanceAfterUsd: row.balance_after_usd_cents / 100,
    createdAt: row.created_at,
  };
}

function toCents(usd: number): number {
  return Math.round(usd * 100);
}

// Thrown inside charge()'s transaction to trigger a rollback — never
// escapes charge() itself, caught and converted to a normal { ok: false
// } return so callers don't need to know this is how it's implemented.
class InsufficientCreditsError extends Error {
  constructor(public readonly balanceCents: number) {
    super("insufficient credits");
  }
}

export class CreditLedger {
  constructor(private readonly db: Database.Database) {}

  getBalance(accountId: string): number {
    const row = this.db
      .prepare<[string], { balance_usd_cents: number }>(`SELECT balance_usd_cents FROM accounts WHERE account_id = ?`)
      .get(accountId);
    return (row?.balance_usd_cents ?? 0) / 100;
  }

  topUp(accountId: string, amountUsd: number): LedgerEntry {
    if (amountUsd <= 0) throw new Error("topUp amount must be positive");
    const amountCents = toCents(amountUsd);
    const now = new Date().toISOString();

    const run = this.db.transaction(() => {
      this.db
        .prepare(`INSERT INTO accounts (account_id, balance_usd_cents, created_at) VALUES (?, 0, ?)
                   ON CONFLICT(account_id) DO UPDATE SET balance_usd_cents = balance_usd_cents + excluded.balance_usd_cents`)
        .run(accountId, now);
      this.db
        .prepare(`UPDATE accounts SET balance_usd_cents = balance_usd_cents + ? WHERE account_id = ?`)
        .run(amountCents, accountId);

      const balanceAfterCents = this.db
        .prepare<[string], { balance_usd_cents: number }>(`SELECT balance_usd_cents FROM accounts WHERE account_id = ?`)
        .get(accountId)!.balance_usd_cents;

      const entryId = randomUUID();
      this.db
        .prepare(`INSERT INTO ledger_entries (id, account_id, type, amount_usd_cents, request_hash, balance_after_usd_cents, created_at)
                   VALUES (?, ?, 'topup', ?, NULL, ?, ?)`)
        .run(entryId, accountId, amountCents, balanceAfterCents, now);

      return { entryId, balanceAfterCents, now };
    });

    const { entryId, balanceAfterCents, now: createdAt } = run();
    return { id: entryId, accountId, type: "topup", amountUsd, requestHash: null, balanceAfterUsd: balanceAfterCents / 100, createdAt };
  }

  /**
   * Check-and-deduct as one real SQLite transaction. On insufficient
   * balance, the transaction function throws (rolling back the
   * INSERT-if-missing account row it may have implicitly touched) and
   * the catch below converts that into a normal failure result —
   * nothing is ever written on a failed charge.
   */
  charge(accountId: string, amountUsd: number, requestHash: string): { ok: true; balanceAfterUsd: number } | { ok: false; reason: string; balanceUsd: number } {
    const amountCents = toCents(amountUsd);
    const now = new Date().toISOString();

    const run = this.db.transaction(() => {
      const row = this.db
        .prepare<[string], { balance_usd_cents: number }>(`SELECT balance_usd_cents FROM accounts WHERE account_id = ?`)
        .get(accountId);
      const balanceCents = row?.balance_usd_cents ?? 0;

      if (balanceCents < amountCents) {
        throw new InsufficientCreditsError(balanceCents);
      }

      const newBalanceCents = balanceCents - amountCents;
      this.db
        .prepare(`INSERT INTO accounts (account_id, balance_usd_cents, created_at) VALUES (?, ?, ?)
                   ON CONFLICT(account_id) DO UPDATE SET balance_usd_cents = excluded.balance_usd_cents`)
        .run(accountId, newBalanceCents, now);

      const entryId = randomUUID();
      this.db
        .prepare(`INSERT INTO ledger_entries (id, account_id, type, amount_usd_cents, request_hash, balance_after_usd_cents, created_at)
                   VALUES (?, ?, 'charge', ?, ?, ?, ?)`)
        .run(entryId, accountId, amountCents, requestHash, newBalanceCents, now);

      return newBalanceCents;
    });

    try {
      const newBalanceCents = run();
      return { ok: true, balanceAfterUsd: newBalanceCents / 100 };
    } catch (err) {
      if (err instanceof InsufficientCreditsError) {
        const balanceUsd = err.balanceCents / 100;
        return { ok: false, reason: `insufficient credits: balance $${balanceUsd.toFixed(2)} < required $${amountUsd.toFixed(2)}`, balanceUsd };
      }
      throw err;
    }
  }

  getLedger(accountId: string): LedgerEntry[] {
    const rows = this.db
      .prepare<[string], LedgerRow>(`SELECT * FROM ledger_entries WHERE account_id = ? ORDER BY created_at ASC`)
      .all(accountId);
    return rows.map(rowToEntry);
  }
}
