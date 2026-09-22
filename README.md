# ScoutWyze Compute

Autonomous, machine-readable GPU placement recommendation and routing
decision engine for AI infrastructure agents and MLOps pipelines. See
`CLAUDE.md` for the full V1 source of truth — architecture, scope
boundaries, and the data-provenance model this whole engine is built
around.

## V1 scope

- One SKU: 8× H100 80GB, InfiniBand/RDMA, US regions only.
- Three provider feeds — Lambda Labs, RunPod, CoreWeave — normalized by
  per-provider adapters (`src/providers/`). V1 wires each to a local
  fixture by default; raw-entry sourcing sits behind a `RawEntrySource`
  seam (`src/providers/rawSource.ts`) specifically so swapping a
  provider to a real polled/webhook-fed feed later is a one-line change
  at that adapter's own export, not a rewrite.
- Every quote strictly separates what a provider stated
  (`provider_observed`) from what ScoutWyze calculated
  (`scoutwyze_estimated`) from freshness/confidence metadata
  (`metadata`) — never blended into one opaque number.
- Fail-closed: a broken/unparseable provider feed contributes nothing
  and is reported in `excluded_providers`, never silently faked or
  served stale-as-current.
- Dual-rail auth, both real: `Authorization: Bearer <api_key>` backed by
  a real hashed-key store + prepaid credit ledger, or x402/USDC-on-Base
  (`X-PAYMENT` header) with real EIP-191 signature recovery and real
  on-chain USDC transfer confirmation against the treasury wallet.
- Real payment intake: a Stripe webhook (signature-verified, idempotent)
  tops up the credit ledger on a completed Checkout Session; self-serve
  `POST /v1/signup` + `POST /v1/checkout-sessions` let a new
  user/agent get a key and fund it without any admin involvement.

## Getting started

```bash
npm install
cp .env.example .env      # fill in real secrets — see comments in the file
npm run dev                # starts the API on :8787 (see .env for PORT)
npm test                   # full unit + integration suite
npm run typecheck
```

## Try it

```bash
# 1. Get a real API key (free — funding it is a separate step)
curl -X POST http://localhost:8787/v1/signup

# 2. Use it — a brand-new key has a $0 balance, so this correctly
#    returns 402 insufficient_credits rather than a quote. Fund the
#    account (via /v1/checkout-sessions + a real Stripe payment, or
#    POST /v1/admin/accounts/:accountId/credits with X-Admin-Secret for
#    local testing) to see a real 200.
curl -X POST http://localhost:8787/v1/route/quote \
  -H "Authorization: Bearer <apiKey from step 1>" \
  -H "Content-Type: application/json" \
  -d '{"workload_type": "inference"}'
```

## Project layout

```
src/
  types/schema.ts          Zod schemas — the provenance-separated response contract
  providers/                One adapter per feed, normalizing raw provider shape -> ProviderObservedFacts
    rawSource.ts             Fixture/Http/Webhook raw-entry sourcing, swappable per adapter
    fixtures/                Mock provider data, structured to match each provider's real field conventions
  ingestion/                 Background cache — the only thing the API route ever reads from
  engine/                    SKU/region filtering, cost calculation, risk scoring, ranking
  billing/                   Hashed API keys + prepaid credit ledger (SQLite)
  payments/                  Stripe webhook verification, Stripe Checkout Session creation, real Base/x402
                              on-chain settlement verification, cross-rail payment-event idempotency
  api/                       Fastify routes (quote, signup/checkout, Stripe webhook, admin) + dual-rail auth middleware
  db/                        SQLite connection + schema (durable: keys, ledger, x402 nonces, processed payment events)
scripts/
  smoke-test.mjs             Post-deployment smoke test — hits a real running instance over HTTP
tests/
  unit/                      Pure-function coverage: cost math, risk scoring, filtering, provenance separation, payments
  integration/                Full HTTP flow via Fastify inject(): auth, fail-closed behavior, signup/checkout, webhooks
```

## Deployment

`Dockerfile` + `fly.toml` — see `fly.toml`'s own header comment before
deploying, especially the **single-instance-by-design** constraint:
durable state is one local SQLite file on an attached volume, so this
app must not be scaled to more than one machine without first
re-architecting storage.

```bash
fly apps create scoutwyze-compute
fly volumes create scoutwyze_compute_data --region iad --size 1
fly secrets set STRIPE_SECRET_KEY=... STRIPE_WEBHOOK_SECRET=... ADMIN_SECRET=... \
  X402_RECEIPT_SIGNING_SECRET=... CHECKOUT_SUCCESS_URL=... CHECKOUT_CANCEL_URL=...
fly deploy
npm run smoke -- https://scoutwyze-compute.fly.dev   # post-deploy verification
```

## What's deliberately not built yet

- Real HTTP-backed provider adapters are wired but not turned on — V1
  still defaults every provider to its local fixture (`rawSource.ts`'s
  `FixtureRawEntrySource`); flipping a provider to `HttpRawEntrySource`
  needs that provider's real API key.
- Horizontal scaling / multi-instance deployment (see the single-writer
  SQLite constraint above) — would need a real shared database or
  something like LiteFS first.
- Abuse throttling on `/v1/signup` and `/v1/checkout-sessions` (both
  unauthenticated by design, for onboarding) — noted as a real, known V1
  gap in `src/api/routes/signup.ts`, not a hidden one.
