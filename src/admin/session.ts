import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * Stateless signed session cookie for the admin console (2026-09-24,
 * Robert: "yes to the HttpOnly cookie for admin auth — let's secure
 * it"). Same HMAC-sign-and-verify shape as x402.ts's receipt tokens —
 * no new sessions table, no new secret to provision: the browser gets
 * this cookie once, from POST /v1/admin/session (which still checks
 * the real X-Admin-Secret), and never touches the raw admin secret
 * again after that. Single shared-secret model preserved on purpose —
 * this replaces "the raw secret sits in every browser request" with
 * "a short-lived, signed, HttpOnly token does," not with per-admin
 * identity (still out of scope, same as admin.ts's own documented V1
 * limit).
 */
export const ADMIN_SESSION_COOKIE_NAME = "sw_admin_session";
const ADMIN_SESSION_TTL_SECONDS = 12 * 60 * 60; // 12h — long enough for a working session, short enough that a leaked cookie doesn't stay valid indefinitely

interface SessionPayload {
  issuedAtMs: number;
  expiresAtMs: number;
}

function sign(payload: SessionPayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(body).digest("hex");
  return `${body}.${signature}`;
}

function verify(token: string, secret: string, now: number): boolean {
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [body, signature] = parts as [string, string];

  const expected = createHmac("sha256", secret).update(body).digest("hex");
  const expectedBuf = Buffer.from(expected, "hex");
  const providedBuf = Buffer.from(signature, "hex");
  // Constant-time comparison — same reasoning as x402.ts's
  // verifyReceiptToken: a naive !== leaks timing info about how many
  // leading bytes matched.
  if (providedBuf.length !== expectedBuf.length || !timingSafeEqual(providedBuf, expectedBuf)) return false;

  let payload: SessionPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf-8"));
  } catch {
    return false;
  }
  return now <= payload.expiresAtMs;
}

export function issueSessionCookie(adminSecret: string, now: number = Date.now()): string {
  const token = sign({ issuedAtMs: now, expiresAtMs: now + ADMIN_SESSION_TTL_SECONDS * 1000 }, adminSecret);
  return `${ADMIN_SESSION_COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${ADMIN_SESSION_TTL_SECONDS}`;
}

export function clearSessionCookie(): string {
  return `${ADMIN_SESSION_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

function readCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

/** Fastify preHandler — 401s unless a valid, unexpired session cookie
 * is present. Never accepts X-Admin-Secret as a fallback here; that
 * header is only for the one login route that issues this cookie. */
export function createRequireAdminSession(adminSecret: string) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const token = readCookie(request.headers.cookie, ADMIN_SESSION_COOKIE_NAME);
    if (!token || !verify(token, adminSecret, Date.now())) {
      reply.code(401).send({ error: "unauthorized", message: "Missing or expired admin session — log in again." });
    }
  };
}

/** Boolean form for the page route (adminConsolePage.ts), which needs
 * to choose between rendering a login form or the dashboard, not just
 * hard-401 a browser visit the way the API preHandler above does. */
export function hasValidSession(request: FastifyRequest, adminSecret: string): boolean {
  const token = readCookie(request.headers.cookie, ADMIN_SESSION_COOKIE_NAME);
  return !!token && verify(token, adminSecret, Date.now());
}
