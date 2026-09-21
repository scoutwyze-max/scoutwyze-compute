import { describe, expect, it } from "vitest";
import { ApiKeyStore, hashApiKey } from "../../src/billing/apiKeyStore.js";

describe("ApiKeyStore", () => {
  it("create() returns a usable raw key and a record whose stored hash matches it", () => {
    const store = new ApiKeyStore();
    const { rawKey, record } = store.create("acct-1");
    expect(rawKey.startsWith("sw_live_")).toBe(true);
    expect(record.keyHash).toBe(hashApiKey(rawKey));
    expect(record.accountId).toBe("acct-1");
    expect(record.revoked).toBe(false);
  });

  it("never stores or exposes the raw key on the record itself — only the hash", () => {
    const store = new ApiKeyStore();
    const { rawKey, record } = store.create("acct-1");
    expect(JSON.stringify(record)).not.toContain(rawKey);
  });

  it("lookupByRawKey finds a key that was actually issued", () => {
    const store = new ApiKeyStore();
    const { rawKey, record } = store.create("acct-1");
    const found = store.lookupByRawKey(rawKey);
    expect(found?.keyId).toBe(record.keyId);
  });

  it("lookupByRawKey returns null for a key that was never issued", () => {
    const store = new ApiKeyStore();
    expect(store.lookupByRawKey("sw_live_totallyMadeUp")).toBeNull();
  });

  it("lookupByRawKey returns null after the key is revoked — revocation is real, not cosmetic", () => {
    const store = new ApiKeyStore();
    const { rawKey, record } = store.create("acct-1");
    expect(store.lookupByRawKey(rawKey)).not.toBeNull();

    const revoked = store.revoke(record.keyId);
    expect(revoked).toBe(true);
    expect(store.lookupByRawKey(rawKey)).toBeNull();
  });

  it("revoke() on an unknown keyId returns false rather than throwing", () => {
    const store = new ApiKeyStore();
    expect(store.revoke("not-a-real-key-id")).toBe(false);
  });

  it("two separately created keys are never equal (real randomness, not a fixed/predictable value)", () => {
    const store = new ApiKeyStore();
    const a = store.create("acct-1");
    const b = store.create("acct-1");
    expect(a.rawKey).not.toBe(b.rawKey);
    expect(a.record.keyId).not.toBe(b.record.keyId);
  });

  it("hashApiKey is deterministic — the same raw key always hashes the same, required for lookup to work at all", () => {
    expect(hashApiKey("sw_live_abc")).toBe(hashApiKey("sw_live_abc"));
    expect(hashApiKey("sw_live_abc")).not.toBe(hashApiKey("sw_live_xyz"));
  });
});
