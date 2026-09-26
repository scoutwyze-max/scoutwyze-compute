# ScoutWyze Compute

Autonomous, machine-readable GPU placement recommendation and routing
decision engine for AI infrastructure agents and MLOps pipelines. See
`CLAUDE.md` for the full V1 source of truth — architecture, scope
boundaries, and the data-provenance model this whole engine is built
around.

**What this is not:** an execution platform. Every `compute/rank`
response carries `limits: {not_reserved: true, not_provisioned: true,
can_provision: false}` — this ranks and recommends where to rent GPU
compute, it never reserves, provisions, or runs anything itself. See
`SOT.md` for the rigorously-verified current state of every claim in
this document.

## For AI agents & autonomous integration

Live: **https://scoutwyze-compute.fly.dev** — dual-rail, pay per
successful ranked match, no subscription.

```bash
# Free, anonymous, rate-limited — see the real response shape before paying
curl https://scoutwyze-compute.fly.dev/v1/compute/sample

# Rail 1 — prepaid Bearer key (one-time human funding, then headless)
curl -X POST https://scoutwyze-compute.fly.dev/v1/compute/rank \
  -H "Authorization: Bearer sw_live_..." -H "Content-Type: application/json" \
  -d '{"gpuClass":"H100","preference":"cheapest"}'

# Rail 2 — x402/USDC on Base, zero signup, zero API key, zero gas
curl -X POST https://scoutwyze-compute.fly.dev/v1/compute/rank \
  -d '{"gpuClass":"H100"}'
# -> HTTP 402 with real payment requirements (EIP-3009 "exact" EVM scheme).
#    Sign an authorization (no on-chain broadcast needed from you — this
#    server's facilitator handles that), resubmit with X-PAYMENT, get a 200.
#    See examples/node-client.mjs or examples/python_client.py for the
#    real signing flow — not curl-able directly, needs an EIP-712 signature.
```

- **`GET /llms.txt`** and **`GET /openapi.json`** — full machine-readable API description, both rails, the x402 error-code vocabulary, everything below.
- **`examples/`** — copy-pasteable Node.js and Python clients (both rails, including a real x402 sign-and-pay flow), plus LangChain and Haystack `Tool` wrappers.
- **`scoutwyze-compute`** on [PyPI](https://pypi.org/project/scoutwyze-compute/) — same client/LangChain/Haystack code as `examples/`, packaged: `pip install "scoutwyze-compute[all]"`.
- **`@scoutwyze/compute-mcp`** on [npm](https://www.npmjs.com/package/@scoutwyze/compute-mcp) — MCP server for Claude Desktop/Cursor: `npx -y @scoutwyze/compute-mcp`. Also listed in the [official MCP Registry](https://registry.modelcontextprotocol.io) (`io.github.scoutwyze-max/compute-mcp`) and [Smithery](https://smithery.ai/servers/scoutwyze/compute-mcp) (`scoutwyze/compute-mcp`).

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
  (`X-PAYMENT` header) — real x402 "exact" EVM scheme (EIP-3009
  `TransferWithAuthorization`, EIP-712 signature recovery, domain
  independently verified against the real USDC contract on Base),
  settled through PayAI's facilitator and independently re-confirmed
  on-chain by this server, not trusted on the facilitator's claim alone.
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

## Try it (local)

```bash
# 1. Get a real API key (free — funding it is a separate step)
curl -X POST http://localhost:8787/v1/signup

# 2. Use it — a brand-new key has a $0 balance, so this correctly
#    returns 402 insufficient_credits rather than a ranked result. Fund
#    the account (via /v1/checkout-sessions + a real Stripe payment, or
#    POST /v1/admin/accounts/:accountId/credits with X-Admin-Secret for
#    local testing) to see a real 200.
curl -X POST http://localhost:8787/v1/compute/rank \
  -H "Authorization: Bearer <apiKey from step 1>" \
  -H "Content-Type: application/json" \
  -d '{"gpuClass": "H100", "preference": "cheapest"}'
```

Against the live production deployment instead, see "For AI agents &
autonomous integration" above, or `examples/` for full client code in
Node.js and Python (both rails).

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
  db/                        SQLite connection + schema (durable: keys, ledger, processed payment events)
scripts/
  smoke-test.mjs             Post-deployment smoke test — hits a real running instance over HTTP
tests/
  unit/                      Pure-function coverage: cost math, risk scoring, filtering, provenance separation, payments
  integration/                Full HTTP flow via Fastify inject(): auth, fail-closed behavior, signup/checkout, webhooks
examples/                    Copy-pasteable Node.js/Python clients (dual-rail) + LangChain/Haystack Tool wrappers — see examples/README.md
mcp-server/                  Separate, independently-published MCP server package (@scoutwyze/compute-mcp) wrapping this API for MCP-native hosts — see mcp-server/README.md
python-sdk/                  Separate, independently-published Python package (scoutwyze-compute on PyPI) — the same client/LangChain/Haystack code as examples/, packaged and pip-installable
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

- RunPod is live in production (`RunpodLiveCatalogSource`,
  `RUNPOD_API_KEY` configured) — Lambda Labs and CoreWeave remain
  fixture-only, comparison data, never bookable, never live. Flipping
  either to live needs that provider's real API key wired the same way
  RunPod's already is.
- Horizontal scaling / multi-instance deployment (see the single-writer
  SQLite constraint above) — would need a real shared database or
  something like LiteFS first.
- Abuse throttling on `/v1/signup` and `/v1/checkout-sessions` (both
  unauthenticated by design, for onboarding) — noted as a real, known V1
  gap in `src/api/routes/signup.ts`, not a hidden one.
