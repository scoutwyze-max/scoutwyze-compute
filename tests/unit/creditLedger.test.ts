import { describe, expect, it, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { createDatabase } from "../../src/db/connection.js";
import { CreditLedger } from "../../src/billing/creditLedger.js";

describe("CreditLedger", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createDatabase(":memory:");
  });

  it("a fresh, never-topped-up account has a balance of 0, not undefined/NaN", () => {
    const ledger = new CreditLedger(db);
    expect(ledger.getBalance("new-account")).toBe(0);
  });

  it("topUp increases balance and records a 'topup' ledger entry", () => {
    const ledger = new CreditLedger(db);
    const entry = ledger.topUp("acct-1", 10);
    expect(ledger.getBalance("acct-1")).toBe(10);
    expect(entry.type).toBe("topup");
    expect(entry.amountUsd).toBe(10);
    expect(entry.balanceAfterUsd).toBe(10);
    expect(entry.requestHash).toBeNull();
  });

  it("topUp rejects a non-positive amount rather than silently no-opping or going negative", () => {
    const ledger = new CreditLedger(db);
    expect(() => ledger.topUp("acct-1", 0)).toThrow();
    expect(() => ledger.topUp("acct-1", -5)).toThrow();
  });

  it("charge succeeds against sufficient balance, deducts exactly, and records a 'charge' entry with the request hash", () => {
    const ledger = new CreditLedger(db);
    ledger.topUp("acct-1", 1);
    const result = ledger.charge("acct-1", 0.15, "hash-abc");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.balanceAfterUsd).toBeCloseTo(0.85, 2);
    expect(ledger.getBalance("acct-1")).toBeCloseTo(0.85, 2);

    const [entry] = ledger.getLedger("acct-1").filter((e) => e.type === "charge");
    expect(entry?.requestHash).toBe("hash-abc");
    expect(entry?.amountUsd).toBe(0.15);
  });

  it("charge fails closed against insufficient balance — balance is unchanged, no ledger entry is written", () => {
    const ledger = new CreditLedger(db);
    ledger.topUp("acct-1", 0.1);
    const result = ledger.charge("acct-1", 0.15, "hash-abc");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/insufficient credits/);
      expect(result.balanceUsd).toBe(0.1);
    }
    expect(ledger.getBalance("acct-1")).toBe(0.1); // unchanged
    expect(ledger.getLedger("acct-1").filter((e) => e.type === "charge")).toHaveLength(0);
  });

  it("an account with exactly zero balance is rejected, not treated as having infinite/undefined credit", () => {
    const ledger = new CreditLedger(db);
    const result = ledger.charge("never-funded", 0.01, "hash-abc");
    expect(result.ok).toBe(false);
  });

  it("sequential charges correctly deplete a balance to exactly zero, then the next one fails", () => {
    const ledger = new CreditLedger(db);
    ledger.topUp("acct-1", 0.3);
    expect(ledger.charge("acct-1", 0.15, "h1").ok).toBe(true);
    expect(ledger.charge("acct-1", 0.15, "h2").ok).toBe(true);
    expect(ledger.getBalance("acct-1")).toBe(0);
    expect(ledger.charge("acct-1", 0.01, "h3").ok).toBe(false);
  });

  it("getLedger only returns entries for the requested account — no cross-account leakage", () => {
    const ledger = new CreditLedger(db);
    ledger.topUp("acct-1", 5);
    ledger.topUp("acct-2", 5);
    ledger.charge("acct-1", 1, "h1");

    const acct1Entries = ledger.getLedger("acct-1");
    const acct2Entries = ledger.getLedger("acct-2");
    expect(acct1Entries).toHaveLength(2); // topup + charge
    expect(acct2Entries).toHaveLength(1); // topup only
    expect(acct2Entries.every((e) => e.accountId === "acct-2")).toBe(true);
  });

  it("amounts round to whole cents, no floating-point drift leaking into balances", () => {
    const ledger = new CreditLedger(db);
    ledger.topUp("acct-1", 0.1);
    ledger.topUp("acct-1", 0.2); // classic 0.1 + 0.2 !== 0.3 floating point trap
    expect(ledger.getBalance("acct-1")).toBe(0.3);
  });
});
