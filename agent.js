// File: agent.js
// Frontend controller for Bybit V5 Live-Only 6-Stage Quant Pipeline Terminal

(function () {
  const $ = (id) => document.getElementById(id);
  let chart = null;
  let candleSeries = null;
  let autoLoopTimer = null;

  function logLine(tag, msg, colorClass = 'text-slate-300') {
    const box = $('terminal-logs');
    if (!box) return;
    const ts = new Date().toLocaleTimeString();
    const div = document.createElement('div');
    div.className = colorClass;
    div.textContent = `[${ts}] [${tag}] ${msg}`;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
  }

  function showBanner(msg, type = 'info') {
    const b = $('status-banner');
    if (!b) return;
    b.classList.remove(
      'hidden',
      'bg-amber-500/10', 'border-amber-500/40', 'text-amber-300',
      'bg-emerald-500/10', 'border-emerald-500/40', 'text-emerald-300',
      'bg-rose-500/10', 'border-rose-500/40', 'text-rose-300'
    );
    if (type === 'error') {
      b.classList.add('bg-rose-500/10', 'border-rose-500/40', 'text-rose-300');
    } else if (type === 'success') {
      b.classList.add('bg-emerald-500/10', 'border-emerald-500/40', 'text-emerald-300');
    } else {
      b.classList.add('bg-amber-500/10', 'border-amber-500/40', 'text-amber-300');
    }
    b.textContent = msg;
  }

  function initChart() {
    const container = $('tv-chart');
    if (!container || typeof LightweightCharts === 'undefined') return;
    chart = LightweightCharts.createChart(container, {
      layout: { background: { color: '#090d16' }, textColor: '#94a3b8' },
      grid: { vertLines: { color: '#1e293b' }, horzLines: { color: '#1e293b' } },
      timeScale: { timeVisible: true, secondsVisible: false },
      rightPriceScale: { borderColor: '#1e293b' }
    });
    candleSeries = chart.addCandlestickSeries({
      upColor: '#10b981', downColor: '#ef4444', borderVisible: false,
      wickUpColor: '#10b981', wickDownColor: '#ef4444'
    });
  }

  async function loadChartCandles(symbol = 'BTC', tf = '15m') {
    try {
      const r = await fetch(`/api/futures-agent?action=bybit_klines&symbol=${encodeURIComponent(symbol)}&tf=${encodeURIComponent(tf)}`);
      const j = await r.json();
      if (j.ok && Array.isArray(j.candles) && candleSeries) {
        candleSeries.setData(j.candles);
        chart.timeScale().fitContent();
      }
    } catch (e) {
      logLine('CHART', `Failed to load klines: ${e.message}`, 'text-rose-400');
    }
  }

  function makeNonce() {
    return 'nonce_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  async function callAgent(payload) {
    const secret = ($('inp-secret')?.value || localStorage.getItem('agent_secret') || '').trim();
    if (secret) localStorage.setItem('agent_secret', secret);

    const r = await fetch('/api/futures-agent', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-agent-secret': secret,
        'x-request-nonce': makeNonce(),
        'x-request-ts': String(Date.now())
      },
      body: JSON.stringify(payload)
    });
    const data = await r.json();
    if (!r.ok) {
      throw new Error(data.error || data.noTradeReason || `HTTP ${r.status}`);
    }
    return data;
  }

  function updateAccountHeader(data) {
    if (data.wallet) {
      const avail = Number(data.wallet.availableBalance || 0).toFixed(2);
      const equity = Number(data.wallet.totalEquity || avail).toFixed(2);
      const uPnl = Number(data.wallet.unrealizedPnl || 0);
      $('kpi-balance').textContent = `$${avail}`;
      $('val-6').textContent = `$${equity} USDT`;
      $('kpi-pnl').textContent = `${uPnl >= 0 ? '+' : ''}$${uPnl.toFixed(4)}`;
      $('kpi-pnl').className = `text-sm md:text-base font-bold ${uPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`;
    }
    if (data.systemTelemetry?.liveTradingStatus) {
      const gate = data.systemTelemetry.liveTradingStatus;
      $('kpi-gate').textContent = gate;
      $('kpi-gate').className = gate === 'BYBIT_LIVE_ARMED'
        ? 'text-xs md:text-sm font-bold text-emerald-400'
        : 'text-xs md:text-sm font-bold text-amber-400';
    }
  }

  function updatePipelineCards(data) {
    updateAccountHeader(data);
    const pick = data.pick;
    if (!pick) return;

    $('stage-1').classList.add('stage-active');
    $('val-1').textContent = `${pick.bybitSymbol} (${pick.direction})`;
    $('sub-1').textContent = `Scanned ${data.scannedCount || 4} pairs · Spread ${pick.spreadPct}%`;

    const isNoTrade = pick.decision === 'NO_TRADE';
    $('stage-2').classList.toggle('stage-warn', isNoTrade);
    $('stage-2').classList.toggle('stage-active', !isNoTrade);
    $('badge-2').textContent = isNoTrade ? 'BLOCKED' : 'PASSED';
    $('badge-2').className = isNoTrade ? 'text-amber-400' : 'text-emerald-400';
    $('val-2').textContent = `MTF ${pick.mtfConfluenceScore}%`;
    $('sub-2').textContent = pick.noTradeReason || 'All safety gates passed';

    $('stage-3').classList.add('stage-active');
    $('val-3').textContent = `QTY: ${pick.orderQty}`;
    $('sub-3').textContent = `Step: ${pick.qtyStep} · R:R 1:${pick.rrRatio}`;

    $('val-4').textContent = pick.decision;
    $('sub-4').textContent = `Entry ${pick.entry} · SL ${pick.sl}`;

    $('chart-title').textContent = `${pick.bybitSymbol} · ${pick.chartTf.toUpperCase()} STRUCTURE (${pick.decision})`;
    $('chart-sub').textContent = pick.summaryNote || '';
    $('pill-entry').textContent = `Entry: ${pick.entry}`;
    $('pill-sl').textContent = `SL: ${pick.sl}`;
    $('pill-tp').textContent = `TP1: ${pick.tp1} | TP4: ${pick.tp}`;

    const bd = pick.mtfBreakdown || {};
    ['1D', '4H', '1H', '15M', '5M'].forEach(tf => {
      const el = $(`tf-${tf.toLowerCase()}`);
      if (!el) return;
      const v = bd[tf] || '--';
      el.textContent = v;
      el.className = v === 'BULL' ? 'font-bold text-emerald-400' : v === 'BEAR' ? 'font-bold text-rose-400' : 'font-bold text-slate-400';
    });

    loadChartCandles(pick.coin, pick.chartTf || '15m');
  }

  function renderPositions(positions = []) {
    const box = $('positions-box');
    const countEl = $('pos-count');
    if (countEl) countEl.textContent = `${positions.length} open`;
    if (!box) return;
    if (!positions.length) {
      box.innerHTML = '<span class="text-slate-500">No open Bybit positions.</span>';
      return;
    }
    box.innerHTML = positions.map(p => {
      const pnl = Number(p.unrealisedPnl || 0);
      const pnlColor = pnl >= 0 ? 'text-emerald-400' : 'text-rose-400';
      return `
        <div class="flex items-center justify-between py-2 border-b border-slate-800 last:border-0 gap-2">
          <div>
            <span class="font-bold ${p.side === 'Buy' ? 'text-emerald-400' : 'text-rose-400'}">${p.symbol} ${p.side === 'Buy' ? 'LONG' : 'SHORT'} (${p.leverage}x)</span>
            <div class="text-[11px] text-slate-400">Size: ${p.size} · Entry: ${p.avgPrice} · Mark: ${p.markPrice}</div>
            <div class="text-[11px] ${pnlColor}">uPnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(4)} · SL: ${p.stopLoss || '--'} · TP: ${p.takeProfit || '--'}</div>
          </div>
          <button onclick="window.__closeBybitPos('${p.symbol}','${p.side}','${p.size}')" class="px-2.5 py-1 rounded bg-rose-500/20 hover:bg-rose-500/40 text-rose-300 text-[11px] shrink-0">Close</button>
        </div>
      `;
    }).join('');
  }

  window.__closeBybitPos = async (symbol, side, size) => {
    try {
      logLine('EXECUTOR', `Closing live Bybit position ${symbol} (${side} ${size})...`, 'text-amber-300');
      const res = await callAgent({ action: 'close', symbol, side, qty: size, liveConfirmed: true });
      logLine('BYBIT', `Closed ${symbol} · Order ID: ${res.orderId}`, 'text-emerald-400');
      showBanner(`Closed live position ${symbol} (Order ${res.orderId})`, 'success');
      await refreshStatus();
    } catch (e) {
      logLine('ERROR', e.message, 'text-rose-400');
      showBanner(e.message, 'error');
    }
  };

  async function refreshStatus() {
    try {
      const st = await callAgent({ action: 'status' });
      updateAccountHeader(st);
      renderPositions(st.positions || []);
      logLine('BYBIT', `Synced Unified Wallet: $${Number(st.wallet?.availableBalance || 0).toFixed(2)} avail · ${(st.positions || []).length} open pos.`, 'text-sky-300');
    } catch (e) {
      logLine('AUTH', `Sync status: ${e.message}`, 'text-amber-400');
    }
  }

  async function runAnalyze() {
    try {
      logLine('SCANNER', 'Scanning Bybit V5 closed candles across 5 timeframes...', 'text-sky-300');
      const res = await callAgent({
        action: 'analyze_only',
        coinMode: $('inp-coin-mode').value,
        manualCoin: $('inp-manual-coin').value,
        humanBias: $('inp-bias').value,
        riskPerTradePct: Number($('inp-risk').value || 3) / 100
      });
      updatePipelineCards(res);
      if (res.decision === 'NO_TRADE') {
        logLine('SAFETY', res.noTradeReason || 'NO_TRADE triggered.', 'text-amber-300');
        showBanner(res.noTradeReason || 'NO_TRADE: Waiting for stronger MTF alignment.', 'info');
      } else {
        logLine('SCANNER', `Setup ready: ${res.pick.bybitSymbol} ${res.decision} @ ${res.pick.entry} (Qty ${res.pick.orderQty})`, 'text-emerald-400');
        showBanner(`Setup Verified: ${res.pick.bybitSymbol} ${res.decision} · Entry ${res.pick.entry} · SL ${res.pick.sl}`, 'success');
      }
    } catch (e) {
      logLine('ERROR', e.message, 'text-rose-400');
      showBanner(e.message, 'error');
    }
  }

  async function runExecute() {
    try {
      const liveConfirmed = $('inp-live-confirm').checked;
      if (!liveConfirmed) {
        showBanner('Tick "Arm Real Bybit Orders" before executing a live trade.', 'error');
        return;
      }
      logLine('EXECUTOR', 'Submitting LIVE Bybit V5 Linear order...', 'text-rose-300');
      const res = await callAgent({
        action: 'scan_and_trade',
        liveConfirmed: true,
        coinMode: $('inp-coin-mode').value,
        manualCoin: $('inp-manual-coin').value,
        humanBias: $('inp-bias').value,
        riskPerTradePct: Number($('inp-risk').value || 3) / 100,
        leverage: Number($('inp-lev').value || 5)
      });
      updatePipelineCards(res);
      logLine('BYBIT', res.exec?.orderTypeLabel || 'Live order placed.', 'text-emerald-400');
      showBanner(`LIVE ORDER FILLED: ${res.exec?.orderTypeLabel}`, 'success');
      await refreshStatus();
    } catch (e) {
      logLine('BLOCKED', e.message, 'text-rose-400');
      showBanner(e.message, 'error');
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    const savedSec = localStorage.getItem('agent_secret');
    if (savedSec && $('inp-secret')) $('inp-secret').value = savedSec;

    initChart();
    loadChartCandles('BTC', '15m');
    refreshStatus();

    $('btn-analyze')?.addEventListener('click', runAnalyze);
    $('btn-trade')?.addEventListener('click', runExecute);
    $('btn-refresh')?.addEventListener('click', refreshStatus);
    $('btn-clear-logs')?.addEventListener('click', () => { $('terminal-logs').innerHTML = ''; });

    $('btn-stop')?.addEventListener('click', async () => {
      if (!confirm('Close ALL open live Bybit USDT positions immediately?')) return;
      try {
        logLine('EMERGENCY', 'Sending Emergency Close All to Bybit V5...', 'text-rose-400');
        const res = await callAgent({ action: 'emergency_stop', liveConfirmed: true });
        logLine('EMERGENCY', `Closed ${res.closedCount || 0} live positions.`, 'text-rose-300');
        showBanner(`Emergency Stop complete: closed ${res.closedCount || 0} Bybit positions.`, 'error');
        await refreshStatus();
      } catch (e) { showBanner(e.message, 'error'); }
    });

    $('btn-autopilot')?.addEventListener('click', () => {
      if (autoLoopTimer) {
        clearInterval(autoLoopTimer);
        autoLoopTimer = null;
        $('btn-autopilot').textContent = 'Auto-Scan Loop: OFF';
        logLine('SYSTEM', 'Auto-Scan loop stopped.', 'text-slate-400');
      } else {
        runAnalyze();
        autoLoopTimer = setInterval(runAnalyze, 30000);
        $('btn-autopilot').textContent = 'Auto-Scan Loop: ON (30s)';
        logLine('SYSTEM', 'Auto-Scan loop started (30s interval).', 'text-emerald-400');
      }
    });
  });
})();
