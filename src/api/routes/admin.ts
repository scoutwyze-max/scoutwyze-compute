import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { ApiKeyStore } from "../../billing/apiKeyStore.js";
import type { CreditLedger } from "../../billing/creditLedger.js";

/** Shared by admin.ts and adminConsole.ts — the ONE place the raw
 * X-Admin-Secret is ever compared, so a future change to how it's
 * checked (like the constant-time fix below) can't drift between the
 * two call sites. Constant-time comparison — a naive !== leaks timing
 * info about how many leading bytes matched, same reasoning as
 * x402.ts's verifyReceiptToken and admin/session.ts's verify(). */
export function checkAdminSecret(provided: unknown, adminSecret: string): boolean {
  if (typeof provided !== "string") return false;
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(adminSecret);
  return providedBuf.length === expectedBuf.length && timingSafeEqual(providedBuf, expectedBuf);
}

export interface AdminRouteDeps {
  apiKeyStore: ApiKeyStore;
  creditLedger: CreditLedger;
  adminSecret: string;
}

/**
 * Minimal operational-readiness surface: without SOME way to actually
 * issue a key and fund it, ApiKeyStore/CreditLedger are correct but
 * unusable — nobody could ever get a working Bearer key. Gated behind
 * a separate shared secret (X-Admin-Secret), deliberately NOT the same
 * credential space as customer API keys — a leaked customer key must
 * never be enough to mint more keys or credit for itself.
 *
 * V1 scope: a shared secret, not per-admin identity/audit trail. Real
 * gap, not hidden — fine for a single-operator V1, not fine once more
 * than one person needs admin access.
 */
export function registerAdminRoutes(app: FastifyInstance, deps: AdminRouteDeps): void {
  const requireAdmin = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!checkAdminSecret(request.headers["x-admin-secret"], deps.adminSecret)) {
      reply.code(401).send({ error: "unauthorized", message: "Missing or invalid X-Admin-Secret header." });
    }
  };

  const CreateKeyBody = z.object({ accountId: z.string().min(1) });
  app.post("/v1/admin/api-keys", { preHandler: requireAdmin }, async (request, reply) => {
    const parsed = CreateKeyBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", details: parsed.error.issues });

    const { rawKey, record } = deps.apiKeyStore.create(parsed.data.accountId);
    return reply.code(201).send({
      keyId: record.keyId,
      accountId: record.accountId,
      apiKey: rawKey, // shown exactly once — never retrievable again
      createdAt: record.createdAt,
    });
  });

  const RevokeKeyParams = z.object({ keyId: z.string().min(1) });
  app.post("/v1/admin/api-keys/:keyId/revoke", { preHandler: requireAdmin }, async (request, reply) => {
    const parsed = RevokeKeyParams.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", details: parsed.error.issues });

    const revoked = deps.apiKeyStore.revoke(parsed.data.keyId);
    if (!revoked) return reply.code(404).send({ error: "not_found", message: "No API key with that keyId." });
    return reply.code(200).send({ revoked: true, keyId: parsed.data.keyId });
  });

  const TopUpParams = z.object({ accountId: z.string().min(1) });
  const TopUpBody = z.object({ amountUsd: z.number().positive() });
  app.post("/v1/admin/accounts/:accountId/credits", { preHandler: requireAdmin }, async (request, reply) => {
    const params = TopUpParams.safeParse(request.params);
    const body = TopUpBody.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: "invalid_request", details: [...(params.success ? [] : params.error.issues), ...(body.success ? [] : body.error.issues)] });
    }

    const entry = deps.creditLedger.topUp(params.data.accountId, body.data.amountUsd);
    return reply.code(200).send(entry);
  });

  const LedgerParams = z.object({ accountId: z.string().min(1) });
  app.get("/v1/admin/accounts/:accountId/ledger", { preHandler: requireAdmin }, async (request, reply) => {
    const params = LedgerParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_request", details: params.error.issues });

    return reply.code(200).send({
      accountId: params.data.accountId,
      balanceUsd: deps.creditLedger.getBalance(params.data.accountId),
      entries: deps.creditLedger.getLedger(params.data.accountId),
    });
  });
}
