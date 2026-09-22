import type { FastifyInstance } from "fastify";

/**
 * The smallest possible public onboarding page: create a key, pick a
 * credit pack, get redirected to a real Stripe Checkout Session. Same-
 * origin fetch calls to /v1/signup and /v1/checkout-sessions — no CORS
 * config needed, no Stripe.js/publishable key needed (redirecting to a
 * Checkout Session URL is a plain browser navigation, not a client-side
 * Stripe SDK call). Never touches /v1/admin/* or ADMIN_SECRET.
 */
export interface PublicPageDeps {
  lambdaDispatchIsReal: boolean;
  runpodDispatchIsReal: boolean;
}

export function registerPublicSignupPage(app: FastifyInstance, deps: PublicPageDeps): void {
  app.get("/", async (_request, reply) => {
    reply.type("text/html").send(buildHtml(deps.lambdaDispatchIsReal, deps.runpodDispatchIsReal));
  });
}

function buildHtml(lambdaDispatchIsReal: boolean, runpodDispatchIsReal: boolean): string {
  const liveVendors = [lambdaDispatchIsReal && "Lambda Labs", runpodDispatchIsReal && "RunPod"].filter(Boolean) as string[];
  const bookStatusLine = liveVendors.length > 0
    ? `<strong>POST /v1/route/book</strong> — live for ${liveVendors.join(" and ")}. Other providers still return a real "preview/unsupported" response, not fake dispatch.`
    : `<strong>POST /v1/route/book</strong> — preview / simulated. Dispatch logic and billing are real; the actual vendor call is a simulated placeholder (no real GPU is provisioned yet).`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ScoutWyze Compute — Get an API Key</title>
<style>
  body { font-family: -apple-system, sans-serif; max-width: 560px; margin: 60px auto; padding: 0 20px; color: #1a1a1a; }
  h1 { font-size: 22px; }
  p { color: #444; line-height: 1.5; }
  button { padding: 12px 20px; font-size: 14px; cursor: pointer; border: none; border-radius: 6px; background: #111; color: #fff; margin-top: 8px; }
  button:disabled { opacity: 0.5; cursor: default; }
  button.pack { display: block; width: 100%; background: #f5f5f5; color: #111; border: 1px solid #ddd; text-align: left; margin-top: 10px; }
  button.pack:hover { background: #eee; }
  #keyBox { margin-top: 20px; padding: 16px; background: #f5f5f5; border-radius: 8px; display: none; }
  #apiKey { font-family: monospace; font-size: 13px; word-break: break-all; background: #fff; padding: 8px; border-radius: 4px; border: 1px solid #ddd; }
  .warn { color: #b02a2a; font-size: 13px; margin-top: 8px; }
  #packs { margin-top: 20px; display: none; }
  #error { color: #b02a2a; margin-top: 12px; }
</style>
</head>
<body>
  <h1>ScoutWyze Compute</h1>
  <p>GPU placement quotes for AI infra agents. Get a free API key, then fund it to start making requests.</p>

  <div style="background:#f5f5f5;border-radius:8px;padding:12px 16px;margin-bottom:20px;font-size:13px;line-height:1.6">
    <div><strong>POST /v1/route/rank</strong> — live. Rule-based ranking (cheapest / fastest / balanced) over real ingested provider data.</div>
    <div>${bookStatusLine}</div>
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
