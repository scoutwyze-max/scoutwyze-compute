// Cost model assumptions for the "ScoutWyze-Estimated Reality" layer
// (CLAUDE.md §3.2). Every number here is a documented assumption, not a
// provider fact — these are exactly the values that should move to a
// real, provider-specific pricing feed post-V1 rather than staying
// hardcoded, and each one is commented with its reasoning so a future
// change is a deliberate decision, not an unnoticed drift.

export const HOURS_PER_MONTH = 24 * 30;

// All 3 V1 fixture providers bundle local NVMe/ephemeral storage into
// the node's base hourly rate (confirmed by reading each raw fixture
// shape — none separates a storage line item). We still model
// persistent/checkpoint storage as its own cost, since that's a real
// MLOps cost a caller pays regardless of which node they land on, priced
// like S3 Standard.
export const STORAGE_RATE_USD_PER_GB_MONTH = 0.023;
export const ASSUMED_PERSISTENT_STORAGE_GB = 500;

// Egress varies a lot by workload shape: inference serves responses back
// over the public internet continuously; fine-tuning mostly reads
// training data in and writes checkpoints to co-located storage, so its
// real internet egress is much smaller. Rate matches typical public
// cloud egress pricing.
export const EGRESS_RATE_USD_PER_GB = 0.09;
export const ASSUMED_MONTHLY_EGRESS_GB_BY_WORKLOAD = {
  inference: 2000,
  fine_tuning: 200,
} as const;

// CPU/RAM ships bundled into the node price for all 3 V1 providers (no
// fixture separates it out) — kept as its own line item in the schema
// per CLAUDE.md §3.2, computed as 0 here rather than an invented number,
// until a provider that actually prices it separately is integrated.
export const CPU_RAM_UNBUNDLED_USD = 0;

// Interruption-risk scoring by capacity type — reserved capacity (e.g.
// CoreWeave's committed nodes) carries materially lower real
// interruption risk than on-demand, which in turn is lower than spot.
export const INTERRUPTION_RISK_BY_CAPACITY_TYPE = {
  reserved: 0.05,
  on_demand: 0.25,
  spot: 0.65,
} as const;

export const RISK_CATEGORY_THRESHOLDS = {
  low: 0.15,
  medium: 0.4,
} as const;
