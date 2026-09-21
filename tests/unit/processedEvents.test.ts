import { describe, expect, it, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { createDatabase } from "../../src/db/connection.js";
import { ProcessedEventStore } from "../../src/payments/processedEvents.js";

describe("ProcessedEventStore — idempotency guard for real payment intake", () => {
  let db: Database.Database;
  let store: ProcessedEventStore;

  beforeEach(() => {
    db = createDatabase(":memory:");
    store = new ProcessedEventStore(db);
  });

  it("records a genuinely new event", () => {
    const result = store.recordIfNew("evt_1", "stripe", "acct_1", 20);
    expect(result).toEqual({ recorded: true });
    expect(store.isProcessed("evt_1")).toBe(true);
  });

  it("rejects re-recording the same event_id — the actual double-credit defense", () => {
    expect(store.recordIfNew("evt_1", "stripe", "acct_1", 20)).toEqual({ recorded: true });
    expect(store.recordIfNew("evt_1", "stripe", "acct_1", 20)).toEqual({ recorded: false });
  });

  it("isProcessed() is false for an event never recorded", () => {
    expect(store.isProcessed("never-seen")).toBe(false);
  });

  it("Stripe and Base on-chain sources share the same id-space — a collision is still rejected regardless of source", () => {
    // Real-world impossible for these two ID formats to collide, but
    // the schema itself doesn't special-case source when enforcing
    // uniqueness (event_id is the sole PRIMARY KEY) — confirms that's
    // deliberate, not an accidental gap.
    expect(store.recordIfNew("shared-id", "stripe", "acct_1", 20)).toEqual({ recorded: true });
    expect(store.recordIfNew("shared-id", "base_onchain", "acct_2", 5)).toEqual({ recorded: false });
  });

  it("amountUsd is stored in cents, rounded — no floating point drift", () => {
    store.recordIfNew("evt_cents", "stripe", "acct_1", 19.999999);
    const row = db.prepare(`SELECT amount_usd_cents FROM processed_payment_events WHERE event_id = ?`).get("evt_cents") as any;
    expect(row.amount_usd_cents).toBe(2000);
  });
});
