# CLAUDE.md - ScoutWyze Compute Engine (V1 SOT)

## 1. Project Context & Strategic Pivot
- **The Pivot:** ScoutWyze Compute is an autonomous, machine-readable **GPU placement recommendation service and routing decision engine** for AI infrastructure agents and MLOps pipelines.
- **Strict Separation:** This is a brand-new, isolated infrastructure repository. It has zero code, database, or conceptual overlap with any legacy real estate lead-generation tools or consumer scrapers.
- **What it is NOT:** It is not a commodity price scraper, a static pricing table, or an automated execution broker.

## 2. Strict V1 Scope Boundaries
- **Target SKU:** Focus exclusively on **8× H100 80GB (with InfiniBand/RDMA), US-based regions, inference/fine-tuning workloads**. Do not build a sprawling 15-cloud index on day one.
- **Source Pool:** Integrate exactly **3 deep, reliable mock/structured provider feeds** to start.
- **Fail-Closed Rule:** If a provider feed breaks or schema changes, fail closed. Do not fabricate precision or silently serve stale data as absolute truth.

## 3. Data Truth Model & Response Schema (`POST /v1/route/quote`)
Every response must cleanly categorize data fields into distinct provenance classes:
1. **Provider-Observed Facts:** Listed specs, base rates, raw region names, and observation timestamps (`as_of`).
2. **ScoutWyze-Estimated Reality:** Total effective cost (including storage, CPU/RAM, and estimated egress) and calculated availability/interruption risk.
3. **Metadata & Confidence:** Strict TTL, `request_id`, freshness metrics, and confidence scores.

## 4. Dual-Rail Payment & Access Architecture
- **Primary Path (Conventional):** Standard `Authorization: Bearer` API keys and prepaid credit billing for engineering teams and MLOps codebases.
- **Secondary Path (Machine-Native):** x402 protocol / USDC micro-transactions on the **Base network** for compatible autonomous clients, priced for deep evaluations ($0.10 to $0.25+ per route).
- **Background Ingestion Rule:** Never fetch live provider pages synchronously during a paid request. All quotes must be served instantly from a continuously updated background ingestion cache to guarantee low latency.

## 5. Testing & Workspace Requirements
- **Sandbox:** Local development environment in Node.js/TypeScript (or Python/FastAPI) with isolated environment variables (`.env.example`).
- **Mock Adapters:** Build robust local fixture adapters to simulate provider feeds without hitting live external endpoints during initial development.
- **Test Suite:** Implement unit/integration tests covering constraint filtering, effective cost calculations, provenance separation, and dual-auth header validation.
