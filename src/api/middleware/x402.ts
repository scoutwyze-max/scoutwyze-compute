import { randomUUID, createHmac, createHash, timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";

/**
 * CLAUDE.md §4 Secondary Path — x402 protocol / USDC on Base.
 *
 * Challenge issuance, nonce single-use enforcement, TTL expiry, and
 * signed receipts bound to a specific request all live here. The real
 * signature-recovery and on-chain settlement verification (2026-09,
 * scope-expanded past the original V1 mock boundary at Robert's
 * explicit direction) live in payments/baseVerification.ts and are
 * wired in from auth.ts — this file no longer has a mocked piece.
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

/**
 * Machine-parseable failure codes for a rejected payment attempt
 * (2026-09-25) — real x402 spec vocabulary, not invented: verified
 * directly against coinbase/x402/specs/x402-specification-v2.md §9
 * ("Error Handling"), the same literal strings VerifyResponse's
 * invalidReason / SettleResponse's errorReason use. Previously every
 * failure only carried a free-text `reason` sentence — fine for a
 * human reading logs, useless for an agent runtime trying to decide
 * "should I retry with a fresh signature, a fresh nonce, or give up."
 *
 * The last three are NOT from the spec: ScoutWyze's own pre-issued
 * challenge/nonce layer (ChallengeStore — a server-side anti-replay
 * token issued in the 402 challenge, which the client must echo back
 * signed) is an addition on top of base x402, not something the spec
 * itself defines a vocabulary for. Kept clearly, deliberately distinct
 * from the spec codes rather than force-mapped onto one — e.g. a
 * timed-out ScoutWyze challenge is NOT the same failure as an expired
 * EIP-3009 authorization.valid_before, and claiming otherwise would
 * mislead a parser that already knows the real spec codes.
 */
export type X402ErrorCode =
  | "invalid_payload"
  | "invalid_exact_evm_payload_signature"
  | "invalid_exact_evm_payload_authorization_value_mismatch"
  | "invalid_transaction_state"
  | "unexpected_verify_error"
  | "unknown_challenge"
  | "challenge_already_used"
  | "challenge_expired";

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

/**
 * Bazaar discovery extension (2026-09-24) — the x402 ecosystem's
 * marketplace/discovery layer (x402 Bazaar, Agentic.Market) catalogs a
 * resource as a side effect of its FIRST successful settlement through
 * a Bazaar-aware facilitator, reading this exact structure from
 * `extensions.bazaar` on the 402 response body (sibling of `accepts`,
 * not nested inside a challenge entry — verified against
 * x402-foundation/x402's actual PaymentRequired type, not assumed).
 *
 * This is a hand-built equivalent of @x402/extensions'
 * createBodyDiscoveryExtension (x402-foundation/x402,
 * typescript/packages/extensions/src/bazaar/http/resourceService.ts,
 * read directly from the real source 2026-09-24), not that package
 * itself: pulling in @x402/extensions for one static JSON object costs
 * 9 dependencies, 1.7MB, and a second full Ethereum library (viem)
 * alongside the ethers this codebase already uses for chain reads.
 * This produces the identical output shape for the body-method (POST)
 * case with none of that weight — it's pure JSON shaping, no crypto,
 * no chain interaction, matched field-for-field against the real
 * function.
 */
export interface BazaarBodyExtensionConfig {
  method: "POST";
  inputExample: Record<string, unknown>;
  inputJsonSchema: Record<string, unknown>;
  outputExample: unknown;
}

export function buildBazaarBodyExtension(config: BazaarBodyExtensionConfig): Record<string, unknown> {
  return {
    info: {
      input: {
        type: "http" as const,
        method: config.method,
        bodyType: "json" as const,
        body: config.inputExample,
      },
      output: { type: "json", example: config.outputExample },
    },
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        input: {
          type: "object",
          properties: {
            type: { type: "string", const: "http" },
            method: { type: "string", enum: [config.method] },
            bodyType: { type: "string", enum: ["json"] },
            body: config.inputJsonSchema,
          },
          required: ["type", "method", "bodyType", "body"],
          additionalProperties: false,
        },
        output: {
          type: "object",
          properties: {
            type: { type: "string" },
            example: { type: "object" },
          },
          required: ["type"],
        },
      },
      required: ["input"],
    },
  };
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
  constructor(
    public readonly reason: string,
    public readonly code: X402ErrorCode,
  ) {
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
  // treasuryAddress is real, not a secret — it's the address clients
  // are TOLD to pay, publicly advertised in every 402 response, same
  // as any receiving address. Injected (not hardcoded here) so tests
  // can use a distinct known address without touching env vars.
  constructor(
    private readonly db: Database.Database,
    private readonly treasuryAddress: string,
  ) {}

  // `resource` is real, caller-supplied (2026-09-24 fix, caught live
  // while manually verifying the rank x402 extension): this used to be
  // hardcoded to "/v1/route/quote" regardless of which route actually
  // issued the challenge, so a rank-issued challenge lied about what
  // it was for. No test caught it because no test asserted on this
  // field's VALUE, only its presence.
  issue(amountUsdc: number, now: number, resource: string): X402Challenge {
    const nonce = randomUUID();
    const expiresAtMs = now + CHALLENGE_TTL_SECONDS * 1000;
    this.db
      .prepare(`INSERT INTO x402_challenges (nonce, amount_usdc_cents, expires_at_ms, used) VALUES (?, ?, ?, 0)`)
      .run(nonce, Math.round(amountUsdc * 100), expiresAtMs);
    return {
      scheme: "exact",
      network: "base",
      maxAmountRequired: amountUsdc.toFixed(2),
      resource,
      payTo: this.treasuryAddress,
      asset: "USDC",
      nonce,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  consume(nonce: string, submittedAmountUsdc: number, now: number): { ok: true } | { ok: false; reason: string; code: X402ErrorCode } {
    const run = this.db.transaction(() => {
      const row = this.db.prepare<[string], ChallengeRow>(`SELECT * FROM x402_challenges WHERE nonce = ?`).get(nonce);
      if (!row) throw new ChallengeRejected("unknown or already-expired challenge nonce", "unknown_challenge");
      if (row.used === 1) throw new ChallengeRejected("nonce already used — replay attempt rejected", "challenge_already_used");
      if (now > row.expires_at_ms) {
        throw new ChallengeRejected(`challenge timed out — submit payment within ${CHALLENGE_TTL_SECONDS}s of receiving it`, "challenge_expired");
      }
      if (Math.round(submittedAmountUsdc * 100) < row.amount_usdc_cents) {
        throw new ChallengeRejected(
          `amount $${submittedAmountUsdc} below the required $${(row.amount_usdc_cents / 100).toFixed(2)}`,
          "invalid_exact_evm_payload_authorization_value_mismatch",
        );
      }
      this.db.prepare(`UPDATE x402_challenges SET used = 1 WHERE nonce = ?`).run(nonce);
    });

    try {
      run();
      return { ok: true };
    } catch (err) {
      if (err instanceof ChallengeRejected) return { ok: false, reason: err.reason, code: err.code };
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

/** Real HMAC-SHA256 signing of a real, on-chain-verified payment's
 * receipt (see auth.ts's x402 branch for the settlement check itself). */
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
  // Constant-time comparison — real security fix found while building
  // the Stripe verifier alongside this: a naive !== leaks timing
  // information about how many leading bytes matched.
  const expectedBuf = Buffer.from(expectedSignature, "hex");
  const providedBuf = Buffer.from(signature, "hex");
  if (providedBuf.length !== expectedBuf.length || !timingSafeEqual(providedBuf, expectedBuf)) {
    return { valid: false, reason: "invalid receipt signature" };
  }

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
  // Real settlement proof (no longer a mock opaque string): the payer
  // claims to have sent a real USDC transfer from payerAddress in
  // transaction txHash, and signature is an EIP-191 signature over the
  // canonical message (buildPaymentAuthorizationMessage in
  // baseVerification.ts) proving payerAddress authorized THIS exact
  // nonce/amount/txHash. Neither claim is trusted until both are
  // independently verified — see auth.ts's x402 branch.
  payerAddress: string;
  txHash: string;
  signature: string;
}

export function decodePaymentHeader(
  headerValue: string | undefined,
): X402PaymentSubmission | { error: string; code?: X402ErrorCode } {
  // No code here, deliberately (2026-09-25): an absent header is the
  // normal first-contact case — an agent's opening request, before it
  // has anything to submit — not a rejected payload. Every other
  // branch below DID receive something and found it broken, so those
  // get a real code; this one doesn't, or a parser would be told
  // "your payload is invalid" about a payload that was never sent.
  if (!headerValue) return { error: "missing X-PAYMENT header" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(headerValue, "base64").toString("utf-8"));
  } catch {
    return { error: "X-PAYMENT header is not valid base64-encoded JSON", code: "invalid_payload" };
  }
  const p = parsed as Partial<X402PaymentSubmission>;
  if (p.scheme !== "exact" || p.network !== "base") return { error: "unsupported payment scheme/network", code: "invalid_payload" };
  if (typeof p.nonce !== "string" || !p.nonce) return { error: "missing nonce — payment must reference a real issued challenge", code: "invalid_payload" };
  if (typeof p.amountUsdc !== "number") return { error: "missing or invalid amountUsdc", code: "invalid_payload" };
  if (typeof p.payerAddress !== "string" || !p.payerAddress) return { error: "missing payerAddress", code: "invalid_payload" };
  if (typeof p.txHash !== "string" || !p.txHash) return { error: "missing txHash", code: "invalid_payload" };
  if (typeof p.signature !== "string" || !p.signature) return { error: "missing signature", code: "invalid_payload" };
  return {
    scheme: "exact",
    network: "base",
    nonce: p.nonce,
    amountUsdc: p.amountUsdc,
    payerAddress: p.payerAddress,
    txHash: p.txHash,
    signature: p.signature,
  };
}
