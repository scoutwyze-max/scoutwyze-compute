import { describe, expect, it, afterEach } from "vitest";
import { buildTestApp, type TestApp } from "./testApp.js";
import { createTestPayerWallet, buildEip3009Authorization, signEip3009Authorization, encodeX402Payment } from "../helpers/x402TestHelpers.js";
import { encodeUsdcTransferLog, fakeFailedReceipt } from "../helpers/fakeUsdcTransfer.js";

let built: TestApp | undefined;

afterEach(async () => {
  await built?.app.close();
  built = undefined;
});

let txCounter = 0;
function fakeTxHash(): string {
  txCounter += 1;
  return "0x" + txCounter.toString(16).padStart(64, "0");
}

/** Builds a real-shaped X-PAYMENT header: a genuine EIP-712/EIP-3009
 * signature from a genuine (test) wallet, authorizing the exact
 * to/value auth.ts will check. Settlement itself is simulated by the
 * test app's FakeFacilitatorClient (wired in testApp.ts) — this
 * helper only produces the client-side payload, exactly what a real
 * x402 client library would send. */
async function buildPayment(
  app: TestApp,
  params: { amountUsdc: number; to?: string },
  opts: { wallet?: ReturnType<typeof createTestPayerWallet> } = {},
): Promise<string> {
  const wallet = opts.wallet ?? createTestPayerWallet();
  const authorization = buildEip3009Authorization({
    from: wallet.address,
    to: params.to ?? app.treasuryAddress,
    amountUsdc: params.amountUsdc,
  });
  const signature = await signEip3009Authorization(wallet, authorization);
  return encodeX402Payment(authorization, signature);
}

/** Drives the real challenge -> payment -> receipt cycle for a given
 * request body, returning the successful response + issued receipt. */
async function payAndQuote(app: TestApp, body: Record<string, unknown> = {}) {
  const challengeRes = await app.app.inject({ method: "POST", url: "/v1/route/quote", payload: body });
  expect(challengeRes.statusCode).toBe(402);
  const requirements = challengeRes.json().accepts[0];

  const payment = await buildPayment(app, { amountUsdc: Number(requirements.maxAmountRequired) / 1_000_000 });
  const paidRes = await app.app.inject({
    method: "POST",
    url: "/v1/route/quote",
    headers: { "x-payment": payment },
    payload: body,
  });
  return { paidRes, receipt: paidRes.headers["x-payment-receipt"] as string | undefined };
}

describe("dual-rail auth — Primary Path (Bearer)", () => {
  it("rejects requests with no auth at all", async () => {
    built = await buildTestApp();
    const res = await built.app.inject({ method: "POST", url: "/v1/route/quote", payload: {} });
    expect(res.statusCode).toBe(402);
  });

  it("accepts a valid Bearer API key", async () => {
    built = await buildTestApp();
    const res = await built.app.inject({
      method: "POST",
      url: "/v1/route/quote",
      headers: { authorization: `Bearer ${built.apiKey}` },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
  });

  it("an unrecognized Bearer key falls through to the x402 challenge, not a dead-end 401", async () => {
    built = await buildTestApp();
    const res = await built.app.inject({
      method: "POST",
      url: "/v1/route/quote",
      headers: { authorization: "Bearer not_a_real_key" },
      payload: {},
    });
    expect(res.statusCode).toBe(402);
    expect(res.json().accepts[0].payTo).toBeTruthy();
  });

  it("VALIDATE-BEFORE-BILL — a malformed request with NO auth returns 400, not a 402 challenge", async () => {
    // Real bug found while building the credit ledger: schema
    // validation used to run inside the route handler, AFTER the
    // auth/x402 preHandler — meaning a garbage request could still
    // provoke (and on the credit rail, pay for) the auth machinery
    // before ever being rejected. validateQuoteRequest.ts now runs
    // first; this confirms a malformed body never even reaches the
    // point where payment requirements would be issued.
    built = await buildTestApp();
    const res = await built.app.inject({
      method: "POST",
      url: "/v1/route/quote",
      payload: { workload_type: "not_a_real_workload" }, // no auth AND invalid body
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_request");
  });
});

describe("dual-rail auth — Secondary Path (x402), CLAUDE.md §4 — real EIP-3009 exact scheme, 2026-09-26 rewrite", () => {
  it("no credentials at all returns a real 402 with spec-compliant requirements — atomic-unit amount, real payTo, real USDC contract address", async () => {
    built = await buildTestApp();
    const res = await built.app.inject({ method: "POST", url: "/v1/route/quote", payload: {} });

    expect(res.statusCode).toBe(402);
    const body = res.json();
    expect(body.x402Version).toBe(1);
    const requirements = body.accepts[0];
    expect(requirements.scheme).toBe("exact");
    expect(requirements.network).toBe("base");
    expect(requirements.payTo).toBe(built.treasuryAddress);
    // Real x402 spec: atomic units (USDC has 6 decimals), not a human
    // decimal string — a real compliance bug caught and fixed
    // 2026-09-26. CLAUDE.md's $0.10-$0.25+ range, expressed in atomic
    // units: 100000-250000+.
    expect(Number(requirements.maxAmountRequired)).toBeGreaterThanOrEqual(100_000);
    expect(requirements.maxTimeoutSeconds).toBeGreaterThan(0);
    expect(requirements.asset).toMatch(/^0x[a-fA-F0-9]{40}$/); // real contract address, not the string "USDC"
    // Real bug caught live 2026-09-24 while extending x402 onto
    // compute/rank: resource used to be hardcoded regardless of which
    // route issued the challenge. Asserted here on quote's side too,
    // so a future regression can't silently break either route.
    expect(requirements.resource).toBe("/v1/route/quote");
  });

  it("a payment with a real EIP-3009 signature, settled and independently re-verified on-chain, succeeds and returns a signed receipt header", async () => {
    built = await buildTestApp();
    const { paidRes, receipt } = await payAndQuote(built, {});
    expect(paidRes.statusCode).toBe(200);
    expect(receipt).toBeTruthy();
    expect(receipt).toMatch(/^[\w-]+\.[0-9a-f]{64}$/); // base64url payload . hex hmac
  });

  it("REPLAY PROTECTION — settling the same authorization (from+nonce) twice is rejected the second time", async () => {
    built = await buildTestApp();
    const wallet = createTestPayerWallet();
    const authorization = buildEip3009Authorization({ from: wallet.address, to: built.treasuryAddress, amountUsdc: 0.15 });
    const signature = await signEip3009Authorization(wallet, authorization);
    const payment = encodeX402Payment(authorization, signature);

    const first = await built.app.inject({ method: "POST", url: "/v1/route/quote", headers: { "x-payment": payment }, payload: {} });
    expect(first.statusCode).toBe(200);

    // Exact same authorization+signature submitted again — this is
    // what PayAI's own duplicate_settlement detection (backed by the
    // USDC contract's on-chain authorizationState) actually catches.
    const replay = await built.app.inject({ method: "POST", url: "/v1/route/quote", headers: { "x-payment": payment }, payload: {} });
    expect(replay.statusCode).toBe(402);
    expect(replay.json().code).toBe("duplicate_settlement");
  });

  it("DEFENSE IN DEPTH — if a facilitator ever reported the same settled txHash for two different authorizations, this server's own idempotency check still catches it", async () => {
    built = await buildTestApp();
    const sharedTxHash = fakeTxHash();
    const wallet = createTestPayerWallet();
    built.chainReader.setReceipt(sharedTxHash, {
      status: 1,
      logs: [encodeUsdcTransferLog(wallet.address, built.treasuryAddress, 0.15)],
    });

    // First authorization settles to the shared txHash (forced via
    // setNextResult, simulating an edge case the real facilitator
    // itself is supposed to prevent — this test is about OUR
    // defense-in-depth, not re-testing PayAI's own guarantee).
    built.facilitator.setNextResult({ success: true, transaction: sharedTxHash, network: "base", payer: wallet.address });
    const first = await built.app.inject({
      method: "POST",
      url: "/v1/route/quote",
      headers: { "x-payment": await buildPayment(built, { amountUsdc: 0.15 }, { wallet }) },
      payload: {},
    });
    expect(first.statusCode).toBe(200);

    // A second, DIFFERENT authorization that the (broken/malicious)
    // facilitator claims settled to the SAME txHash.
    built.facilitator.setNextResult({ success: true, transaction: sharedTxHash, network: "base", payer: wallet.address });
    const second = await built.app.inject({
      method: "POST",
      url: "/v1/route/quote",
      headers: { "x-payment": await buildPayment(built, { amountUsdc: 0.15 }, { wallet }) },
      payload: {},
    });
    expect(second.statusCode).toBe(402);
    expect(second.json().reason).toMatch(/already been used to authorize a different payment/);
    expect(second.json().code).toBe("duplicate_settlement");
  });

  it("rejects a payment whose signature does not recover to the claimed authorization.from", async () => {
    built = await buildTestApp();
    const signer = createTestPayerWallet();
    const impersonated = createTestPayerWallet(); // authorization CLAIMS this address, but signer actually signed it
    const authorization = buildEip3009Authorization({ from: impersonated.address, to: built.treasuryAddress, amountUsdc: 0.15 });
    const signature = await signEip3009Authorization(signer, authorization);
    const payment = encodeX402Payment(authorization, signature);

    const res = await built.app.inject({ method: "POST", url: "/v1/route/quote", headers: { "x-payment": payment }, payload: {} });
    expect(res.statusCode).toBe(402);
    expect(res.json().reason).toMatch(/signature does not match authorization\.from/);
    expect(res.json().code).toBe("invalid_exact_evm_payload_signature");
  });

  it("rejects a payment whose settlement reverted/failed on-chain, even though the facilitator claimed success", async () => {
    built = await buildTestApp();
    const wallet = createTestPayerWallet();
    const txHash = fakeTxHash();
    built.chainReader.setReceipt(txHash, fakeFailedReceipt([encodeUsdcTransferLog(wallet.address, built.treasuryAddress, 0.15)]));
    built.facilitator.setNextResult({ success: true, transaction: txHash, network: "base", payer: wallet.address });

    const payment = await buildPayment(built, { amountUsdc: 0.15 }, { wallet });
    const res = await built.app.inject({ method: "POST", url: "/v1/route/quote", headers: { "x-payment": payment }, payload: {} });
    expect(res.statusCode).toBe(402);
    expect(res.json().reason).toMatch(/failed\/reverted/);
    expect(res.json().code).toBe("invalid_transaction_state");
  });

  it("rejects a facilitator settlement failure, passing through PayAI's real error vocabulary", async () => {
    built = await buildTestApp();
    built.facilitator.setNextResult({ success: false, transaction: "", network: "base", errorReason: "insufficient_funds", errorMessage: "payer wallet balance too low" });

    const payment = await buildPayment(built, { amountUsdc: 0.15 });
    const res = await built.app.inject({ method: "POST", url: "/v1/route/quote", headers: { "x-payment": payment }, payload: {} });
    expect(res.statusCode).toBe(402);
    expect(res.json().reason).toBe("payer wallet balance too low");
    expect(res.json().code).toBe("insufficient_funds");
  });

  it("rejects a payment PayAI's /verify flags invalid, without ever calling /settle", async () => {
    built = await buildTestApp();
    built.facilitator.setNextVerifyResult({ isValid: false, invalidReason: "invalid_exact_evm_insufficient_balance", payer: "0xdead" });
    built.facilitator.setNextResult({ success: false, transaction: "", network: "base", errorReason: "some_future_code_this_server_has_never_seen" });
    // ^ if settle() were reached despite the verify rejection, this
    // unrelated failure result would leak through and the assertion
    // below would fail — proving verify() short-circuits before settle().

    const payment = await buildPayment(built, { amountUsdc: 0.15 });
    const res = await built.app.inject({ method: "POST", url: "/v1/route/quote", headers: { "x-payment": payment }, payload: {} });
    expect(res.statusCode).toBe(402);
    expect(res.json().code).toBe("invalid_exact_evm_insufficient_balance");
  });

  it("an unrecognized/malformed facilitator error code doesn't leak through as if it were a known one", async () => {
    built = await buildTestApp();
    built.facilitator.setNextResult({ success: false, transaction: "", network: "base", errorReason: "some_future_code_this_server_has_never_seen" });

    const payment = await buildPayment(built, { amountUsdc: 0.15 });
    const res = await built.app.inject({ method: "POST", url: "/v1/route/quote", headers: { "x-payment": payment }, payload: {} });
    expect(res.statusCode).toBe(402);
    expect(res.json().code).toBe("unexpected_verify_error");
  });

  it("rejects a payment whose real transfer sent USDC to the wrong address (not our treasury) — checked BEFORE ever calling the facilitator", async () => {
    built = await buildTestApp();
    const notOurTreasury = createTestPayerWallet().address;
    const payment = await buildPayment(built, { amountUsdc: 0.15, to: notOurTreasury });

    const res = await built.app.inject({ method: "POST", url: "/v1/route/quote", headers: { "x-payment": payment }, payload: {} });
    expect(res.statusCode).toBe(402);
    expect(res.json().reason).toMatch(/does not match our treasury address/);
    expect(res.json().code).toBe("invalid_exact_evm_payload_recipient_mismatch");
  });

  it("rejects a payment amount below the required minimum — checked BEFORE ever calling the facilitator", async () => {
    built = await buildTestApp();
    const payment = await buildPayment(built, { amountUsdc: 0.01 });
    const res = await built.app.inject({ method: "POST", url: "/v1/route/quote", headers: { "x-payment": payment }, payload: {} });
    expect(res.statusCode).toBe(402);
    expect(res.json().reason).toMatch(/below the required/);
    expect(res.json().code).toBe("invalid_exact_evm_payload_authorization_value_mismatch");
  });

  it("rejects an authorization that's already expired (validBefore in the past)", async () => {
    built = await buildTestApp();
    const wallet = createTestPayerWallet();
    const authorization = buildEip3009Authorization({
      from: wallet.address,
      to: built.treasuryAddress,
      amountUsdc: 0.15,
      validAfterOffsetSeconds: -3600,
      validBeforeOffsetSeconds: -60,
    });
    const signature = await signEip3009Authorization(wallet, authorization);
    const payment = encodeX402Payment(authorization, signature);

    const res = await built.app.inject({ method: "POST", url: "/v1/route/quote", headers: { "x-payment": payment }, payload: {} });
    expect(res.statusCode).toBe(402);
    expect(res.json().code).toBe("invalid_exact_evm_payload_authorization_valid_before");
  });

  it("rejects a payment on the wrong network", async () => {
    built = await buildTestApp();
    const submission = {
      x402Version: 1,
      scheme: "exact",
      network: "ethereum",
      payload: {
        signature: "0xnotarealsignature",
        authorization: {
          from: "0x0000000000000000000000000000000000dEaD",
          to: built.treasuryAddress,
          value: "150000",
          validAfter: "0",
          validBefore: "9999999999",
          nonce: "0x" + "11".repeat(32),
        },
      },
    };
    const res = await built.app.inject({
      method: "POST",
      url: "/v1/route/quote",
      headers: { "x-payment": Buffer.from(JSON.stringify(submission)).toString("base64") },
      payload: {},
    });
    expect(res.statusCode).toBe(402);
    expect(res.json().code).toBe("invalid_payload");
  });

  it("rejects a garbled (non-base64/non-JSON) X-PAYMENT header", async () => {
    built = await buildTestApp();
    const res = await built.app.inject({
      method: "POST",
      url: "/v1/route/quote",
      headers: { "x-payment": "not-valid-base64-json" },
      payload: {},
    });
    expect(res.statusCode).toBe(402);
    expect(res.json().code).toBe("invalid_payload");
  });

  it("RECEIPT REUSE — the same receipt authorizes a second identical request within its TTL, no new payment required", async () => {
    built = await buildTestApp();
    const body = { region: "us-east-1" };
    const { paidRes, receipt } = await payAndQuote(built, body);
    expect(paidRes.statusCode).toBe(200);

    const secondRes = await built.app.inject({
      method: "POST",
      url: "/v1/route/quote",
      headers: { "x-payment-receipt": receipt! },
      payload: body, // identical request body
    });
    expect(secondRes.statusCode).toBe(200);
  });

  it("ANTI-SCRAPING — the same receipt does NOT authorize a request with different parameters", async () => {
    built = await buildTestApp();
    const { paidRes, receipt } = await payAndQuote(built, { region: "us-east-1" });
    expect(paidRes.statusCode).toBe(200);

    const differentQueryRes = await built.app.inject({
      method: "POST",
      url: "/v1/route/quote",
      headers: { "x-payment-receipt": receipt! },
      payload: { region: "us-west-1" }, // DIFFERENT request — must not ride the same payment
    });
    expect(differentQueryRes.statusCode).toBe(402); // falls through to a fresh challenge, not a free pass
  });

  it("a corrupted/tampered receipt is rejected, not trusted", async () => {
    built = await buildTestApp();
    const { receipt } = await payAndQuote(built, {});
    const tampered = receipt!.slice(0, -4) + "beef"; // flip the trailing signature bytes

    const res = await built.app.inject({
      method: "POST",
      url: "/v1/route/quote",
      headers: { "x-payment-receipt": tampered },
      payload: {},
    });
    expect(res.statusCode).toBe(402); // falls through to needing fresh payment
  });
});
