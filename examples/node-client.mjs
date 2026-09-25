#!/usr/bin/env node
// Copy-pasteable Node.js client for ScoutWyze Compute — dual-rail
// (Bearer or x402/USDC-on-Base), targeting the flagship POST
// /v1/compute/rank envelope.
//
// npm install ethers
//
// 2026-09-26: rewritten for the real x402 "exact" EVM scheme
// (EIP-3009 transferWithAuthorization) — the previous version of this
// file had the payer broadcast their own on-chain transfer and prove
// it after the fact, a self-invented flow no standard x402 client
// speaks. The real scheme is actually SIMPLER for the payer: sign an
// authorization, submit it, done. No RPC connection, no gas, no ETH
// needed at all — this server's own facilitator (PayAI) broadcasts
// the transaction and pays gas.
//
// Usage as a CLI:
//   node node-client.mjs bearer <apiKey> [gpuClass]
//   node node-client.mjs x402 <privateKey> [gpuClass]
//
// Usage as a library:
//   import { rankViaBearer, rankViaX402 } from "./node-client.mjs";

import { ethers } from "ethers";

const DEFAULT_BASE_URL = "https://scoutwyze-compute.fly.dev";

// Real EIP-712 domain for Base USDC's EIP-3009 implementation —
// name/version verified 2026-09-26 by calling the real contract's
// name()/version() getters on Base mainnet and independently
// re-deriving the domain separator hash to confirm it matches the
// contract's own DOMAIN_SEPARATOR() return value exactly (see the
// server's src/payments/baseVerification.ts for the same verification
// with the full citation). chainId/verifyingContract come from the
// server's own PaymentRequirements (requirements.asset) rather than a
// second hardcoded constant here, so this client can never drift out
// of sync with what the server actually verifies against.
const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

/** Rail 1 — prepaid Bearer key. A human funds the account once
 * (POST /v1/signup + POST /v1/checkout-sessions); from then on this
 * is a single unauthenticated-looking call with zero further human
 * involvement. */
export async function rankViaBearer(baseUrl, apiKey, params = {}) {
  const res = await fetch(`${baseUrl}/v1/compute/rank`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(params),
  });
  return { status: res.status, body: await res.json() };
}

/** Rail 2 — x402/USDC on Base, real "exact" EVM scheme. Zero human
 * involvement, ever, and — as of this rewrite — zero ETH needed
 * either: this server's facilitator (PayAI) broadcasts the settlement
 * and pays gas. `privateKey` only ever signs a message; it's never
 * used to send a transaction from this client. */
export async function rankViaX402(baseUrl, privateKey, params = {}) {
  const challengeRes = await fetch(`${baseUrl}/v1/compute/rank`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  });
  if (challengeRes.status !== 402) {
    // Already paid via a reused receipt, or something else entirely —
    // either way there's no payment requirements to act on.
    return { status: challengeRes.status, body: await challengeRes.json() };
  }
  const challengeBody = await challengeRes.json();
  const requirements = challengeBody.accepts[0];

  const wallet = new ethers.Wallet(privateKey); // no provider — this client never reads or writes the chain itself
  const now = Math.floor(Date.now() / 1000);
  const authorization = {
    from: wallet.address,
    to: requirements.payTo,
    value: requirements.maxAmountRequired, // already atomic units, per the real x402 spec
    validAfter: String(now - 60),
    validBefore: String(now + requirements.maxTimeoutSeconds),
    nonce: ethers.hexlify(ethers.randomBytes(32)),
  };
  // Domain name/version come from the server's own advertised
  // requirements.extra (found live 2026-09-26: PayAI's /settle
  // rejects a signature made under an unadvertised domain with
  // invalid_exact_evm_missing_eip712_domain) — never hardcode these
  // independently of what the seller actually declared.
  const domain = { name: requirements.extra.name, version: requirements.extra.version, chainId: 8453, verifyingContract: requirements.asset };
  const signature = await wallet.signTypedData(domain, EIP3009_TYPES, {
    from: authorization.from,
    to: authorization.to,
    value: BigInt(authorization.value),
    validAfter: BigInt(authorization.validAfter),
    validBefore: BigInt(authorization.validBefore),
    nonce: authorization.nonce,
  });

  const submission = { x402Version: 1, scheme: "exact", network: "base", payload: { signature, authorization } };
  const paymentHeader = Buffer.from(JSON.stringify(submission)).toString("base64");

  const paidRes = await fetch(`${baseUrl}/v1/compute/rank`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-payment": paymentHeader },
    body: JSON.stringify(params),
  });
  return { status: paidRes.status, body: await paidRes.json() };
}

// --- CLI entrypoint ---
if (import.meta.url === `file://${process.argv[1]}`) {
  const [rail, credential, gpuClass] = process.argv.slice(2);
  const baseUrl = DEFAULT_BASE_URL;
  const params = gpuClass ? { gpuClass, preference: "cheapest" } : { preference: "cheapest" };

  if (rail === "bearer" && credential) {
    const result = await rankViaBearer(baseUrl, credential, params);
    console.log(JSON.stringify(result, null, 2));
  } else if (rail === "x402" && credential) {
    const result = await rankViaX402(baseUrl, credential, params);
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.error("Usage:");
    console.error("  node node-client.mjs bearer <apiKey> [gpuClass]");
    console.error("  node node-client.mjs x402 <privateKey> [gpuClass]");
    process.exit(1);
  }
}
