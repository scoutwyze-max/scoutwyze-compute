# ScoutWyze Compute — Launch Checklist

Live: https://scoutwyze-compute.fly.dev
Single machine by design (SQLite + in-process worker) — `fly.toml`'s own header comment explains why; do not scale to >1 machine without re-architecting storage first.

## Pre-flight (done, this session)
- [x] `GET /healthz` — 200, worker running, all 3 providers `ok`
- [x] Fly secrets set: `ADMIN_SECRET`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `BASE_RPC_URL`, `X402_RECEIPT_SIGNING_SECRET`
- [x] Machine `autostop: false`, `autostart: true`, `min_machines_running: 1` (confirmed on the live deployed config, not just `fly.toml`)
- [x] Persistent volume mounted at `/data`, survives restarts
- [ ] **Known gap:** `BASE_TREASURY_WALLET_ADDRESS` Fly secret is set but never read (code reads `BASE_TREASURY_ADDRESS`, which comes from `fly.toml`'s `[env]` instead — currently correct by coincidence). Either delete the unused secret or rename it so it isn't a trap for a future address rotation.
- [ ] **Operational note:** pushing to `main` auto-deploys production via `.github/workflows/fly-deploy.yml` (if `FLY_API_TOKEN` is set in GitHub repo secrets — confirmed live this session by watching an unrelated push trigger a real redeploy). Treat every `git push origin main` as a production deploy.

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
