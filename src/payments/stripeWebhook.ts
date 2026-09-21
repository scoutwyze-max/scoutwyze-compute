import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Real Stripe webhook signature verification, implemented directly
 * against Stripe's own documented algorithm (not the `stripe` SDK —
 * verification is just HMAC-SHA256 over a specific string, not worth
 * a dependency for). Reference: Stripe's Stripe-Signature header is
 * `t=<unix_seconds>,v1=<hex_hmac>[,v1=<hex_hmac>...]` (multiple v1
 * values exist during secret rotation — any one matching is valid).
 *
 * Signed payload = `${timestamp}.${rawBody}`, HMAC-SHA256 with the
 * webhook signing secret, compared with a constant-time comparison
 * (timingSafeEqual) — NOT `===`, which leaks timing information about
 * how many leading bytes matched and is a real, documented class of
 * attack against naive signature comparison.
 */
const DEFAULT_TOLERANCE_SECONDS = 300; // Stripe's own recommended default

export function verifyStripeSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  secret: string,
  now: number,
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
): { valid: true } | { valid: false; reason: string } {
  if (!signatureHeader) return { valid: false, reason: "missing Stripe-Signature header" };

  const parts = signatureHeader.split(",").map((p) => p.trim());
  const timestampPart = parts.find((p) => p.startsWith("t="));
  const signatureParts = parts.filter((p) => p.startsWith("v1="));

  if (!timestampPart || signatureParts.length === 0) {
    return { valid: false, reason: "malformed Stripe-Signature header" };
  }

  const timestamp = Number(timestampPart.slice(2));
  if (!Number.isFinite(timestamp)) return { valid: false, reason: "malformed timestamp in Stripe-Signature header" };

  const ageSeconds = now / 1000 - timestamp;
  if (ageSeconds > toleranceSeconds) {
    return { valid: false, reason: `webhook timestamp too old (${Math.round(ageSeconds)}s > ${toleranceSeconds}s tolerance) — possible replay` };
  }
  if (ageSeconds < -toleranceSeconds) {
    return { valid: false, reason: "webhook timestamp is in the future beyond tolerance" };
  }

  const signedPayload = `${timestampPart.slice(2)}.${rawBody}`;
  const expected = createHmac("sha256", secret).update(signedPayload).digest("hex");
  const expectedBuf = Buffer.from(expected, "hex");

  const matched = signatureParts.some((part) => {
    const provided = part.slice(3);
    const providedBuf = Buffer.from(provided, "hex");
    // timingSafeEqual throws on length mismatch rather than returning
    // false — a malformed/wrong-length signature must not crash this,
    // it must just fail verification like any other bad signature.
    if (providedBuf.length !== expectedBuf.length) return false;
    return timingSafeEqual(providedBuf, expectedBuf);
  });

  if (!matched) return { valid: false, reason: "signature does not match — payload may have been tampered with, or the wrong secret is configured" };
  return { valid: true };
}

/**
 * V1 scope: only checkout.session.completed is handled — that's the
 * real event a "buy a credit pack" Stripe Checkout integration fires.
 * Metadata contract: the Checkout Session must be created with
 * metadata.accountId set to the ScoutWyze account being funded — that
 * has to be set at Session-creation time (outside this codebase, in
 * whatever front-end/billing-page code creates the Checkout Session),
 * not something this webhook can infer.
 */
export interface StripeTopUpEvent {
  eventId: string;
  accountId: string;
  amountUsd: number;
}

export function parseCheckoutCompletedEvent(rawBody: string): StripeTopUpEvent | { error: string } {
  let event: any;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return { error: "webhook body is not valid JSON" };
  }

  if (typeof event?.id !== "string") return { error: "event missing id" };
  if (event.type !== "checkout.session.completed") {
    return { error: `unhandled event type: ${event?.type ?? "unknown"}` };
  }

  const session = event.data?.object;
  const accountId = session?.metadata?.accountId;
  const amountTotalCents = session?.amount_total;

  if (typeof accountId !== "string" || !accountId) {
    return { error: "checkout session missing metadata.accountId — was the Session created without it?" };
  }
  if (typeof amountTotalCents !== "number" || amountTotalCents <= 0) {
    return { error: "checkout session missing a valid amount_total" };
  }

  return { eventId: event.id, accountId, amountUsd: amountTotalCents / 100 };
}
