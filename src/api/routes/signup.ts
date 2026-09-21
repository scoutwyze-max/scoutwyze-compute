import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ApiKeyStore } from "../../billing/apiKeyStore.js";
import { CREDIT_PACKS, type CheckoutSessionCreator } from "../../payments/stripeCheckout.js";

export interface SignupRouteDeps {
  apiKeyStore: ApiKeyStore;
  checkoutSessionCreator: CheckoutSessionCreator;
  checkoutSuccessUrl: string;
  checkoutCancelUrl: string;
}

/**
 * Self-serve onboarding: POST /v1/signup to get an account + API key,
 * then POST /v1/checkout-sessions to fund it with a real credit pack.
 * Both are deliberately unauthenticated — that's the whole point of
 * onboarding, an agent/user has no credential yet when it calls these.
 *
 * V1 scope, real gap not hidden (same posture as admin.ts's own
 * shared-secret note): no abuse throttling on either route yet — a
 * script could spam /v1/signup for free keys, or spam
 * /v1/checkout-sessions to create unused Stripe sessions. Neither is
 * exploitable for free credits (funding still requires a real Stripe
 * payment), just an operational/cost nuisance to revisit before scale.
 */
export function registerSignupRoute(app: FastifyInstance, deps: SignupRouteDeps): void {
  app.post("/v1/signup", async (_request, reply) => {
    // Deliberately NOT accepting a caller-supplied accountId.
    // ApiKeyStore.create(accountId) attaches a brand-new, immediately-
    // usable key to WHATEVER accountId it's given, upserting that
    // account if it doesn't exist yet (see apiKeyStore.ts). On an
    // unauthenticated endpoint, letting a caller choose an existing
    // accountId would mean anyone who knows or guesses another
    // account's id can mint themselves a live key against that
    // account's real credit balance. The server always generates a
    // fresh, random id instead — the same reasoning Stripe/GitHub/etc.
    // use for account/customer ids.
    const accountId = `acct_${randomUUID()}`;
    const { rawKey, record } = deps.apiKeyStore.create(accountId);
    return reply.code(201).send({
      accountId: record.accountId,
      apiKey: rawKey, // shown exactly once — store it now, it can't be retrieved again
      createdAt: record.createdAt,
      creditPacks: CREDIT_PACKS,
    });
  });

  const CheckoutBody = z.object({ accountId: z.string().min(1), packId: z.string().min(1) });
  app.post("/v1/checkout-sessions", async (request, reply) => {
    const parsed = CheckoutBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", details: parsed.error.issues });

    const pack = CREDIT_PACKS.find((p) => p.id === parsed.data.packId);
    if (!pack) {
      return reply.code(400).send({
        error: "invalid_request",
        message: `Unknown packId. Valid packs: ${CREDIT_PACKS.map((p) => p.id).join(", ")}`,
      });
    }

    try {
      const session = await deps.checkoutSessionCreator.createCheckoutSession({
        accountId: parsed.data.accountId,
        amountUsd: pack.amountUsd,
        packLabel: pack.label,
        successUrl: deps.checkoutSuccessUrl,
        cancelUrl: deps.checkoutCancelUrl,
      });
      return reply.code(201).send({ checkoutUrl: session.url, sessionId: session.id });
    } catch (err) {
      // A real Stripe API failure (bad secret key, network issue) — not
      // the caller's fault, so 502, not 400/500.
      return reply.code(502).send({
        error: "checkout_session_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
