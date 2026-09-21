import type { FastifyInstance } from "fastify";
import type { CreditLedger } from "../../billing/creditLedger.js";
import { ProcessedEventStore } from "../../payments/processedEvents.js";
import { parseCheckoutCompletedEvent, verifyStripeSignature } from "../../payments/stripeWebhook.js";
import type Database from "better-sqlite3";

export interface StripeWebhookDeps {
  db: Database.Database;
  creditLedger: CreditLedger;
  webhookSecret: string;
}

/**
 * POST /v1/webhooks/stripe — real Stripe signature verification, real
 * idempotency, then a direct CreditLedger.topUp() call. This is the
 * only route in the app that needs the RAW request body (signature
 * verification is over the exact bytes Stripe signed, not a
 * re-serialized JSON.stringify of a parsed object, which can differ in
 * key order/whitespace and would break verification) — scoped to a
 * child plugin context so only this route skips normal JSON parsing;
 * every other route is unaffected.
 */
export function registerStripeWebhookRoute(app: FastifyInstance, deps: StripeWebhookDeps): void {
  const processedEvents = new ProcessedEventStore(deps.db);

  app.register(async (scoped) => {
    scoped.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) => {
      done(null, body); // deliberately NOT parsed — signature verification needs the raw bytes
    });

    scoped.post("/v1/webhooks/stripe", async (request, reply) => {
      const rawBody = (request.body as Buffer).toString("utf-8");
      const signatureHeader = request.headers["stripe-signature"];

      const verification = verifyStripeSignature(
        rawBody,
        typeof signatureHeader === "string" ? signatureHeader : undefined,
        deps.webhookSecret,
        Date.now(),
      );
      if (!verification.valid) {
        // 400, not 200 — Stripe's own guidance: reject invalid
        // signatures outright rather than silently no-op-200ing them,
        // so a real misconfiguration is loud, not silent.
        return reply.code(400).send({ error: "invalid_signature", reason: verification.reason });
      }

      const parsed = parseCheckoutCompletedEvent(rawBody);
      if ("error" in parsed) {
        // A validly-signed event we don't act on (wrong type, missing
        // metadata) is still a 200 — Stripe should not keep retrying a
        // webhook that will never become actionable no matter how many
        // times it's redelivered.
        return reply.code(200).send({ received: true, action: "ignored", reason: parsed.error });
      }

      const { recorded } = processedEvents.recordIfNew(parsed.eventId, "stripe", parsed.accountId, parsed.amountUsd);
      if (!recorded) {
        // Real retry of an event we already credited — 200, no
        // double-charge. This is the actual idempotency guarantee.
        return reply.code(200).send({ received: true, action: "duplicate_ignored" });
      }

      const entry = deps.creditLedger.topUp(parsed.accountId, parsed.amountUsd);
      return reply.code(200).send({ received: true, action: "credited", entry });
    });
  });
}
