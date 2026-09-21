import { randomBytes, createHash, randomUUID } from "node:crypto";

/**
 * Real API-key hygiene, not a flat env-var allowlist (what
 * SCOUTWYZE_API_KEYS was): keys are generated with a real random
 * secret, and only the SHA-256 HASH is ever stored or compared — the
 * raw key is returned exactly once, at creation time, the same
 * convention Stripe/GitHub/etc. use. A leaked store dump (logs, a DB
 * backup) never exposes a usable key.
 *
 * V1 scope, real gap, not silently assumed away: in-memory only. A
 * process restart wipes every issued key. A real deployment needs a
 * persistent, shared store (Postgres, etc.) — same posture the
 * ingestion cache and x402 challenge store already take on this.
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

export class ApiKeyStore {
  private byHash = new Map<string, ApiKeyRecord>();

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
    this.byHash.set(record.keyHash, record);
    return { rawKey, record };
  }

  /** Looks up by the RAW key a client presents — hashes it internally,
   * never compares raw strings directly. Returns null for an unknown
   * OR revoked key; callers don't need to separately check `.revoked`. */
  lookupByRawKey(rawKey: string): ApiKeyRecord | null {
    const record = this.byHash.get(hashApiKey(rawKey));
    if (!record || record.revoked) return null;
    return record;
  }

  revoke(keyId: string): boolean {
    for (const record of this.byHash.values()) {
      if (record.keyId === keyId) {
        record.revoked = true;
        return true;
      }
    }
    return false;
  }
}
