// File: agent.js (v15.0 — SV MODE ONLY Dashboard Controller)
const $ = id => document.getElementById(id);

function esc(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function logLine(msg, tone = 'slate') {
  const box = $('terminal-logs');
  if (!box) return;
  const color = tone === 'ok' ? 'text-emerald-400' : tone === 'err' ? 'text-rose-400' : tone === 'warn' ? 'text-amber-300' : 'text-slate-300';
  const t = new Date().toLocaleTimeString();
  const div = document.createElement('div');
  div.className = color;
  div.textContent = `[${t}] ${msg}`;
  box.prepend(div);
}

function getSecret() {
  const val = ($('agent-secret')?.value || '').trim();
  if (val) sessionStorage.setItem('sv_agent_secret', val);
  return val || sessionStorage.getItem('sv_agent_secret') || '';
}

async function callApi(action, extra = {}) {
  const secret = getSecret();
  if (!secret) {
    $('status-msg').textContent = '⚠️ Please enter your AGENT_SECRET password first.';
    return null;
  }
  const resp = await fetch('/api/futures-agent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-agent-secret': secret },
    body: JSON.stringify({ action, ...extra })
  });
  const data = await resp.json().catch(() => ({ ok: false, error: 'Invalid JSON response' }));
  if (!resp.ok || !data.ok) {
    const err = data.error || `HTTP ${resp.status}`;
    $('status-msg').textContent = `❌ ${err}`;
    logLine(`ERROR (${action}): ${err}`, 'err');
    return null;
  }
  return data;
}

function renderStatus(data) {
  const w = data.wallet || { availableBalance: 0, totalEquity: 0 };
  const s = data.svStats || { trades: 0, wins: 0, losses: 0, cuts: 0, netPnl: 0 };
  const wr = s.trades ? ((s.wins / s.trades) * 100).toFixed(1) : '0.0';

  $('stat-avail').textContent = `$${Number(w.availableBalance || 0).toFixed(2)}`;
  $('stat-equity').textContent = `$${Number(w.totalEquity || 0).toFixed(2)}`;
  $('stat-sv-pnl').textContent = `${s.netPnl >= 0 ? '+' : ''}$${Number(s.netPnl || 0).toFixed(3)}`;
  $('stat-sv-pnl').className = `text-xl font-bold mono mt-1 ${s.netPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`;
  $('stat-sv-wr').textContent = `${s.cuts || 0} cuts · ${wr}%`;

  const svBadge = $('badge-sv');
  svBadge.textContent = data.svActive ? (data.svPaperMode ? 'SV: ON (PAPER)' : 'SV: ON 🟢') : 'SV: OFF ⚪';
  svBadge.className = `text-xs px-2.5 py-1 rounded-full mono ${data.svActive ? 'bg-emerald-500/20 text-emerald-300' : 'bg-slate-800 text-slate-400'}`;

  const liveBadge = $('badge-live');
  liveBadge.textContent = data.halted ? 'HALTED 🚨' : (data.liveAuthorized && data.autoExecute ? 'AUTO_LIVE 🟢' : 'MANUAL');
  liveBadge.className = `text-xs px-2.5 py-1 rounded-full mono ${data.halted ? 'bg-rose-500/20 text-rose-300' : 'bg-sky-500/20 text-sky-300'}`;

  const posBox = $('positions-box');
  const positions = data.positions || [];
  if (!positions.length) {
    posBox.innerHTML = '<span class="text-slate-500">No open positions right now.</span>';
  } else {
    posBox.innerHTML = positions.map(p => {
      const pnl = Number(p.unrealisedPnl || 0);
      const cls = pnl >= 0 ? 'text-emerald-400' : 'text-rose-400';
      return `<div class="flex flex-wrap items-center justify-between gap-2 bg-slate-950 border border-slate-800 rounded-lg p-2.5 mb-2">
        <div>
          <span class="font-bold text-white">${esc(p.symbol)}</span>
          <span class="ml-2 text-sky-300">${esc(p.side)} ${esc(p.leverage)}x</span>
          <span class="ml-2 text-slate-400">Qty: ${esc(p.size)} · Entry: $${esc(p.avgPrice)}</span>
        </div>
        <div class="flex items-center gap-3">
          <span class="font-bold ${cls}">${pnl >= 0 ? '+' : ''}$${pnl.toFixed(3)}</span>
          <button data-close="${esc(p.symbol)}" class="px-2 py-1 rounded bg-rose-600/80 hover:bg-rose-500 text-white text-[10px]">Close</button>
        </div>
      </div>`;
    }).join('');
    posBox.querySelectorAll('[data-close]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const sym = btn.getAttribute('data-close');
        logLine(`Closing ${sym}...`, 'warn');
        const res = await callApi('close_position', { symbol: sym });
        if (res) {
          logLine(`Closed ${sym}`, 'ok');
          syncStatus();
        }
      });
    });
  }

  $('status-msg').textContent = `✅ Synced · ${positions.length} open position(s) · Today SV: ${s.trades} trades (${s.wins}W/${s.losses}L)`;
}

async function syncStatus() {
  const data = await callApi('status');
  if (data) {
    renderStatus(data);
    logLine(`Synced: Avail $${Number(data.wallet?.availableBalance || 0).toFixed(2)} | Equity $${Number(data.wallet?.totalEquity || 0).toFixed(2)}`, 'ok');
  }
}

window.addEventListener('DOMContentLoaded', () => {
  const saved = sessionStorage.getItem('sv_agent_secret');
  if (saved && $('agent-secret')) $('agent-secret').value = saved;

  $('btn-sync')?.addEventListener('click', syncStatus);
  $('btn-clear-log')?.addEventListener('click', () => { $('terminal-logs').innerHTML = ''; });

  $('btn-run-sv')?.addEventListener('click', async () => {
    logLine('Running Standalone SV Engine scan...', 'warn');
    const res = await callApi('run_sv_now');
    if (res) {
      const sv = res.svEngine || {};
      if (sv.openedTrade) {
        logLine(`⚡ OPENED ${sv.openedTrade.direction} ${sv.openedTrade.symbol} (${sv.openedTrade.leverage}x) TP ${sv.openedTrade.tpPrice} SL ${sv.openedTrade.slPrice}`, 'ok');
      } else {
        logLine(`SV Scan done: ${sv.entrySkippedReason || 'Checked positions'}`, 'slate');
      }
      syncStatus();
    }
  });

  $('btn-toggle-sv')?.addEventListener('click', async () => {
    const res = await callApi('toggle_sv_mode');
    if (res) {
      logLine(`SV Mode switched to: ${res.svActive ? 'ON' : 'OFF'}`, 'ok');
      syncStatus();
    }
  });

  $('btn-resume')?.addEventListener('click', async () => {
    const res = await callApi('resume_trading');
    if (res) {
      logLine('Trading resumed (halt cleared).', 'ok');
      syncStatus();
    }
  });

  $('btn-stop')?.addEventListener('click', async () => {
    if (!confirm('Emergency Stop & Close ALL open positions?')) return;
    const res = await callApi('emergency_stop');
    if (res) {
      logLine(`🚨 Emergency Stop executed. Closed ${res.closedCount || 0} positions.`, 'err');
      syncStatus();
    }
  });
});
