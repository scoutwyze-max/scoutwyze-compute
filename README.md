# ScoutWyze Compute

Autonomous, machine-readable GPU placement recommendation and routing
decision engine for AI infrastructure agents and MLOps pipelines. See
`CLAUDE.md` for the full V1 source of truth — architecture, scope
boundaries, and the data-provenance model this whole engine is built
around.

## V1 scope

- One SKU: 8× H100 80GB, InfiniBand/RDMA, US regions only.
- Three provider feeds, simulated via realistic mock fixtures for V1:
  Lambda Labs, RunPod, CoreWeave.
- Every quote strictly separates what a provider stated
  (`provider_observed`) from what ScoutWyze calculated
  (`scoutwyze_estimated`) from freshness/confidence metadata
  (`metadata`) — never blended into one opaque number.
- Fail-closed: a broken/unparseable provider feed contributes nothing
  and is reported in `excluded_providers`, never silently faked or
  served stale-as-current.
- Dual-rail auth: `Authorization: Bearer <api_key>` (conventional) or a
  mocked x402/USDC-on-Base `X-PAYMENT` header (machine-native). V1 mocks
  the on-chain settlement verification; real facilitator integration is
  a later, separate piece.

## Getting started

```bash
npm install
cp .env.example .env
npm run dev       # starts the API on :8787 (see .env for PORT)
npm test          # full unit + integration suite
npm run typecheck
```

## Try it

```bash
curl -X POST http://localhost:8787/v1/route/quote \
  -H "Authorization: Bearer dev_test_key_local_only" \
  -H "Content-Type: application/json" \
  -d '{"workload_type": "inference"}'
```

## Project layout

```
src/
  types/schema.ts          Zod schemas — the provenance-separated response contract
  providers/                One adapter per feed, normalizing raw provider shape -> ProviderObservedFacts
    fixtures/                Mock provider data, structured to match each provider's real field conventions
  ingestion/                 Background cache — the only thing the API route ever reads from
  engine/                    SKU/region filtering, cost calculation, risk scoring, ranking
  api/                       Fastify route + dual-rail auth middleware
tests/
  unit/                      Pure-function coverage: cost math, risk scoring, filtering, provenance separation
  integration/                Full HTTP flow via Fastify inject(): auth, fail-closed behavior, end-to-end quoting
```

## What's deliberately not built yet

- Real HTTP-backed provider adapters (V1 is fixture-only, by design —
  see `CLAUDE.md` §5).
- Real x402/Base on-chain settlement verification (mocked, see
  `src/api/middleware/x402.ts`).
- A real prepaid-credit ledger for the Bearer-key rail (V1 validates
  against a static allow-list; a real ledger is a separate, later piece).
