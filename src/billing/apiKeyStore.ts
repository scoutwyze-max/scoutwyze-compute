import { randomBytes, createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

/**
 * Real API-key hygiene, not a flat env-var allowlist (what
 * SCOUTWYZE_API_KEYS was): keys are generated with a real random
 * secret, and only the SHA-256 HASH is ever stored or compared — the
 * raw key is returned exactly once, at creation time, the same
 * convention Stripe/GitHub/etc. use. A leaked DB dump never exposes a
 * usable key.
 *
 * Backed by SQLite (src/db/connection.ts) — durable across restarts,
 * unlike the earlier in-memory Map version.
 */
export interface ApiKeyRecord {
  keyId: string;
  accountId: string;
  keyHash: string;
  createdAt: string;
  revoked: boolean;
}

const KEY_PREFIX = "sw_live_";

export function hashApiKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}

interface ApiKeyRow {
  key_id: string;
  account_id: string;
  key_hash: string;
  created_at: string;
  revoked: number;
}

function rowToRecord(row: ApiKeyRow): ApiKeyRecord {
  return {
    keyId: row.key_id,
    accountId: row.account_id,
    keyHash: row.key_hash,
    createdAt: row.created_at,
    revoked: row.revoked === 1,
  };
}

export class ApiKeyStore {
  constructor(private readonly db: Database.Database) {}

  /** Returns the raw key ONCE — callers must show/return it to the
   * caller immediately and never persist it themselves. */
  create(accountId: string): { rawKey: string; record: ApiKeyRecord } {
    const secret = randomBytes(24).toString("base64url");
    const rawKey = `${KEY_PREFIX}${secret}`;
    const record: ApiKeyRecord = {
      keyId: randomUUID(),
      accountId,
      keyHash: hashApiKey(rawKey),
      createdAt: new Date().toISOString(),
      revoked: false,
    };

    // Ensure the account row exists (balance 0) so a key can be issued
    // before any top-up — FK-free by design (accounts is referenced
    // logically, not via a foreign key, since ledger entries can
    // outlive an account's keys and vice versa).
    this.db
      .prepare(`INSERT OR IGNORE INTO accounts (account_id, balance_usd_cents, created_at) VALUES (?, 0, ?)`)
      .run(accountId, record.createdAt);

    this.db
      .prepare(`INSERT INTO api_keys (key_id, account_id, key_hash, created_at, revoked) VALUES (?, ?, ?, ?, 0)`)
      .run(record.keyId, record.accountId, record.keyHash, record.createdAt);

    return { rawKey, record };
  }

  /** Looks up by the RAW key a client presents — hashes it internally,
   * never compares raw strings directly. Returns null for an unknown
   * OR revoked key; callers don't need to separately check `.revoked`. */
  lookupByRawKey(rawKey: string): ApiKeyRecord | null {
    const row = this.db
      .prepare<[string], ApiKeyRow>(`SELECT * FROM api_keys WHERE key_hash = ?`)
      .get(hashApiKey(rawKey));
    if (!row || row.revoked === 1) return null;
    return rowToRecord(row);
  }

  revoke(keyId: string): boolean {
    const result = this.db.prepare(`UPDATE api_keys SET revoked = 1 WHERE key_id = ?`).run(keyId);
    return result.changes > 0;
  }
}
