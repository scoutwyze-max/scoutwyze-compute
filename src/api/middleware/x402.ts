import { randomUUID, createHmac, createHash } from "node:crypto";
import type Database from "better-sqlite3";

/**
 * CLAUDE.md §4 Secondary Path — x402 protocol / USDC on Base.
 *
 * V1 SCOPE (per direction, still true): the actual on-chain settlement
 * verification (confirming a real USDC transfer happened on Base) is
 * NOT built — that's the one piece still mocked. Everything else here
 * — challenge issuance, nonce single-use enforcement, TTL expiry,
 * signed receipts bound to a specific request — is real application-
 * layer protocol logic, not mocked, because replay/scraping protection
 * doesn't depend on which settlement backend eventually verifies the
 * money moved.
 */

export const MIN_ROUTE_PRICE_USDC = 0.1;
export const MAX_ROUTE_PRICE_USDC = 0.25;
export const DEFAULT_ROUTE_PRICE_USDC = 0.15;

// How long a client has to submit payment after receiving a 402
// challenge before that nonce "times out" and is rejected.
export const CHALLENGE_TTL_SECONDS = 120;

// CLAUDE.md-specified "60s quote TTL bound to the request hash" — how
// long a successful payment's receipt can be reused (e.g. for a client
// retry) before requiring fresh payment again.
export const RECEIPT_TTL_SECONDS = 60;

const RECEIPT_SIGNING_SECRET = process.env.X402_RECEIPT_SIGNING_SECRET || "dev-only-insecure-default-secret";

export interface X402Challenge {
  scheme: "exact";
  network: "base";
  maxAmountRequired: string; // USDC, string per the real x402 spec's convention
  resource: string;
  payTo: string;
  asset: "USDC";
  nonce: string;
  expiresAt: string;
}

interface ChallengeRow {
  nonce: string;
  amount_usdc_cents: number;
  expires_at_ms: number;
  used: number;
}

// Thrown inside consume()'s transaction to force a rollback on any
// rejection path — never escapes consume() itself.
class ChallengeRejected extends Error {
  constructor(public readonly reason: string) {
    super(reason);
  }
}

/**
 * SQLite-backed nonce store — single-use enforcement is the actual
 * replay defense (CLAUDE.md: "prevent replay attacks and scraping").
 * Durable across restarts (previously an in-memory Map, wiped on every
 * restart — a client mid-payment-flow across a deploy would have
 * silently lost their challenge). consume()'s check-and-mark runs
 * inside a real db.transaction(), same reasoning as
 * CreditLedger.charge(): genuinely atomic against concurrent access at
 * the database level, not just safe because JS has no await in
 * between.
 */
export class ChallengeStore {
  constructor(private readonly db: Database.Database) {}

  issue(amountUsdc: number, now: number): X402Challenge {
    const nonce = randomUUID();
    const expiresAtMs = now + CHALLENGE_TTL_SECONDS * 1000;
    this.db
      .prepare(`INSERT INTO x402_challenges (nonce, amount_usdc_cents, expires_at_ms, used) VALUES (?, ?, ?, 0)`)
      .run(nonce, Math.round(amountUsdc * 100), expiresAtMs);
    return {
      scheme: "exact",
      network: "base",
      maxAmountRequired: amountUsdc.toFixed(2),
      resource: "/v1/route/quote",
      payTo: "0xScoutWyzeComputeMockReceivingAddress",
      asset: "USDC",
      nonce,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  consume(nonce: string, submittedAmountUsdc: number, now: number): { ok: true } | { ok: false; reason: string } {
    const run = this.db.transaction(() => {
      const row = this.db.prepare<[string], ChallengeRow>(`SELECT * FROM x402_challenges WHERE nonce = ?`).get(nonce);
      if (!row) throw new ChallengeRejected("unknown or already-expired challenge nonce");
      if (row.used === 1) throw new ChallengeRejected("nonce already used — replay attempt rejected");
      if (now > row.expires_at_ms) throw new ChallengeRejected(`challenge timed out — submit payment within ${CHALLENGE_TTL_SECONDS}s of receiving it`);
      if (Math.round(submittedAmountUsdc * 100) < row.amount_usdc_cents) {
        throw new ChallengeRejected(`amount $${submittedAmountUsdc} below the required $${(row.amount_usdc_cents / 100).toFixed(2)}`);
      }
      this.db.prepare(`UPDATE x402_challenges SET used = 1 WHERE nonce = ?`).run(nonce);
    });

    try {
      run();
      return { ok: true };
    } catch (err) {
      if (err instanceof ChallengeRejected) return { ok: false, reason: err.reason };
      throw err;
    }
  }
}

/** Canonical, key-order-independent hash of a request body — this is
 * the "bound to the request hash" anti-scraping mechanism: a receipt
 * issued for one set of route parameters cannot be replayed to fetch a
 * DIFFERENT set of parameters for free. */
export function computeRequestHash(body: unknown): string {
  const canonical = canonicalize(body);
  return createHash("sha256").update(canonical).digest("hex");
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize((value as Record<string, unknown>)[k])}`).join(",")}}`;
}

export interface ReceiptPayload {
  requestHash: string;
  nonce: string;
  issuedAtMs: number;
  expiresAtMs: number;
}

/** Real HMAC-SHA256 signing — the settlement check behind it is mocked,
 * the signature on the receipt itself is not. */
export function signReceipt(payload: ReceiptPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", RECEIPT_SIGNING_SECRET).update(body).digest("hex");
  return `${body}.${signature}`;
}

export function verifyReceiptToken(
  token: string,
  now: number,
): { valid: true; payload: ReceiptPayload } | { valid: false; reason: string } {
  const parts = token.split(".");
  if (parts.length !== 2) return { valid: false, reason: "malformed receipt token" };
  const [body, signature] = parts as [string, string];

  const expectedSignature = createHmac("sha256", RECEIPT_SIGNING_SECRET).update(body).digest("hex");
  if (signature !== expectedSignature) return { valid: false, reason: "invalid receipt signature" };

  let payload: ReceiptPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf-8"));
  } catch {
    return { valid: false, reason: "malformed receipt payload" };
  }

  if (now > payload.expiresAtMs) return { valid: false, reason: "receipt expired" };
  return { valid: true, payload };
}

export interface X402PaymentSubmission {
  scheme: "exact";
  network: "base";
  nonce: string;
  amountUsdc: number;
  payload: string; // mock settlement proof — real integration replaces this with an actual signed tx reference
}

export function decodePaymentHeader(headerValue: string | undefined): X402PaymentSubmission | { error: string } {
  if (!headerValue) return { error: "missing X-PAYMENT header" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(headerValue, "base64").toString("utf-8"));
  } catch {
    return { error: "X-PAYMENT header is not valid base64-encoded JSON" };
  }
  const p = parsed as Partial<X402PaymentSubmission>;
  if (p.scheme !== "exact" || p.network !== "base") return { error: "unsupported payment scheme/network" };
  if (typeof p.nonce !== "string" || !p.nonce) return { error: "missing nonce — payment must reference a real issued challenge" };
  if (typeof p.amountUsdc !== "number") return { error: "missing or invalid amountUsdc" };
  if (typeof p.payload !== "string" || !p.payload) return { error: "missing settlement payload" };
  return { scheme: "exact", network: "base", nonce: p.nonce, amountUsdc: p.amountUsdc, payload: p.payload };
}
