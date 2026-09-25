import { createHmac, timingSafeEqual } from "node:crypto";
import { createHash } from "node:crypto";

/**
 * CLAUDE.md §4 Secondary Path — x402 protocol / USDC on Base.
 *
 * 2026-09-26 rewrite: the payment SUBMISSION shape here is now the
 * real x402 "exact" EVM scheme (EIP-3009 transferWithAuthorization) —
 * verified against coinbase/x402's own spec and independently
 * cross-checked against a live on-chain call to the real USDC
 * contract (see payments/baseVerification.ts's TRANSFER_WITH_
 * AUTHORIZATION_TYPEHASH comment for that verification). The PREVIOUS
 * version of this file had our server advertise `scheme: "exact"`
 * while actually implementing a self-invented "broadcast your own
 * transfer, then prove it with an EIP-191 message" flow no real x402
 * client speaks — a real, live bug found and fixed 2026-09-26, not a
 * style preference. A genuine x402-native agent using off-the-shelf
 * client tooling could never have paid us before this change.
 *
 * Consequence: this server no longer pre-issues and tracks its own
 * payment nonce (the old ChallengeStore.issue/consume dance). The
 * real spec doesn't have that concept — replay protection for the
 * payment itself is the EIP-3009 authorization's own nonce, enforced
 * on-chain by the USDC contract's own authorizationState mapping, not
 * something a resource server pre-issues. What we DO still track
 * locally: idempotency (has this exact authorization nonce already
 * been used to settle a DIFFERENT request) via processedEvents, same
 * defense-in-depth reasoning as before — the on-chain contract
 * eventually prevents double-spend too, but checking locally first
 * avoids a race where two requests both reach PayAI's /settle before
 * either is mined.
 *
 * Settlement itself (broadcasting transferWithAuthorization) is
 * delegated to PayAI's facilitator (payments/payAiFacilitator.ts) —
 * this server verifies the signature and bounds itself first
 * (trust-minimized, matches this codebase's existing posture), then
 * uses PayAI only for the one thing it can't do without running its
 * own funded relayer wallet: the actual broadcast. Real settlements
 * flowing through a Bazaar-participating facilitator is also what
 * makes this endpoint discoverable in the x402 Bazaar/Agentic.Market
 * (see SOT.md §6) — a side effect of this same change, not separate
 * work.
 */

export const MIN_ROUTE_PRICE_USDC = 0.1;
export const MAX_ROUTE_PRICE_USDC = 0.25;
export const DEFAULT_ROUTE_PRICE_USDC = 0.15;

// USDC's real decimals (6) — must match baseVerification.ts's own
// USDC_DECIMALS constant exactly; duplicated rather than imported
// since this file deliberately has zero dependency on ethers/chain
// code (pure JSON shaping only).
const USDC_ATOMIC_DECIMALS = 6;

// How long a payer's signed authorization is valid for, from the
// moment we issue payment requirements — encoded into the
// maxTimeoutSeconds we advertise AND checked against the payer's own
// validAfter/validBefore bounds at verification time.
export const CHALLENGE_TTL_SECONDS = 120;

// CLAUDE.md-specified "60s quote TTL bound to the request hash" — how
// long a successful payment's receipt can be reused (e.g. for a client
// retry) before requiring fresh payment again.
export const RECEIPT_TTL_SECONDS = 60;

const RECEIPT_SIGNING_SECRET = process.env.X402_RECEIPT_SIGNING_SECRET || "dev-only-insecure-default-secret";

/**
 * Machine-parseable failure codes for a rejected payment attempt —
 * real x402/PayAI spec vocabulary where it applies (verified directly
 * against both coinbase/x402's spec AND PayAI's own live OpenAPI
 * description, payai.network/openapi.json, 2026-09-26 — PayAI's
 * VerifyResponse.invalidReason / SettleResponse.errorReason use this
 * same vocabulary, plus a few PayAI-specific additions folded in
 * below since we now proxy their settlement errors through). The
 * "unexpected_verify_error" / two others below remain ours: an
 * internal-fault code for our own bugs, distinct from a claim about
 * the client's payload.
 */
export type X402ErrorCode =
  // Our own local checks (signature, bounds, on-chain re-verification)
  | "invalid_payload"
  | "invalid_exact_evm_payload_signature"
  | "invalid_exact_evm_payload_authorization_value_mismatch"
  | "invalid_exact_evm_payload_authorization_valid_after"
  | "invalid_exact_evm_payload_authorization_valid_before"
  | "invalid_exact_evm_payload_recipient_mismatch"
  | "invalid_transaction_state"
  | "unexpected_verify_error"
  // Proxied through verbatim from PayAI's SettleResponse.errorReason —
  // full documented vocabulary, payai.network/openapi.json, 2026-09-26.
  // Passed through rather than force-mapped onto our own codes above:
  // e.g. "insufficient_funds" means the payer's wallet balance was too
  // low, a genuinely different failure than any of ours.
  | "invalid_payment_requirements"
  | "invalid_network"
  | "invalid_scheme"
  | "insufficient_funds"
  | "insufficient_balance"
  // Real, more specific scheme-prefixed codes actually observed from
  // PayAI's live /settle endpoint 2026-09-26 (their OpenAPI's error
  // examples list wasn't exhaustive — "Handle unknown values" is
  // their own explicit guidance, and these two are exactly the case:
  // undocumented in the schema, real in production).
  | "invalid_exact_evm_missing_eip712_domain"
  | "invalid_exact_evm_insufficient_balance"
  | "missing_fee_payer"
  | "missing_facilitator_address"
  | "fee_payer_not_managed_by_facilitator"
  | "facilitator_address_not_managed_by_facilitator"
  | "internal_server_error"
  | "settlement_pending"
  | "duplicate_settlement"
  | "upto_channel_capacity_exhausted"
  | "service_unavailable";

/**
 * x402 v1 PaymentRequirements — real shape, verified against PayAI's
 * live OpenAPI PaymentRequirementsV1 schema 2026-09-26. `asset` is the
 * real ERC-20 CONTRACT ADDRESS (not the string "USDC", which the
 * previous version of this file sent — a real spec-compliance bug:
 * `asset` per the spec is "Token contract address (EVM)... or mint
 * address (Solana)"). `maxTimeoutSeconds` is a duration, not the
 * absolute `expiresAt` timestamp this file used to send — also fixed.
 *
 * `extra.name`/`extra.version` are the token's EIP-712 domain name/
 * version — found live 2026-09-26, not documented in PayAI's OpenAPI
 * schema's `extra` description or field list: a real settle attempt
 * without them fails with `invalid_exact_evm_missing_eip712_domain`.
 * chainId/verifyingContract are NOT duplicated here — those come from
 * `network`/`asset` above, which the facilitator already has.
 */
export interface X402PaymentRequirements {
  scheme: "exact";
  network: "base";
  maxAmountRequired: string;
  resource: string;
  description?: string;
  mimeType?: string;
  payTo: string;
  asset: string;
  maxTimeoutSeconds: number;
  extra: { name: string; version: string };
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

/**
 * Builds real x402 v1 PaymentRequirements — no DB, no pre-issued
 * nonce, nothing to consume. Renamed conceptually from the old
 * "ChallengeStore" (kept as a class for minimal disruption to
 * dependency wiring across index.ts/routes, but it no longer stores
 * anything — see this file's top-of-file comment for why).
 */
export class ChallengeStore {
  constructor(
    // treasuryAddress is real, not a secret — it's the address clients
    // are TOLD to pay, publicly advertised in every 402 response, same
    // as any receiving address.
    private readonly treasuryAddress: string,
    private readonly usdcContractAddress: string,
  ) {}

  issue(amountUsdc: number, resource: string): X402PaymentRequirements {
    // maxAmountRequired: atomic units, integer string — verified
    // 2026-09-26 directly against coinbase/x402's spec text ("Required
    // payment amount in atomic token units", example "10000" = 0.10
    // USDC) and independently against PayAI's own live OpenAPI
    // description. This server previously sent human-decimal strings
    // like "0.15" here — a real spec-compliance bug caught and fixed
    // in this same pass, not assumed correct from an earlier claim.
    const atomicAmount = Math.round(amountUsdc * 10 ** USDC_ATOMIC_DECIMALS).toString();
    return {
      scheme: "exact",
      network: "base",
      maxAmountRequired: atomicAmount,
      resource,
      payTo: this.treasuryAddress,
      asset: this.usdcContractAddress,
      maxTimeoutSeconds: CHALLENGE_TTL_SECONDS,
      // Real Base USDC EIP-712 domain name/version — verified 2026-09-26
      // against the contract's own name()/version() getters, same
      // verification as baseVerification.ts's EIP3009_DOMAIN.
      extra: { name: "USD Coin", version: "2" },
    };
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

/** Real HMAC-SHA256 signing of a real, on-chain-settled payment's
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

/** Real x402 "exact" EVM scheme EIP-3009 authorization — field names
 * and structure verified against coinbase/x402's spec AND PayAI's
 * live OpenAPI description, 2026-09-26. `value`/`validAfter`/
 * `validBefore` are decimal strings (atomic units / unix seconds) per
 * the spec's own convention, not numbers. */
export interface Eip3009Authorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}

export interface X402PaymentSubmission {
  x402Version: 1;
  scheme: "exact";
  network: "base";
  payload: {
    signature: string;
    authorization: Eip3009Authorization;
  };
}

function isEip3009Authorization(value: unknown): value is Eip3009Authorization {
  if (typeof value !== "object" || value === null) return false;
  const a = value as Partial<Eip3009Authorization>;
  return (
    typeof a.from === "string" &&
    typeof a.to === "string" &&
    typeof a.value === "string" &&
    typeof a.validAfter === "string" &&
    typeof a.validBefore === "string" &&
    typeof a.nonce === "string"
  );
}

export function decodePaymentHeader(
  headerValue: string | undefined,
): X402PaymentSubmission | { error: string; code?: X402ErrorCode } {
  // No code here, deliberately: an absent header is the normal
  // first-contact case — an agent's opening request, before it has
  // anything to submit — not a rejected payload.
  if (!headerValue) return { error: "missing X-PAYMENT header" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(headerValue, "base64").toString("utf-8"));
  } catch {
    return { error: "X-PAYMENT header is not valid base64-encoded JSON", code: "invalid_payload" };
  }
  const p = parsed as Partial<X402PaymentSubmission>;
  if (p.x402Version !== 1) return { error: "unsupported x402Version — this server speaks x402Version 1", code: "invalid_payload" };
  if (p.scheme !== "exact" || p.network !== "base") return { error: "unsupported payment scheme/network", code: "invalid_payload" };
  if (typeof p.payload !== "object" || p.payload === null) return { error: "missing payload", code: "invalid_payload" };
  const payload = p.payload as Partial<{ signature: string; authorization: unknown }>;
  if (typeof payload.signature !== "string" || !payload.signature) return { error: "missing payload.signature", code: "invalid_payload" };
  if (!isEip3009Authorization(payload.authorization)) {
    return { error: "missing or malformed payload.authorization (need from/to/value/validAfter/validBefore/nonce)", code: "invalid_payload" };
  }
  return {
    x402Version: 1,
    scheme: "exact",
    network: "base",
    payload: { signature: payload.signature, authorization: payload.authorization },
  };
}
