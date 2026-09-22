#!/usr/bin/env node
// Post-deployment smoke test — hits a REAL running instance over HTTP,
// no mocks, no test harness. Run after every deploy:
//   node scripts/smoke-test.mjs https://scoutwyze-compute.fly.dev
//   node scripts/smoke-test.mjs                # defaults to localhost:8787
//
// Exits 0 if every check passes, 1 if any failed — every check runs
// regardless of earlier failures, so a single run surfaces the full
// diagnostic picture (not just the first thing that broke). Safe to
// wire into a deploy pipeline as a gate.

const BASE_URL = process.argv[2] ?? process.env.SMOKE_BASE_URL ?? "http://localhost:8787";

let failed = false;
function ok(label) {
  console.log(`  ✓ ${label}`);
}
function fail(label, detail) {
  failed = true;
  console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
}

async function checkHealth() {
  console.log("1. GET /healthz");
  const res = await fetch(`${BASE_URL}/healthz`);
  if (res.status !== 200) {
    fail("responds 200", `got ${res.status}`);
    return; // no body worth inspecting further
  }
  ok("responds 200");

  const body = await res.json();
  if (body.status === "ok") ok("status: ok");
  else fail("status: ok", `got ${JSON.stringify(body.status)}`);

  if (body.worker?.running) ok("background ingestion worker is running");
  else fail("background ingestion worker is running");

  // The exact bug this check exists to catch: `tsc` alone doesn't copy
  // the provider fixture JSON files into dist/ — a build missing that
  // step boots "healthy" but silently ingests zero facts from every
  // provider (fail-closed swallows the missing-file error into a
  // per-provider "failed" status rather than crashing). Caught live
  // 2026-09-21; this is the regression guard for it.
  const providers = body.providers ?? [];
  if (providers.length === 0) {
    fail("providers reported", "empty list");
  }
  for (const p of providers) {
    if (p.status === "ok") ok(`provider ${p.provider} ingested successfully`);
    else fail(`provider ${p.provider} ingested successfully`, `status=${p.status}`);
  }
}

async function checkRouting() {
  console.log("2. API routing — POST /v1/route/quote");
  const res = await fetch(`${BASE_URL}/v1/route/quote`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  if (res.status !== 402) {
    fail("unauthenticated request gets a 402 x402 challenge", `got ${res.status}`);
    return;
  }
  ok("unauthenticated request gets a 402 x402 challenge");

  const body = await res.json();
  if (body.x402Version === 1) ok("x402Version: 1");
  else fail("x402Version: 1", `got ${body.x402Version}`);

  if (body.accepts?.[0]?.nonce) ok("challenge includes a real nonce");
  else fail("challenge includes a real nonce");

  if (/^0x[0-9a-fA-F]{40}$/.test(body.accepts?.[0]?.payTo ?? "")) ok("challenge's payTo is a well-formed address");
  else fail("challenge's payTo is a well-formed address", body.accepts?.[0]?.payTo);
}

async function checkDatabaseRoundTrip() {
  console.log("3. Database round-trip — POST /v1/signup then use the key");
  const signupRes = await fetch(`${BASE_URL}/v1/signup`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  if (signupRes.status !== 201) {
    fail("signup returns 201", `got ${signupRes.status}`);
    return;
  }
  ok("signup returns 201");

  const { accountId, apiKey } = await signupRes.json();
  if (accountId && apiKey?.startsWith("sw_live_")) {
    ok("signup returns a real accountId + API key");
  } else {
    fail("signup returns a real accountId + API key");
    return;
  }

  // Proves the write actually landed in SQLite and is immediately
  // readable back — the meaningful thing a smoke test CAN verify about
  // persistence without controlling a real restart itself. A genuine
  // cross-restart check (does data survive a redeploy, not just a
  // write-then-immediately-read) is covered separately below when
  // SMOKE_KNOWN_ACCOUNT_ID/SMOKE_KNOWN_API_KEY are supplied, and by the
  // repo's own tests/integration/persistence.test.ts (close + reopen a
  // real file on disk).
  const quoteRes = await fetch(`${BASE_URL}/v1/route/quote`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: "{}",
  });
  const quoteBody = await quoteRes.json();
  if (quoteRes.status === 402 && quoteBody.error === "insufficient_credits") {
    ok("newly-created key round-trips through the database correctly ($0 balance, not 'unknown key')");
  } else {
    fail("newly-issued key authenticates as a real, known ($0-balance) account", `got status=${quoteRes.status} error=${quoteBody.error}`);
  }
}

async function checkCrossRestartPersistence() {
  const knownAccountId = process.env.SMOKE_KNOWN_ACCOUNT_ID;
  const knownApiKey = process.env.SMOKE_KNOWN_API_KEY;
  if (!knownAccountId || !knownApiKey) {
    console.log("4. Cross-restart persistence — SKIPPED (set SMOKE_KNOWN_ACCOUNT_ID + SMOKE_KNOWN_API_KEY, from an account created before this deploy, to actually exercise this)");
    return;
  }
  console.log("4. Cross-restart persistence — account created before this deploy still resolves");
  const res = await fetch(`${BASE_URL}/v1/route/quote`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${knownApiKey}` },
    body: "{}",
  });
  // 402 insufficient_credits (key known, $0) or 200 (key known, funded)
  // both prove the key survived; 402 payment_required (key unknown)
  // means the volume did NOT persist across the restart.
  const body = await res.json();
  if (res.status === 402 && body.error === "payment_required") {
    fail("pre-existing key still resolves after this deploy", "server no longer recognizes it — volume did not persist");
  } else {
    ok("pre-existing key still resolves after this deploy — volume persisted");
  }
}

console.log(`Smoke testing ${BASE_URL}\n`);
await checkHealth();
await checkRouting();
await checkDatabaseRoundTrip();
await checkCrossRestartPersistence();

console.log();
if (failed) {
  console.error("SMOKE TEST FAILED");
  process.exit(1);
} else {
  console.log("All smoke checks passed.");
  process.exit(0);
}
