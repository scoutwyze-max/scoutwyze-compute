#!/usr/bin/env node
// Discovery module — finds public GitHub repos showing concrete signals
// that they'd want live GPU pricing data (direct RunPod/Lambda Labs API
// usage, or the providers' own env var names). Uses GitHub's public
// code search via the `gh` CLI (already authenticated on this machine)
// — no scraping, no unofficial endpoints, respects GitHub's own auth +
// rate limits.
//
// Hard boundary: read-only. One search call per signal, one metadata
// lookup per candidate. Never clones a repo, never opens an issue/PR,
// never contacts anyone. Output is a JSON list for generateKit.mjs to
// turn into review-only kits — nothing in this file sends anything
// anywhere.
//
// Usage: node scripts/outreach/discover.mjs > candidates.json
// (progress goes to stderr so stdout stays clean JSON for piping)

import { execFileSync } from "node:child_process";

// Precise, low-noise signals only — a repo either calls one of these
// providers directly or references their known env var names. Broad
// "gpu pricing" keyword searches were deliberately left out: GitHub
// code search doesn't support enough qualifiers to keep those precise,
// and a noisy candidate list just wastes review time later.
const SIGNALS = [
  { query: `"api.runpod.io" in:file`, label: "calls RunPod's API directly" },
  { query: `"RUNPOD_API_KEY" in:file`, label: "references RUNPOD_API_KEY" },
  { query: `"cloud.lambdalabs.com" in:file`, label: "calls Lambda Labs' API directly" },
  { query: `"LAMBDA_API_KEY" in:file`, label: "references LAMBDA_API_KEY" },
  // Widened 2026-09-24 — still precise (a real SDK import / a real,
  // specific env var name), not a broad keyword match. "gpu pricing"-
  // style keyword signals were deliberately left out even at this
  // widening: GitHub code search can't qualify them precisely enough,
  // and the noise would cost more review time than it's worth.
  { query: `"from runpod import" in:file`, label: "imports RunPod's official Python SDK" },
  { query: `"RUNPOD_ENDPOINT_ID" in:file`, label: "references RUNPOD_ENDPOINT_ID (serverless)" },
];

// The providers' own orgs match every signal by construction (their
// own SDKs/docs/examples reference their own API and env vars) — real
// finding from the first live test run, not a hypothetical: RunPod's
// own runpodctl and worker-a1111 repos both matched. These are the
// provider, not a customer of the provider; excluded, not a lead.
// "lambdalabsml" added 2026-09-24: 4 of 60 hits in one run, same
// pattern as runpod/runpod-workers. Not conclusively provable via the
// API (no blog/homepage link tying it to the company) — inferred from
// the org name plus repeat-hit pattern, not certain. Worth a human
// double-check if it starts producing false negatives (excluding a
// real, unrelated "LambdaLabsML" someone else owns).
const EXCLUDED_OWNERS = new Set(["runpod", "runpod-workers", "lambdalabs", "lambda-labs", "lambdalabsml", "coreweave"]);

const MAX_RESULTS_PER_SIGNAL = Number(process.env.OUTREACH_MAX_PER_SIGNAL ?? 30);
// Code search is rate-limited harder than general REST search — stay
// well under it rather than tune this to the exact documented limit.
const SEARCH_DELAY_MS = 7000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ghApi(path) {
  const raw = execFileSync("gh", ["api", path], { encoding: "utf-8", maxBuffer: 1024 * 1024 * 20 });
  return JSON.parse(raw);
}

async function searchSignal(signal) {
  const q = encodeURIComponent(signal.query);
  let result;
  try {
    result = ghApi(`search/code?q=${q}&per_page=${MAX_RESULTS_PER_SIGNAL}`);
  } catch (err) {
    console.error(`  ! search failed for ${signal.query}: ${String(err.message).split("\n")[0]}`);
    return [];
  }
  return (result.items ?? []).map((item) => ({
    owner: item.repository.owner.login,
    repo: item.repository.name,
    fullName: item.repository.full_name,
    url: item.repository.html_url,
    path: item.path,
    signal: signal.label,
  }));
}

async function enrichCandidate(candidate) {
  try {
    const repoMeta = ghApi(`repos/${candidate.fullName}`);
    return {
      ...candidate,
      description: repoMeta.description ?? "",
      language: repoMeta.language ?? null,
      stars: repoMeta.stargazers_count ?? 0,
      fork: repoMeta.fork ?? false,
      archived: repoMeta.archived ?? false,
    };
  } catch {
    return { ...candidate, description: "", language: null, stars: 0, fork: false, archived: false };
  }
}

export async function discover() {
  const seen = new Map(); // fullName -> candidate (dedupe across signals, keep first match)
  for (const signal of SIGNALS) {
    console.error(`Searching: ${signal.query}`);
    const hits = await searchSignal(signal);
    for (const hit of hits) {
      if (!seen.has(hit.fullName)) seen.set(hit.fullName, hit);
    }
    await sleep(SEARCH_DELAY_MS);
  }

  const candidates = [];
  for (const candidate of seen.values()) {
    if (EXCLUDED_OWNERS.has(candidate.owner.toLowerCase())) continue;
    const enriched = await enrichCandidate(candidate);
    // Forks and archived repos are a weak lead — whoever owns the fork
    // isn't the one actively deciding what this codebase integrates,
    // and an archived repo isn't accepting new integrations at all.
    if (enriched.fork || enriched.archived) continue;
    candidates.push(enriched);
  }
  return candidates;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const candidates = await discover();
  console.error(`\nFound ${candidates.length} candidate repo(s):\n`);
  for (const c of candidates) {
    console.error(`  ${c.fullName} (${c.language ?? "unknown"}, ★${c.stars}) — ${c.signal}`);
  }
  console.log(JSON.stringify(candidates, null, 2));
}
