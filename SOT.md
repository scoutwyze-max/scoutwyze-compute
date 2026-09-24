# ScoutWyze Compute — System Source of Truth (SOT)
**Scope:** Compute venture only — Real Estate is a separate codebase I have no visibility into and make no claims about.
**Status:** Compute-side claims below were independently tested against the live production code and API on 2026-09-23/24, not taken from prior documentation. Where something is unverified or roadmap-only, it's labeled as such, not folded into "verified." Updated 2026-09-24: x402 extended onto `compute/rank` (see §4/§5 — this was the single biggest inaccuracy in the previous version of this document).
**Live:** https://scoutwyze-compute.fly.dev

## 1. What it is
A metered, machine-readable API that ranks current RunPod GPU offers by price and freshness. It is a quote/ranking service — it does not reserve, provision, or start any machine. Booking exists in code (`POST /v1/route/book`) but is intentionally unpublished (undocumented in `llms.txt`/OpenAPI/landing page) because it has not had a successful end-to-end live booking yet.

**Scope note (real discrepancy, not swept under the rug):** the project's own original spec (`CLAUDE.md`) restricts V1 to "8× H100 80GB, US-based regions." The deployed `rank`/`sample` endpoints do not enforce this — they serve RunPod's full live catalog (any GPU model, any GPU count, any region including EU/AP) unless a caller explicitly filters. This is current, verified behavior, and it's broader than the documented V1 scope. Worth a deliberate decision — either update the scope doc or add the restriction to the code — rather than leaving the two silently disagreeing.

## 2. Endpoints (verified live, 2026-09-23/24)

| Endpoint | Auth | Billed | Response shape |
|---|---|---|---|
| `GET /v1/compute/sample` (alias `/v1/route/sample`) | none | no | Frozen envelope (§3) |
| `POST /v1/compute/rank` (alias `/v1/route/rank`) | Bearer **or** x402/USDC-on-Base (since 2026-09-24) | $0.15 — Bearer debits only on a real match; x402 settles on payment, before scoring (see §5) | Frozen envelope (§3) |
| `POST /v1/route/quote` | Bearer **or** x402/USDC-on-Base | $0.15, debited on successful auth | Separate, older schema (§4) — **not** the frozen envelope |
| `POST /v1/route/book` | Bearer only | Vendor cost + 15% margin, debited only after RunPod accepts | Separate shape; deployed but unpublished |

`rank`/`sample` restrict results to RunPod only, by deliberate production policy — Lambda Labs and CoreWeave rows exist in the ingestion layer as fixture/comparison data but can never appear as a recommendation or alternative.

## 3. The frozen envelope — exact shape, not paraphrased

Applies to `compute/rank` and `compute/sample` only, not to `route/quote` or `route/book`.

```json
{
  "status": "ok | no_match | no_inventory",
  "schema_version": "1.0",
  "coverage": { "vertical": "gpu_compute", "providers_live": ["runpod"] },
  "recommended": { /* one offer, shape below */ },
  "alternatives": [ /* zero or more offers, same shape */ ],
  "limits": { "not_reserved": true, "not_provisioned": true, "can_provision": false },
  "billing": { "billable": true, "unit": "successful_rank", "price_usd": 0.15, "rail": "bearer", "creditsRemaining": 9.85 }
}
```
`billing.rail` (added 2026-09-24) is `"bearer"` or `"x402"` — see §5 for why the two are not interchangeable. `creditsRemaining` only appears on the Bearer rail (x402 has no ledger balance to report).
Each offer inside `recommended`/`alternatives`:
```json
{
  "provider": "runpod", "sku": "...", "region": "...", "vendorHourly": 0, "vramGb": 0, "gpuCount": 0,
  "observed_at": "...", "freshness_seconds": 0, "source": "live_api | fixture",
  "availability_status": "low | medium | high | none | null",
  "classification": "provider_reported",
  "score": 0, "scoreBreakdown": { "priceScore": 0, "freshnessScore": 0, "weights": {"price": 0.8, "freshness": 0.2}, "ageMinutes": 0 },
  "reason": "..."
}
```
`classification: "provider_reported"` tags everything above `score` as the provider's own claim, untouched; `score`/`scoreBreakdown`/`reason` are ScoutWyze's own computation over those claims. `billing` on `no_match`/`no_inventory` omits `creditsRemaining` (nothing was charged); `sample`'s `billing.billable` is always `false` and carries a `note` instead of a price.

`limits` is a static, literal constant on every response from these two endpoints — not derived from any request or cache state. It is a machine-checkable assertion, not a claim in prose.

## 4. Payment — what's actually funded and by whom

There are no spend policies, per-agent caps, hourly limits, or endpoint allowlists anywhere in the code. Grepped for this explicitly — it doesn't exist. What exists:

**Rail 1 — Prepaid Bearer key (works on `compute/rank`, `route/quote`).** A human funds a flat USD balance once via real Stripe Checkout ($10/$50/$200 packs, live mode, verified this session). From then on, an agent calls the API with that key with zero human involvement per call — but it's a flat balance getting debited $0.15 at a time until it hits zero, not a policy engine. When it hits zero, the human has to fund it again; nothing auto-refills.

**Rail 2 — x402 / USDC on Base (works on `compute/rank` AND `route/quote` as of 2026-09-24).** An unauthenticated request, or one with an unrecognized/revoked Bearer key, gets a real HTTP 402 with a challenge body (`nonce`, `payTo`, `maxAmountRequired: "0.15"`, `expiresAt` ~2 minutes out — verified live this session, exact field values confirmed). Settlement is a self-submitted on-chain USDC transfer on Base, proven via signature recovery plus an independent chain read against the real Base USDC contract — not a gasless/facilitator-relayed flow (no EIP-3009, no third-party facilitator integration exists in the code). `compute/rank` reuses the exact same verification code path `route/quote` already used (`auth.ts`'s `verifyX402Payment`, extracted 2026-09-24 specifically so this wasn't a second, parallel implementation of the crypto checks) — not a reimplementation. A recognized Bearer key with a literal zero balance still hard-402s without attempting x402 (matches `quote`'s own pre-existing precedent). **Unverified this pass:** an earlier claim that a real mainnet payment was proven end-to-end was not re-tested (doing so costs real USDC) — treat as unconfirmed until someone actually re-runs it, not as settled fact.

## 5. Settle-before-grant — a real per-rail asymmetry, not a blanket guarantee

This is more nuanced than "some endpoints defer billing and some don't" — it depends on *which rail* a given request used, not just which endpoint:

- **Bearer, on `rank`**: debit is deferred until AFTER scoring — a `no_match`/`no_inventory` result is never charged. Unchanged since this route existed.
- **Bearer, on `quote`**: always charges on successful auth, before the response is built — a real, pre-existing difference between the two Bearer-authenticated routes, not new.
- **x402, on `rank` or `quote`**: settles on successful payment verification, BEFORE scoring — real USDC has already moved on-chain by the time the handler knows whether there's a match. There is no refund path for a no-match result on this rail. This is not a bug or an oversight — it's unavoidable: a completed on-chain transfer can't be deferred or undone the way a ledger debit can.
- **`book`**: the opposite direction entirely — dispatches to the vendor *first*, debits only after the vendor accepts, because there's no vendor-side cancellation API.

`compute/rank`'s response makes this checkable, not just documented: `billing.rail` (`"bearer"` or `"x402"`) tells the caller which guarantee applied to that specific request, and on `no_match`/`no_inventory` the x402 case includes an explicit `note` explaining why `billable` is still `true`.

## 6. Machine discovery — what's real vs. aspirational

`GET /llms.txt` and `GET /openapi.json` exist, are live, and accurately describe the endpoints above (verified this session). What's **not** verified: whether any agent framework actually crawls these files at runtime and auto-wires the API into a tool config today. That's a real, current gap — treat "agent frameworks discover and configure this programmatically" as a design goal the docs support, not an observed, production-verified behavior.

**x402 Bazaar extension (added 2026-09-24)** — `compute/rank`'s 402 response includes a real `extensions.bazaar` field (schema verified directly against x402-foundation's own TypeScript source, not assumed; hand-built to avoid a 9-dependency/1.7MB SDK for one static JSON object). Confirmed live: the field is present, correctly shaped, and correctly scoped to `rank` only (`route/quote` has none). **What this does NOT mean:** the endpoint is not actually listed/discoverable in the x402 Bazaar yet. Listing only happens as a side effect of a real payment settling through a Bazaar-participating facilitator (Coinbase's CDP Facilitator or PayAI) — this codebase's x402 verification is still fully self-hosted (`baseVerification.ts`, direct on-chain read, no third-party facilitator), so no settlement currently goes through a path that would trigger a Bazaar listing. The extension field is ready for whenever that facilitator decision is made; it does not itself make this discoverable.

## 7. Namespace rule (forward-looking, not yet exercised)
`/v1/compute/*` is the canonical namespace; a hypothetical second vertical would live at `/v1/<vertical>/quote` rather than an overloaded shared path. No second vertical exists yet — this is a documented constraint on future work, not something currently running in production.
