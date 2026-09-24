import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Durable storage for everything that previously lived in in-memory
 * Maps (ApiKeyStore, CreditLedger, x402's ChallengeStore) — a process
 * restart used to wipe every issued key, every credit balance, and
 * every ledger entry. better-sqlite3 specifically (not an async
 * client) because its synchronous API is what lets charge()/consume()
 * keep the exact "check-and-deduct with no await in between" atomicity
 * they already relied on — wrapped in a real db.transaction() here,
 * this is now genuinely safe against concurrent access at the SQLite
 * level, not just safe because Node's event loop happens to be
 * single-threaded.
 *
 * V1 scope, real and stated: single SQLite file, one process. Good
 * fit for where this app actually is today (no multi-instance
 * deployment yet); migrating to Postgres later would only require
 * swapping this module and the three store classes that use it, not
 * anything upstream of them (routes/middleware only see the same
 * ApiKeyStore/CreditLedger/ChallengeStore interfaces).
 */
export function createDatabase(filePath: string): Database.Database {
  if (filePath !== ":memory:") {
    mkdirSync(dirname(filePath), { recursive: true });
  }

  const db = new Database(filePath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      account_id TEXT PRIMARY KEY,
      balance_usd_cents INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      key_id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_api_keys_key_hash ON api_keys(key_hash);

    CREATE TABLE IF NOT EXISTS ledger_entries (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('charge','topup')),
      amount_usd_cents INTEGER NOT NULL,
      request_hash TEXT,
      balance_after_usd_cents INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ledger_entries_account_id ON ledger_entries(account_id);

    CREATE TABLE IF NOT EXISTS x402_challenges (
      nonce TEXT PRIMARY KEY,
      amount_usdc_cents INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      used INTEGER NOT NULL DEFAULT 0
    );

    -- Idempotency for real payment intake (Stripe webhook retries are
    -- at-least-once by design; a Base tx hash must also never be
    -- credited twice if replayed). Shared table, not per-source,
    -- because the property being enforced -- "this real-world payment
    -- event has already been turned into a topUp exactly once" -- is
    -- the same regardless of which rail it came from.
    CREATE TABLE IF NOT EXISTS processed_payment_events (
      event_id TEXT PRIMARY KEY,
      source TEXT NOT NULL CHECK (source IN ('stripe','base_onchain')),
      account_id TEXT NOT NULL,
      amount_usd_cents INTEGER NOT NULL,
      processed_at TEXT NOT NULL
    );

    -- Admin console telemetry (2026-09-24) — per-request health for
    -- the two public compute endpoints only (sample/rank), not a
    -- general-purpose request log for the whole app. Append-only,
    -- unbounded for now; V1 scope, real gap: no retention/pruning
    -- policy yet, fine at current traffic, would need one before this
    -- table grows unbounded at real volume.
    CREATE TABLE IF NOT EXISTS request_log (
      id TEXT PRIMARY KEY,
      route TEXT NOT NULL CHECK (route IN ('compute_sample','compute_rank')),
      status_code INTEGER NOT NULL,
      latency_ms INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_request_log_route_created ON request_log(route, created_at);

    -- Admin console agent feed (2026-09-24) — append-only status log
    -- for triggered agent runs (currently just the outreach discovery
    -- script). "kind" distinguishes a plain status line from an
    -- operator-triggered run so the UI can render them differently;
    -- "run_id" groups a triggered run's start/progress/completion
    -- lines together (NULL for anything that isn't part of a run).
    CREATE TABLE IF NOT EXISTS agent_log (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('status','run_started','run_completed','run_failed')),
      run_id TEXT,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_log_created ON agent_log(created_at);
  `);

  return db;
}
