# ScoutWyze Compute — Launch Checklist

Live: https://scoutwyze-compute.fly.dev
Single machine by design (SQLite + in-process worker) — `fly.toml`'s own header comment explains why; do not scale to >1 machine without re-architecting storage first.

**2026-09-26 architecture note:** the x402 payment flow described in
"4. 402" below (self-broadcast + EIP-191 message proof,
`scripts/pay-x402-quote.mjs` + `scripts/sign-message.html`) was a real,
working, tested implementation as of 2026-09-24 — but not spec-compliant
with the actual x402 "exact" EVM scheme, which real client tooling
expects. It was replaced 2026-09-26 with the real EIP-3009
`TransferWithAuthorization` scheme, settled through PayAI's facilitator;
both scripts referenced below have been deleted. See `SOT.md` §4 for
the current, accurate flow and `examples/` for working reference
clients. The rest of this section is kept as a historical record of
what was true on 2026-09-24, not a claim about current behavior.

## Pre-flight (re-audited 2026-09-24 — see note below on why "confirmed" isn't automatically trusted anymore)
- [x] `GET /healthz` — 200, worker running, all 3 providers `ok`
- [x] Fly secrets set: `ADMIN_SECRET`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `BASE_RPC_URL`, `X402_RECEIPT_SIGNING_SECRET`, `RUNPOD_API_KEY`. `LAMBDA_API_KEY`/`LAMBDA_SSH_KEY_NAME` (dead — Lambda booker is never instantiated, production is RunPod-only) and `BASE_TREASURY_WALLET_ADDRESS` (dead — code reads `BASE_TREASURY_ADDRESS` from `fly.toml` instead) were all deleted 2026-09-24; no code referenced any of the three.
- [x] Machine `autostop: false`, `autostart: true`, `min_machines_running: 1` (confirmed on the live deployed config, not just `fly.toml`)
- [x] Persistent volume mounted at `/data`, survives restarts. An orphaned second volume (`scoutwyze_data`, `sjc`, never attached to any machine) was found and deleted 2026-09-24 — only `scoutwyze_compute_data` (`iad`, attached) remains.
- [x] **Auto-deploy, actually confirmed this time:** pushing to `main` deploys production via `.github/workflows/fly-deploy.yml`. This line previously claimed to be "confirmed live" but wasn't — `FLY_API_TOKEN` had never actually been set as a GitHub repo secret, so both real CI runs on record failed in under 15 seconds (`gh run list` shows both). Fixed 2026-09-24: a Fly deploy token scoped to just this app was generated and stored as the `FLY_API_TOKEN` repo secret; a re-run of the previously-failed workflow then completed successfully end-to-end (confirmed via the live app's own `lastIngestedAt` timestamp matching the CI run's deploy time, not a stale copy of a manual deploy).
- [ ] **Not independently re-verified 2026-09-24:** the x402/USDC-on-Base "real mainnet payment → real 200" claim below is a specific past event, not something re-tested this audit (doing so costs real USDC). The supporting code (signature recovery + direct on-chain read against the real Base USDC contract) is intact and covered by 17 passing unit tests, but given the auto-deploy line above turned out to be false despite an identical "confirmed live this session" phrasing, treat this claim with the same caution until someone actually re-runs `scripts/pay-x402-quote.mjs` for real.

## Customer flow

### 1. Signup (free, unauthenticated)
```
POST /v1/signup
```
→ `201`, returns `accountId` + `apiKey` (shown once, never retrievable again). No caller-supplied `accountId` accepted — server-generated only, to prevent an unauthenticated caller from minting a key against someone else's existing account.

### 2. Fund
Real path: `POST /v1/checkout-sessions` `{accountId, packId}` (packs: `starter` $10 / `growth` $50 / `scale` $200) → real Stripe Checkout URL → customer pays → webhook (`POST /v1/webhooks/stripe`, signature-verified, idempotent) credits the ledger automatically.
Ops/manual path: `POST /v1/admin/accounts/:accountId/credits` `{amountUsd}` with `X-Admin-Secret` header.

### 3. Quote (funded)
```
POST /v1/route/quote
Authorization: Bearer <apiKey>
{"workload_type": "inference", "region": "us-east-1"}
```
→ `200`, real provenance-separated body (`provider_observed` / `scoutwyze_estimated` / `metadata`), $0.15 deducted. **`region` must be a real fixture region string** (`us-east-1`, `us-west-1`, or omit entirely) — a plausible-looking-but-wrong value like `"US"` silently filters out every result (`quotes: []`, not an error).

### 4. 402 (unfunded / no auth)
Same endpoint, no `Authorization` header and no `X-PAYMENT` header → `402`, body includes a real x402 challenge (`nonce`, `payTo`, `maxAmountRequired: "0.15"`, `expiresAt` ~2 min out). Two ways to pay it: Bearer key with sufficient balance, or real x402/USDC-on-Base settlement (`scripts/pay-x402-quote.mjs` + `scripts/sign-message.html` — proven end-to-end live this session, real mainnet payment → real 200).

### 5. Revoke
```
POST /v1/admin/api-keys/:keyId/revoke
X-Admin-Secret: <secret>
```
→ `200 {"revoked": true}`. Verify by re-querying with the same key — should flip from `insufficient_credits` (known key) to `payment_required` (unrecognized key), not just trust the response body.

## Verify after any deploy
```
npm run smoke -- https://scoutwyze-compute.fly.dev
```
Checks health, provider ingestion, x402 routing, and a real signup+auth DB round-trip. Catches the exact class of bug found this session (a build silently missing the provider fixture files — boots "healthy," serves zero quotes from all providers).
