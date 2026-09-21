import { randomUUID } from "node:crypto";

/**
 * Prepaid credit ledger, denominated in USD (same unit the x402 rail
 * already prices routes in — DEFAULT_ROUTE_PRICE_USDC — so both rails
 * share one mental model of "cost per route" instead of inventing a
 * separate credits-to-dollars conversion rate).
 *
 * V1 scope, same honest gap as ApiKeyStore: in-memory, resets on
 * restart, single-process only. The atomicity within `charge()` is
 * real (JS's single-threaded event loop makes the check-then-deduct
 * genuinely uninterruptible here) but would need a real transaction
 * (row lock / compare-and-swap) against a shared DB in production —
 * noted, not silently assumed to already be production-safe.
 */
export interface LedgerEntry {
  id: string;
  accountId: string;
  type: "charge" | "topup";
  amountUsd: number; // positive for both types; sign is implied by `type`
  requestHash: string | null; // which route-quote request this charge paid for, null for topups
  balanceAfterUsd: number;
  createdAt: string;
}

export class CreditLedger {
  private balances = new Map<string, number>();
  private entries: LedgerEntry[] = [];

  getBalance(accountId: string): number {
    return this.balances.get(accountId) ?? 0;
  }

  topUp(accountId: string, amountUsd: number): LedgerEntry {
    if (amountUsd <= 0) throw new Error("topUp amount must be positive");
    const newBalance = this.getBalance(accountId) + amountUsd;
    this.balances.set(accountId, roundCents(newBalance));
    const entry: LedgerEntry = {
      id: randomUUID(),
      accountId,
      type: "topup",
      amountUsd: roundCents(amountUsd),
      requestHash: null,
      balanceAfterUsd: roundCents(newBalance),
      createdAt: new Date().toISOString(),
    };
    this.entries.push(entry);
    return entry;
  }

  /**
   * Check-and-deduct in one call — same reasoning as
   * ChallengeStore.consume() in the x402 module: two concurrent
   * requests against the same account can't both pass a balance check
   * and then both deduct, because the check and the deduction happen
   * in the same synchronous call, with no `await` in between.
   */
  charge(accountId: string, amountUsd: number, requestHash: string): { ok: true; balanceAfterUsd: number } | { ok: false; reason: string; balanceUsd: number } {
    const balance = this.getBalance(accountId);
    if (balance < amountUsd) {
      return { ok: false, reason: `insufficient credits: balance $${balance.toFixed(2)} < required $${amountUsd.toFixed(2)}`, balanceUsd: balance };
    }
    const newBalance = roundCents(balance - amountUsd);
    this.balances.set(accountId, newBalance);
    this.entries.push({
      id: randomUUID(),
      accountId,
      type: "charge",
      amountUsd: roundCents(amountUsd),
      requestHash,
      balanceAfterUsd: newBalance,
      createdAt: new Date().toISOString(),
    });
    return { ok: true, balanceAfterUsd: newBalance };
  }

  getLedger(accountId: string): LedgerEntry[] {
    return this.entries.filter((e) => e.accountId === accountId);
  }
}

function roundCents(value: number): number {
  return Math.round(value * 100) / 100;
}
