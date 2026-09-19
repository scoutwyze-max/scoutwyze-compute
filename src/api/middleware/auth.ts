import type { FastifyReply, FastifyRequest } from "fastify";
import { verifyX402PaymentMock } from "./x402.js";

export type AuthRail = "bearer" | "x402";

export interface AuthContext {
  rail: AuthRail;
  identifier: string; // API key (bearer) or payer claim summary (x402) — never logged raw
}

declare module "fastify" {
  interface FastifyRequest {
    authContext?: AuthContext;
  }
}

/**
 * CLAUDE.md §4 Dual-Rail — Bearer API keys (conventional, prepaid
 * credits) OR x402/USDC (machine-native). Either rail is sufficient;
 * this is deliberately an OR, not a chain where one blocks the other.
 */
export function createAuthMiddleware(validApiKeys: Set<string>) {
  return async function authMiddleware(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const authHeader = request.headers["authorization"];
    if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
      const key = authHeader.slice("Bearer ".length).trim();
      if (validApiKeys.has(key)) {
        request.authContext = { rail: "bearer", identifier: key };
        return;
      }
      // Bearer header present but invalid — fall through to x402 rather
      // than reject immediately, in case a client sends both headers.
    }

    const paymentHeader = request.headers["x-payment"];
    const x402Result = verifyX402PaymentMock(
      typeof paymentHeader === "string" ? paymentHeader : undefined,
    );
    if (x402Result.valid && x402Result.claim) {
      request.authContext = { rail: "x402", identifier: x402Result.claim.payload.slice(0, 12) };
      return;
    }

    reply.code(401).send({
      error: "unauthorized",
      message: "Provide a valid Authorization: Bearer <api_key> header or a valid X-PAYMENT header.",
    });
  };
}
