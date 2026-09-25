import { describe, expect, it, afterEach } from "vitest";
import { buildTestApp, type TestApp } from "./testApp.js";
import { createTestPayerWallet, signPaymentAuthorization, encodeX402Payment } from "../helpers/x402TestHelpers.js";
import { encodeUsdcTransferLog, fakeSuccessfulReceipt, fakeFailedReceipt } from "../helpers/fakeUsdcTransfer.js";

let built: TestApp | undefined;

afterEach(async () => {
  await built?.app.close();
  built = undefined;
});

let txCounter = 0;
/** A fresh, never-reused-looking fake tx hash per call — real hash
 * FORMAT (0x + 64 hex chars), but not a real on-chain transaction;
 * FakeChainReader is what decides what it "returns". */
function fakeTxHash(): string {
  txCounter += 1;
  return "0x" + txCounter.toString(16).padStart(64, "0");
}

/** Builds a real-shaped X-PAYMENT header: a genuine EIP-191 signature
 * from a genuine (test) wallet over the exact canonical message
 * auth.ts recomputes and checks. When `fundOnChain` is true (default),
 * also configures the test app's FakeChainReader with a genuinely
 * ABI-encoded USDC Transfer log so verifyOnChainUsdcTransfer actually
 * succeeds — tests targeting a rejection path that fires BEFORE the
 * on-chain check (bad nonce, amount too low) don't need real funding. */
async function buildPayment(
  app: TestApp,
  params: { nonce: string; amountUsdc: number },
  opts: { fundOnChain?: boolean; wallet?: ReturnType<typeof createTestPayerWallet>; toAddress?: string } = {},
): Promise<string> {
  const wallet = opts.wallet ?? createTestPayerWallet();
  const txHash = fakeTxHash();
  if (opts.fundOnChain !== false) {
    app.chainReader.setReceipt(
      txHash,
      fakeSuccessfulReceipt([
        encodeUsdcTransferLog(wallet.address, opts.toAddress ?? app.treasuryAddress, params.amountUsdc),
      ]),
    );
  }
  const signature = await signPaymentAuthorization(wallet, { nonce: params.nonce, amountUsdc: params.amountUsdc, txHash });
  return encodeX402Payment({ nonce: params.nonce, amountUsdc: params.amountUsdc, payerAddress: wallet.address, txHash, signature });
}

/** Drives the real challenge -> payment -> receipt cycle for a given
 * request body, returning the successful response + issued receipt. */
async function payAndQuote(app: TestApp, body: Record<string, unknown> = {}) {
  const challengeRes = await app.app.inject({ method: "POST", url: "/v1/route/quote", payload: body });
  expect(challengeRes.statusCode).toBe(402);
  const challenge = challengeRes.json().accepts[0];

  const payment = await buildPayment(app, { nonce: challenge.nonce, amountUsdc: Number(challenge.maxAmountRequired) });
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
    expect(res.json().accepts[0].nonce).toBeTruthy();
  });

  it("VALIDATE-BEFORE-BILL — a malformed request with NO auth returns 400, not a 402 challenge", async () => {
    // Real bug found while building the credit ledger: schema
    // validation used to run inside the route handler, AFTER the
    // auth/x402 preHandler — meaning a garbage request could still
    // provoke (and on the credit rail, pay for) the auth machinery
    // before ever being rejected. validateQuoteRequest.ts now runs
    // first; this confirms a malformed body never even reaches the
    // point where a challenge nonce would be issued.
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

describe("dual-rail auth — Secondary Path (x402), CLAUDE.md §4", () => {
  it("no credentials at all returns a real 402 challenge with a usable nonce, real treasury payTo, and price in CLAUDE.md's $0.10-$0.25+ range", async () => {
    built = await buildTestApp();
    const res = await built.app.inject({ method: "POST", url: "/v1/route/quote", payload: {} });

    expect(res.statusCode).toBe(402);
    const body = res.json();
    expect(body.x402Version).toBe(1);
    const challenge = body.accepts[0];
    expect(challenge.scheme).toBe("exact");
    expect(challenge.network).toBe("base");
    expect(challenge.nonce).toBeTruthy();
    expect(challenge.payTo).toBe(built.treasuryAddress);
    expect(Number(challenge.maxAmountRequired)).toBeGreaterThanOrEqual(0.1);
    // Real bug caught live 2026-09-24 while extending x402 onto
    // compute/rank: resource used to be hardcoded regardless of which
    // route issued the challenge. Asserted here on quote's side too,
    // so a future regression can't silently break either route.
    expect(challenge.resource).toBe("/v1/route/quote");
  });

  it("a payment with a real signature and a real on-chain-confirmed USDC transfer succeeds and returns a signed receipt header", async () => {
    built = await buildTestApp();
    const { paidRes, receipt } = await payAndQuote(built, {});
    expect(paidRes.statusCode).toBe(200);
    expect(receipt).toBeTruthy();
    expect(receipt).toMatch(/^[\w-]+\.[0-9a-f]{64}$/); // base64url payload . hex hmac
  });

  it("a payment with a made-up nonce (never issued by this server) is rejected, not silently accepted", async () => {
    built = await buildTestApp();
    const payment = await buildPayment(built, { nonce: "totally-made-up-nonce", amountUsdc: 0.15 }, { fundOnChain: false });
    const res = await built.app.inject({
      method: "POST",
      url: "/v1/route/quote",
      headers: { "x-payment": payment },
      payload: {},
    });
    expect(res.statusCode).toBe(402);
    expect(res.json().reason).toMatch(/unknown or already-expired/);
    expect(res.json().code).toBe("unknown_challenge");
  });

  it("REPLAY PROTECTION — reusing the same nonce for a second payment is rejected", async () => {
    built = await buildTestApp();

    const challengeRes = await built.app.inject({ method: "POST", url: "/v1/route/quote", payload: {} });
    const { nonce, maxAmountRequired } = challengeRes.json().accepts[0];
    const amountUsdc = Number(maxAmountRequired);

    const firstPayment = await buildPayment(built, { nonce, amountUsdc });
    const first = await built.app.inject({
      method: "POST",
      url: "/v1/route/quote",
      headers: { "x-payment": firstPayment },
      payload: {},
    });
    expect(first.statusCode).toBe(200);

    // Same nonce again (fresh wallet/txHash — proves the nonce itself
    // is what's rejected, not incidentally the same tx being reused).
    const replayPayment = await buildPayment(built, { nonce, amountUsdc });
    const replay = await built.app.inject({
      method: "POST",
      url: "/v1/route/quote",
      headers: { "x-payment": replayPayment },
      payload: {},
    });
    expect(replay.statusCode).toBe(402);
    expect(replay.json().reason).toMatch(/already used.*replay/i);
    expect(replay.json().code).toBe("challenge_already_used");
  });

  it("TX REUSE — a real transfer already used to authorize one nonce cannot authorize a different nonce", async () => {
    built = await buildTestApp();
    const wallet = createTestPayerWallet();

    // First payment — fully real and funded, succeeds.
    const first = await payAndQuote(built, {});
    expect(first.paidRes.statusCode).toBe(200);

    // Grab a fresh challenge, but sign a payment that claims the SAME
    // txHash the first payment already used — re-derive the exact
    // txHash by re-running buildPayment isn't possible after the fact,
    // so instead we manufacture the reuse directly: issue a second
    // challenge, then submit a payment whose txHash is pre-registered
    // in processedEvents via a real first payment against a KNOWN hash.
    const challengeRes = await built.app.inject({ method: "POST", url: "/v1/route/quote", payload: {} });
    const { nonce, maxAmountRequired } = challengeRes.json().accepts[0];
    const amountUsdc = Number(maxAmountRequired);
    const sharedTxHash = fakeTxHash();
    built.chainReader.setReceipt(
      sharedTxHash,
      fakeSuccessfulReceipt([encodeUsdcTransferLog(wallet.address, built.treasuryAddress, amountUsdc)]),
    );
    // Mark this txHash as already processed against some other nonce —
    // exactly what a real first use would have done.
    built.processedEvents.recordIfNew(sharedTxHash, "base_onchain", wallet.address, amountUsdc);

    const signature = await signPaymentAuthorization(wallet, { nonce, amountUsdc, txHash: sharedTxHash });
    const payment = encodeX402Payment({ nonce, amountUsdc, payerAddress: wallet.address, txHash: sharedTxHash, signature });

    const res = await built.app.inject({
      method: "POST",
      url: "/v1/route/quote",
      headers: { "x-payment": payment },
      payload: {},
    });
    expect(res.statusCode).toBe(402);
    expect(res.json().reason).toMatch(/already been used to authorize a different payment/);
    expect(res.json().code).toBe("invalid_transaction_state");
  });

  it("rejects a payment whose signature does not recover to the claimed payerAddress", async () => {
    built = await buildTestApp();
    const challengeRes = await built.app.inject({ method: "POST", url: "/v1/route/quote", payload: {} });
    const { nonce, maxAmountRequired } = challengeRes.json().accepts[0];
    const amountUsdc = Number(maxAmountRequired);

    const signer = createTestPayerWallet();
    const impersonated = createTestPayerWallet(); // a different wallet than the one that actually signed
    const txHash = fakeTxHash();
    built.chainReader.setReceipt(
      txHash,
      fakeSuccessfulReceipt([encodeUsdcTransferLog(impersonated.address, built.treasuryAddress, amountUsdc)]),
    );
    const signature = await signPaymentAuthorization(signer, { nonce, amountUsdc, txHash });
    const payment = encodeX402Payment({ nonce, amountUsdc, payerAddress: impersonated.address, txHash, signature });

    const res = await built.app.inject({
      method: "POST",
      url: "/v1/route/quote",
      headers: { "x-payment": payment },
      payload: {},
    });
    expect(res.statusCode).toBe(402);
    expect(res.json().reason).toMatch(/signature does not match claimed payerAddress/);
    expect(res.json().code).toBe("invalid_exact_evm_payload_signature");
  });

  it("rejects a payment whose on-chain transaction failed/reverted", async () => {
    built = await buildTestApp();
    const challengeRes = await built.app.inject({ method: "POST", url: "/v1/route/quote", payload: {} });
    const { nonce, maxAmountRequired } = challengeRes.json().accepts[0];
    const amountUsdc = Number(maxAmountRequired);

    const wallet = createTestPayerWallet();
    const txHash = fakeTxHash();
    built.chainReader.setReceipt(
      txHash,
      fakeFailedReceipt([encodeUsdcTransferLog(wallet.address, built.treasuryAddress, amountUsdc)]),
    );
    const signature = await signPaymentAuthorization(wallet, { nonce, amountUsdc, txHash });
    const payment = encodeX402Payment({ nonce, amountUsdc, payerAddress: wallet.address, txHash, signature });

    const res = await built.app.inject({
      method: "POST",
      url: "/v1/route/quote",
      headers: { "x-payment": payment },
      payload: {},
    });
    expect(res.statusCode).toBe(402);
    expect(res.json().reason).toMatch(/failed\/reverted/);
    expect(res.json().code).toBe("invalid_transaction_state");
  });

  it("rejects a payment whose real transfer sent USDC to the wrong address (not our treasury)", async () => {
    built = await buildTestApp();
    const challengeRes = await built.app.inject({ method: "POST", url: "/v1/route/quote", payload: {} });
    const { nonce, maxAmountRequired } = challengeRes.json().accepts[0];
    const amountUsdc = Number(maxAmountRequired);

    const wallet = createTestPayerWallet();
    const notOurTreasury = createTestPayerWallet().address;
    const payment = await buildPayment(built, { nonce, amountUsdc }, { wallet, toAddress: notOurTreasury });

    const res = await built.app.inject({
      method: "POST",
      url: "/v1/route/quote",
      headers: { "x-payment": payment },
      payload: {},
    });
    expect(res.statusCode).toBe(402);
    expect(res.json().reason).toMatch(/no matching USDC Transfer found/);
    expect(res.json().code).toBe("invalid_payload");
  });

  it("rejects a payment amount below the challenge's required minimum", async () => {
    built = await buildTestApp();
    const challengeRes = await built.app.inject({ method: "POST", url: "/v1/route/quote", payload: {} });
    const { nonce } = challengeRes.json().accepts[0];

    const payment = await buildPayment(built, { nonce, amountUsdc: 0.01 }, { fundOnChain: false });
    const res = await built.app.inject({
      method: "POST",
      url: "/v1/route/quote",
      headers: { "x-payment": payment },
      payload: {},
    });
    expect(res.statusCode).toBe(402);
    expect(res.json().reason).toMatch(/below the required/);
    expect(res.json().code).toBe("invalid_exact_evm_payload_authorization_value_mismatch");
  });

  it("rejects a payment on the wrong network", async () => {
    built = await buildTestApp();
    const submission = {
      scheme: "exact",
      network: "ethereum",
      nonce: "irrelevant",
      amountUsdc: 0.15,
      payerAddress: "0x0000000000000000000000000000000000dEaD",
      txHash: fakeTxHash(),
      signature: "0xnotarealsignature",
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
