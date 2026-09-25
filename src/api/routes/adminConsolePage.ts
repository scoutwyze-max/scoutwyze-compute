import type { FastifyInstance } from "fastify";
import { hasValidSession } from "../../admin/session.js";

export interface AdminConsolePageDeps {
  adminSecret: string;
}

/**
 * GET /admin — hidden (2026-09-24, Robert: "host it as a hidden,
 * session-gated admin path directly on scoutwyze-compute.fly.dev"):
 * never linked from publicPage.ts, llms.txt, or the sitemap. "Hidden"
 * here means "not advertised," not "the real security boundary" — the
 * actual boundary is the session cookie check below, same as any
 * other admin route.
 */
export function registerAdminConsolePage(app: FastifyInstance, deps: AdminConsolePageDeps): void {
  app.get("/admin", async (request, reply) => {
    const authed = hasValidSession(request, deps.adminSecret);
    reply.type("text/html").send(authed ? dashboardHtml() : loginHtml());
  });
}

function baseStyles(): string {
  return `
  * { box-sizing: border-box; }
  body { margin: 0; background: #0a0a0a; color: #e4e4e7; font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 13px; }
  .wrap { max-width: 1080px; margin: 0 auto; padding: 32px 20px; }
  h1 { font-size: 15px; font-weight: 600; letter-spacing: 0.02em; color: #fafafa; margin: 0 0 4px; }
  .sub { color: #71717a; font-size: 12px; margin: 0 0 28px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; margin-bottom: 24px; }
  .card { background: #111113; border: 1px solid #26262b; border-radius: 8px; padding: 14px 16px; }
  .card .label { color: #71717a; font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 6px; }
  .card .value { color: #fafafa; font-size: 20px; font-weight: 600; }
  section { margin-bottom: 28px; }
  section h2 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: #a1a1aa; border-bottom: 1px solid #26262b; padding-bottom: 8px; margin-bottom: 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th { text-align: left; color: #71717a; font-weight: 500; padding: 6px 10px; border-bottom: 1px solid #26262b; }
  td { padding: 6px 10px; border-bottom: 1px solid #1a1a1d; color: #d4d4d8; }
  tr:last-child td { border-bottom: none; }
  .pill { display: inline-block; padding: 1px 7px; border-radius: 100px; font-size: 10.5px; }
  .pill.charge { background: #2a1515; color: #f87171; }
  .pill.topup { background: #142a1a; color: #4ade80; }
  .pill.bearer { background: #14202a; color: #60a5fa; }
  .pill.x402 { background: #221a2a; color: #c084fc; }
  .mono { font-family: inherit; }
  .feed { background: #111113; border: 1px solid #26262b; border-radius: 8px; padding: 12px 14px; max-height: 280px; overflow-y: auto; font-size: 12px; line-height: 1.7; }
  .feed .line { color: #a1a1aa; }
  .feed .line .t { color: #52525b; margin-right: 8px; }
  .feed .line.run_started .msg { color: #60a5fa; }
  .feed .line.run_completed .msg { color: #4ade80; }
  .feed .line.run_failed .msg { color: #f87171; }
  button { background: #fafafa; color: #0a0a0a; border: none; border-radius: 6px; padding: 8px 14px; font-size: 12.5px; font-weight: 600; cursor: pointer; font-family: inherit; }
  button:hover { background: #d4d4d8; }
  button:disabled { opacity: 0.4; cursor: default; }
  button.ghost { background: transparent; color: #71717a; border: 1px solid #26262b; }
  input { background: #111113; border: 1px solid #26262b; border-radius: 6px; padding: 9px 12px; color: #fafafa; font-family: inherit; font-size: 13px; width: 100%; }
  .row { display: flex; gap: 8px; align-items: center; }
  .err { color: #f87171; font-size: 12px; margin-top: 8px; }
  a { color: #71717a; }
  `;
}

function loginHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>ScoutWyze Compute — Admin</title>
<style>${baseStyles()}
  .center { min-height: 100vh; display: flex; align-items: center; justify-content: center; }
  .box { width: 320px; }
</style></head>
<body>
  <div class="center"><div class="box">
    <h1>ScoutWyze Compute</h1>
    <p class="sub">Admin console</p>
    <input id="secret" type="password" placeholder="X-Admin-Secret" autofocus />
    <div style="height:10px"></div>
    <button id="loginBtn" style="width:100%">Log in</button>
    <div id="err" class="err"></div>
  </div></div>
  <script>
    const $ = (id) => document.getElementById(id);
    async function login() {
      $('err').textContent = '';
      $('loginBtn').disabled = true;
      try {
        const res = await fetch('/v1/admin/session', { method: 'POST', headers: { 'X-Admin-Secret': $('secret').value } });
        if (!res.ok) throw new Error('Invalid secret');
        location.reload();
      } catch (e) {
        $('err').textContent = e.message;
        $('loginBtn').disabled = false;
      }
    }
    $('loginBtn').addEventListener('click', login);
    $('secret').addEventListener('keydown', (e) => { if (e.key === 'Enter') login(); });
  </script>
</body></html>`;
}

function dashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>ScoutWyze Compute — Admin</title>
<style>${baseStyles()}</style></head>
<body>
  <div class="wrap">
    <div class="row" style="justify-content:space-between">
      <div>
        <h1>ScoutWyze Compute</h1>
        <p class="sub">Admin console</p>
      </div>
      <button class="ghost" id="logoutBtn">Log out</button>
    </div>

    <section>
      <h2>Revenue &amp; credit overview</h2>
      <div class="grid" id="kpis"></div>
      <div class="grid" style="grid-template-columns: 1fr 1fr">
        <div>
          <h2 style="font-size:10.5px">Recent ledger activity</h2>
          <table><thead><tr><th>Account</th><th>Type</th><th>Amount</th><th>Balance after</th><th>When</th></tr></thead>
          <tbody id="ledgerRows"></tbody></table>
        </div>
        <div>
          <h2 style="font-size:10.5px">Account balances</h2>
          <table><thead><tr><th>Account</th><th>Balance</th></tr></thead>
          <tbody id="balanceRows"></tbody></table>
        </div>
      </div>
    </section>

    <section>
      <h2>Endpoint telemetry (24h)</h2>
      <div class="grid" id="telemetry"></div>
    </section>

    <section>
      <h2>Base on-chain settlements (x402 / USDC)</h2>
      <table><thead><tr><th>Tx hash</th><th>Payer</th><th>Amount</th><th>When</th></tr></thead>
      <tbody id="settlementRows"></tbody></table>
    </section>

    <section>
      <h2>Recent requests</h2>
      <table><thead><tr><th>Route</th><th>Rail</th><th>Identifier</th><th>Status</th><th>Latency</th><th>When</th></tr></thead>
      <tbody id="requestRows"></tbody></table>
    </section>

    <section>
      <h2>Agent feed</h2>
      <div class="feed" id="agentFeed"></div>
      <div style="height:10px"></div>
      <div class="row">
        <button id="runOutreachBtn">Run outreach discovery</button>
        <span id="runStatus" class="sub" style="margin:0"></span>
      </div>
    </section>
  </div>

  <script>
    const $ = (id) => document.getElementById(id);
    const usd = (n) => '$' + Number(n).toFixed(2);
    const when = (iso) => new Date(iso).toLocaleString();

    async function api(path, opts) {
      const res = await fetch(path, opts);
      if (res.status === 401) { location.reload(); throw new Error('session expired'); }
      return res.json();
    }

    async function loadOverview() {
      const d = await api('/v1/admin/console/overview');
      $('kpis').innerHTML = [
        ['Active API keys', d.activeApiKeys],
        ['24h revenue', usd(d.revenue24hUsd)],
        ['Burn rate', usd(d.burnRatePerHourUsd) + '/hr'],
      ].map(([label, value]) => \`<div class="card"><div class="label">\${label}</div><div class="value">\${value}</div></div>\`).join('');

      $('ledgerRows').innerHTML = d.recentLedger.map((e) => \`
        <tr><td>\${e.accountId}</td><td><span class="pill \${e.type}">\${e.type}</span></td>
        <td>\${usd(e.amountUsd)}</td><td>\${usd(e.balanceAfterUsd)}</td><td>\${when(e.createdAt)}</td></tr>
      \`).join('') || '<tr><td colspan="5" class="sub">No activity yet.</td></tr>';

      $('balanceRows').innerHTML = d.accountBalances.map((b) => \`
        <tr><td>\${b.accountId}</td><td>\${usd(b.balanceUsd)}</td></tr>
      \`).join('') || '<tr><td colspan="2" class="sub">No accounts yet.</td></tr>';
    }

    async function loadTelemetry() {
      const d = await api('/v1/admin/console/telemetry');
      $('telemetry').innerHTML = d.routes.map((r) => \`
        <div class="card">
          <div class="label">\${r.route}</div>
          <div class="value">\${r.count}</div>
          <div class="sub" style="margin:4px 0 0">\${r.errorCount} errors · \${r.avgLatencyMs ?? '–'}ms avg</div>
        </div>
      \`).join('');
    }

    const shortHash = (h) => h.length > 14 ? h.slice(0, 8) + '…' + h.slice(-6) : h;
    const shortAddr = (a) => a && a.length > 12 ? a.slice(0, 6) + '…' + a.slice(-4) : (a || '–');

    async function loadSettlements() {
      const d = await api('/v1/admin/console/settlements');
      $('settlementRows').innerHTML = d.settlements.map((s) => \`
        <tr><td><a href="https://basescan.org/tx/\${s.txHash}" target="_blank" rel="noopener" class="mono">\${shortHash(s.txHash)}</a></td>
        <td class="mono">\${shortAddr(s.payerAddress)}</td><td>\${usd(s.amountUsd)}</td><td>\${when(s.processedAt)}</td></tr>
      \`).join('') || '<tr><td colspan="4" class="sub">No on-chain settlements yet.</td></tr>';
    }

    async function loadRequests() {
      const d = await api('/v1/admin/console/requests');
      $('requestRows').innerHTML = d.requests.map((r) => \`
        <tr><td>\${r.route}</td>
        <td>\${r.rail ? \`<span class="pill \${r.rail}">\${r.rail}</span>\` : '<span class="sub">–</span>'}</td>
        <td class="mono">\${r.identifier || '–'}</td>
        <td>\${r.statusCode}</td><td>\${r.latencyMs}ms</td><td>\${when(r.createdAt)}</td></tr>
      \`).join('') || '<tr><td colspan="6" class="sub">No requests logged yet.</td></tr>';
    }

    async function loadAgentFeed() {
      const d = await api('/v1/admin/console/agent-log');
      $('agentFeed').innerHTML = d.entries.map((e) => \`
        <div class="line \${e.kind}"><span class="t">\${when(e.createdAt)}</span><span class="msg">\${e.message}</span></div>
      \`).join('') || '<div class="sub">No agent activity yet.</div>';
      $('agentFeed').scrollTop = $('agentFeed').scrollHeight;
    }

    async function runOutreach() {
      $('runOutreachBtn').disabled = true;
      $('runStatus').textContent = 'starting…';
      try {
        const res = await fetch('/v1/admin/console/agent-runs/outreach', { method: 'POST' });
        const body = await res.json();
        $('runStatus').textContent = res.ok ? 'started — watch the feed below' : body.message;
      } catch (e) {
        $('runStatus').textContent = 'failed to start';
      }
      setTimeout(() => { $('runOutreachBtn').disabled = false; $('runStatus').textContent = ''; }, 5000);
    }

    $('runOutreachBtn').addEventListener('click', runOutreach);
    $('logoutBtn').addEventListener('click', async () => { await fetch('/v1/admin/session/logout', { method: 'POST' }); location.reload(); });

    function refreshAll() { loadOverview(); loadTelemetry(); loadSettlements(); loadRequests(); loadAgentFeed(); }
    refreshAll();
    setInterval(refreshAll, 8000);
  </script>
</body></html>`;
}
