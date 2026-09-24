import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "../../src/db/connection.js";
import { ApiKeyStore } from "../../src/billing/apiKeyStore.js";
import { CreditLedger } from "../../src/billing/creditLedger.js";
import { ChallengeStore } from "../../src/api/middleware/x402.js";

const TEST_TREASURY_ADDRESS = "0xc132a315a05541a4b72c272de539eb86de977fb9";

/**
 * The actual point of this whole persistence pass: data must survive
 * the process that wrote it going away. Every other test in this repo
 * uses a fresh :memory: database per test/file — genuinely useful for
 * isolation, but it can't prove durability, since an in-memory
 * database disappearing when the process ends is indistinguishable
 * from correct behavior. This test uses a REAL file on disk, closes
 * the connection (simulating a process exit), and reopens it fresh —
 * the only way to actually prove "restart" survives.
 */
describe("SQLite persistence — survives closing and reopening the connection", () => {
  let tempDir: string;
  let dbPath: string;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it("an API key created before a 'restart' still resolves after one", () => {
    tempDir = mkdtempSync(join(tmpdir(), "scoutwyze-compute-test-"));
    dbPath = join(tempDir, "test.db");

    const firstConnection = createDatabase(dbPath);
    const { rawKey } = new ApiKeyStore(firstConnection).create("durable-account");
    firstConnection.close(); // simulates the process exiting

    const secondConnection = createDatabase(dbPath); // simulates a fresh process starting
    const found = new ApiKeyStore(secondConnection).lookupByRawKey(rawKey);
    secondConnection.close();

    expect(found).not.toBeNull();
    expect(found?.accountId).toBe("durable-account");
  });

  it("a credit balance and its full ledger history survive a restart", () => {
    tempDir = mkdtempSync(join(tmpdir(), "scoutwyze-compute-test-"));
    dbPath = join(tempDir, "test.db");

    const firstConnection = createDatabase(dbPath);
    const firstLedger = new CreditLedger(firstConnection);
    firstLedger.topUp("durable-account", 10);
    firstLedger.charge("durable-account", 0.15, "hash-1");
    firstLedger.charge("durable-account", 0.15, "hash-2");
    firstConnection.close();

    const secondConnection = createDatabase(dbPath);
    const secondLedger = new CreditLedger(secondConnection);
    const balance = secondLedger.getBalance("durable-account");
    const entries = secondLedger.getLedger("durable-account");
    secondConnection.close();

    expect(balance).toBeCloseTo(9.7, 2);
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.type)).toEqual(["topup", "charge", "charge"]);
  });

  it("a REVOKED key stays revoked across a restart — not just an in-memory flag that resets", () => {
    tempDir = mkdtempSync(join(tmpdir(), "scoutwyze-compute-test-"));
    dbPath = join(tempDir, "test.db");

    const firstConnection = createDatabase(dbPath);
    const { rawKey, record } = new ApiKeyStore(firstConnection).create("durable-account");
    new ApiKeyStore(firstConnection).revoke(record.keyId);
    firstConnection.close();

    const secondConnection = createDatabase(dbPath);
    const found = new ApiKeyStore(secondConnection).lookupByRawKey(rawKey);
    secondConnection.close();

    expect(found).toBeNull(); // still revoked, not reset to active
  });

  it("an unconsumed x402 nonce is still consumable (and still single-use) after a restart", () => {
    tempDir = mkdtempSync(join(tmpdir(), "scoutwyze-compute-test-"));
    dbPath = join(tempDir, "test.db");
    const now = Date.now();

    const firstConnection = createDatabase(dbPath);
    const { nonce } = new ChallengeStore(firstConnection, TEST_TREASURY_ADDRESS).issue(0.15, now, "/v1/route/quote");
    firstConnection.close(); // client is mid-flow when the process restarts

    const secondConnection = createDatabase(dbPath);
    const secondStore = new ChallengeStore(secondConnection, TEST_TREASURY_ADDRESS);
    const firstConsume = secondStore.consume(nonce, 0.15, now + 1000);
    const secondConsume = secondStore.consume(nonce, 0.15, now + 2000); // replay attempt
    secondConnection.close();

    expect(firstConsume).toEqual({ ok: true });
    expect(secondConsume.ok).toBe(false);
  });

  it("createDatabase() creates the parent directory if it doesn't exist yet", () => {
    tempDir = mkdtempSync(join(tmpdir(), "scoutwyze-compute-test-"));
    dbPath = join(tempDir, "nested", "subdir", "test.db");

    expect(() => {
      const db = createDatabase(dbPath);
      db.close();
    }).not.toThrow();
  });
});
