import type { FastifyInstance } from "fastify";

/**
 * The public landing page: hero, a free sample curl, a paid rank curl,
 * an example response, then create-a-key + credit-pack checkout. Same-
 * origin fetch calls to /v1/signup and /v1/checkout-sessions — no CORS
 * config needed, no Stripe.js/publishable key needed (redirecting to a
 * Checkout Session URL is a plain browser navigation, not a client-side
 * Stripe SDK call). Never touches /v1/admin/* or ADMIN_SECRET.
 */
export interface PublicPageDeps {
  baseUrl: string;
  // Real gap closed 2026-09-23 — see discovery.ts's DiscoveryRouteDeps
  // doc comment for both of these; kept in sync with what llms.txt and
  // openapi.json say, since a reader could land on either page first.
  runpodIsLive: boolean;
  bookIsPublished: boolean;
}

export function registerPublicSignupPage(app: FastifyInstance, deps: PublicPageDeps): void {
  app.get("/", async (_request, reply) => {
    reply.type("text/html").send(buildHtml(deps));
  });
}

function buildHtml(deps: PublicPageDeps): string {
  const coverageLine = deps.runpodIsLive
    ? `RunPod offers below are sourced from RunPod's own live catalog API, refreshed continuously. Lambda Labs/CoreWeave rows (visible via the <code>source</code> field) are fixture data for comparison only — never live, never bookable.`
    : `Every offer right now is fixture/mock data, not live-polled — this deployment doesn't have live RunPod ingestion configured. Check each offer's own <code>source</code> field before trusting a number.`;

  const bookSubClause = deps.bookIsPublished ? " Optional booking for eligible RunPod offers." : "";

  const bookSection = deps.bookIsPublished
    ? `<div style="margin-top:12px"><strong>POST /v1/route/book</strong> — re-runs rank server-side, dispatches only to RunPod, debits only after RunPod accepts the job (~15% fee on top of RunPod's own price). Never books Lambda Labs or CoreWeave.</div>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ScoutWyze Compute</title>
<style>
  body { font-family: -apple-system, sans-serif; max-width: 640px; margin: 60px auto; padding: 0 20px; color: #1a1a1a; }
  h1 { font-size: 24px; margin-bottom: 4px; }
  .sub { color: #555; margin-top: 0; }
  p { color: #444; line-height: 1.5; }
  pre { background: #111; color: #eee; padding: 14px 16px; border-radius: 8px; font-size: 12.5px; overflow-x: auto; }
  .label { font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; color: #888; margin: 24px 0 6px; }
  .coverage { background: #f5f5f5; border-radius: 8px; padding: 12px 16px; font-size: 13px; line-height: 1.6; margin-top: 20px; }
  button { padding: 12px 20px; font-size: 14px; cursor: pointer; border: none; border-radius: 6px; background: #111; color: #fff; margin-top: 8px; }
  button:disabled { opacity: 0.5; cursor: default; }
  button.pack { display: block; width: 100%; background: #f5f5f5; color: #111; border: 1px solid #ddd; text-align: left; margin-top: 10px; }
  button.pack:hover { background: #eee; }
  #keyBox { margin-top: 20px; padding: 16px; background: #f5f5f5; border-radius: 8px; display: none; }
  #apiKey { font-family: monospace; font-size: 13px; word-break: break-all; background: #fff; padding: 8px; border-radius: 4px; border: 1px solid #ddd; }
  .warn { color: #b02a2a; font-size: 13px; margin-top: 8px; }
  #packs { margin-top: 20px; display: none; }
  #error { color: #b02a2a; margin-top: 12px; }
  code { background: #f0f0f0; padding: 1px 5px; border-radius: 3px; font-size: 0.92em; }
</style>
</head>
<body>
  <h1>ScoutWyze Compute</h1>
  <p class="sub">Rank current RunPod GPU offers for your workload. Timestamped quotes and scores.${bookSubClause} $10 prepaid, no subscription.</p>

  <div class="label">1. Try it free — no key required</div>
  <pre>curl ${deps.baseUrl}/v1/route/sample</pre>

  <div class="label">2. Real query with your own key</div>
  <pre>curl -X POST ${deps.baseUrl}/v1/route/rank \\
  -H "Authorization: Bearer sw_live_..." \\
  -H "Content-Type: application/json" \\
  -d '{"gpuClass":"H100","preference":"cheapest"}'</pre>

  <div class="label">Example response</div>
  <pre>{
  "status": "ok",
  "recommended": {
    "provider": "runpod",
    "sku": "NVIDIA H100 80GB HBM3",
    "region": "US-CA-2",
    "vendorHourly": 21.2,
    "observed_at": "2026-09-23T00:17:35.911Z",
    "freshness_seconds": 41,
    "source": "live_api",
    "availability_status": "low",
    "score": 0.999,
    "reason": "Cheapest match on runpod: $21.20/hr (price score 1.00), updated just now."
  },
  "alternatives": [ ... ],
  "creditsRemaining": 9.85
}</pre>

  <div class="coverage">${coverageLine}</div>

  <div class="coverage">
    <div><strong>POST /v1/route/rank</strong> — Bearer-only (no x402 on this route). $0.15/request, debited only on a real match.</div>
    ${bookSection}
  </div>

  <button id="createBtn">Create API Key</button>
  <div id="error"></div>

  <div id="keyBox">
    <div>Your API key (shown once — save it now):</div>
    <div id="apiKey"></div>
    <div class="warn">This cannot be shown again. Store it before continuing.</div>
  </div>

  <div id="packs">
    <p>Pick a credit pack to fund your account:</p>
    <div id="packButtons"></div>
  </div>

  <p style="margin-top:32px;font-size:13px;color:#888">
    Questions or something broken? support@scoutwyze.com &middot;
    <a href="/llms.txt">llms.txt</a> &middot;
    <a href="/openapi.json">openapi.json</a>
  </p>

<script>
  const $ = (id) => document.getElementById(id);
  let accountId = null;

  $('createBtn').addEventListener('click', async () => {
    $('createBtn').disabled = true;
    $('error').textContent = '';
    try {
      const res = await fetch('/v1/signup', { method: 'POST' });
      if (!res.ok) throw new Error('Signup failed (' + res.status + ')');
      const data = await res.json();
      accountId = data.accountId;

      $('apiKey').textContent = data.apiKey;
      $('keyBox').style.display = 'block';

      const packButtons = $('packButtons');
      packButtons.innerHTML = '';
      for (const pack of data.creditPacks) {
        const btn = document.createElement('button');
        btn.className = 'pack';
        btn.textContent = pack.label + ' — $' + pack.amountUsd;
        btn.addEventListener('click', () => startCheckout(pack.id, btn));
        packButtons.appendChild(btn);
      }
      $('packs').style.display = 'block';
    } catch (err) {
      $('error').textContent = err.message;
      $('createBtn').disabled = false;
    }
  });

  async function startCheckout(packId, btn) {
    document.querySelectorAll('#packButtons button').forEach((b) => (b.disabled = true));
    $('error').textContent = '';
    try {
      const res = await fetch('/v1/checkout-sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId, packId }),
      });
      const data = await res.json();
      if (!res.ok || !data.checkoutUrl) throw new Error(data.message || 'Checkout session creation failed');
      window.location.href = data.checkoutUrl;
    } catch (err) {
      $('error').textContent = err.message;
      document.querySelectorAll('#packButtons button').forEach((b) => (b.disabled = false));
    }
  }
</script>
</body>
</html>`;
}
