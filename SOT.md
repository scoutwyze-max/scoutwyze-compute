# ScoutWyze Compute — System Source of Truth (SOT)
**Scope:** Compute venture only — Real Estate is a separate codebase I have no visibility into and make no claims about.
**Status:** Compute-side claims below were independently tested against the live production code and API on 2026-09-23/24, not taken from prior documentation. Where something is unverified or roadmap-only, it's labeled as such, not folded into "verified."
**Live:** https://scoutwyze-compute.fly.dev

## 1. What it is
A metered, machine-readable API that ranks current RunPod GPU offers by price and freshness. It is a quote/ranking service — it does not reserve, provision, or start any machine. Booking exists in code (`POST /v1/route/book`) but is intentionally unpublished (undocumented in `llms.txt`/OpenAPI/landing page) because it has not had a successful end-to-end live booking yet.

**Scope note (real discrepancy, not swept under the rug):** the project's own original spec (`CLAUDE.md`) restricts V1 to "8× H100 80GB, US-based regions." The deployed `rank`/`sample` endpoints do not enforce this — they serve RunPod's full live catalog (any GPU model, any GPU count, any region including EU/AP) unless a caller explicitly filters. This is current, verified behavior, and it's broader than the documented V1 scope. Worth a deliberate decision — either update the scope doc or add the restriction to the code — rather than leaving the two silently disagreeing.

## 2. Endpoints (verified live, 2026-09-23/24)

| Endpoint | Auth | Billed | Response shape |
|---|---|---|---|
| `GET /v1/compute/sample` (alias `/v1/route/sample`) | none | no | Frozen envelope (§3) |
| `POST /v1/compute/rank` (alias `/v1/route/rank`) | Bearer only | $0.15, debited only on a real match | Frozen envelope (§3) |
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
  "billing": { "billable": true, "unit": "successful_rank", "price_usd": 0.15, "creditsRemaining": 9.85 }
}
```
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

**Rail 2 — x402 / USDC on Base (works on `route/quote` only — not on `compute/rank`).** An unauthenticated request to `route/quote` gets a real HTTP 402 with a challenge body (`nonce`, `payTo`, `maxAmountRequired: "0.15"`, `expiresAt` ~2 minutes out — verified live this session, exact field values confirmed). Settlement is a self-submitted on-chain USDC transfer on Base, proven via signature recovery plus an independent chain read against the real Base USDC contract — not a gasless/facilitator-relayed flow (no EIP-3009, no third-party facilitator integration exists in the code). **Unverified this pass:** an earlier claim that a real mainnet payment was proven end-to-end was not re-tested (doing so costs real USDC) — treat as unconfirmed until someone actually re-runs it, not as settled fact.

`compute/rank` and `compute/sample` are Bearer-only by deliberate design — an agent cannot pay for them via x402 today.

## 5. Settle-before-grant — true for two endpoints, deliberately false for a third

`rank` and `quote` both verify/debit payment before releasing the response. `book` is the deliberate exception: it dispatches to the vendor *first* and only debits after the vendor accepts, because there's no vendor-side cancellation API — charging before knowing whether RunPod accepts the job would risk charging for a declined booking. Any statement of this rule should scope it to rank/quote or name book's exception explicitly; it is not a blanket guarantee across every paid endpoint.

## 6. Machine discovery — what's real vs. aspirational

`GET /llms.txt` and `GET /openapi.json` exist, are live, and accurately describe the endpoints above (verified this session). What's **not** verified: whether any agent framework actually crawls these files at runtime and auto-wires the API into a tool config today. That's a real, current gap — treat "agent frameworks discover and configure this programmatically" as a design goal the docs support, not an observed, production-verified behavior.

## 7. Namespace rule (forward-looking, not yet exercised)
`/v1/compute/*` is the canonical namespace; a hypothetical second vertical would live at `/v1/<vertical>/quote` rather than an overloaded shared path. No second vertical exists yet — this is a documented constraint on future work, not something currently running in production.
