// File: agent.js (v3 — M-03: No browser localStorage secret persistence, M-06: Honest status telemetry)
(function () {
  const $ = (id) => document.getElementById(id);
  let chart = null;
  let candleSeries = null;

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
    if (type === 'error') b.classList.add('bg-rose-500/10', 'border-rose-500/40', 'text-rose-300');
    else if (type === 'success') b.classList.add('bg-emerald-500/10', 'border-emerald-500/40', 'text-emerald-300');
    else b.classList.add('bg-amber-500/10', 'border-amber-500/40', 'text-amber-300');
    b.textContent = msg;
  }

  async function safeFetchJson(url, options = {}) {
    const r = await fetch(url, options);
    const raw = await r.text();
    let data = null;
    try { data = raw ? JSON.parse(raw) : {}; }
    catch (e) { throw new Error(`HTTP ${r.status} non-JSON response: ${raw.slice(0, 140)}`); }
    if (!r.ok) throw new Error(`${data.errorCode ? `[${data.errorCode}] ` : ''}${data.error || data.noTradeReason || `HTTP ${r.status}`}`);
    return data;
  }

  function makeNonce() {
    return 'n_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  }

  async function callAgent(payload) {
    // M-03: Never persist AGENT_SECRET in localStorage/sessionStorage
    const secret = ($('inp-secret')?.value || '').trim();
    return await safeFetchJson('/api/futures-agent', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-agent-secret': secret,
        'x-request-nonce': makeNonce(),
        'x-request-ts': String(Date.now())
      },
      body: JSON.stringify(payload)
    });
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
      const j = await safeFetchJson(`/api/futures-agent?action=bybit_klines&symbol=${encodeURIComponent(symbol)}&tf=${encodeURIComponent(tf)}`);
      if (j.ok && Array.isArray(j.candles) && j.candles.length && candleSeries) {
        candleSeries.setData(j.candles);
        chart.timeScale().fitContent();
      } else if (j.error) {
        logLine('CHART', j.error, 'text-amber-400');
      }
    } catch (e) {
      logLine('CHART', e.message, 'text-rose-400');
    }
  }

  function updateTelemetry(data) {
    if (data.wallet) {
      const avail = Number(data.wallet.availableBalance || 0).toFixed(2);
      const equity = Number(data.wallet.totalEquity || avail).toFixed(2);
      const uPnl = Number(data.wallet.unrealizedPnl || 0);
      $('kpi-balance').textContent = `$${avail}`;
      $('val-6').textContent = `$${equity} USDT`;
      $('badge-6').textContent = 'VERIFIED';
      $('badge-6').className = 'text-emerald-400';
      $('kpi-pnl').textContent = `${uPnl >= 0 ? '+' : ''}$${uPnl.toFixed(4)}`;
      $('kpi-pnl').className = `text-sm md:text-base font-bold ${uPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`;
    }
    const tel = data.systemTelemetry;
    if (tel) {
      $('kpi-gate').textContent = tel.liveTradingStatus;
      $('kpi-gate').className = tel.liveTradingStatus === 'BYBIT_LIVE_ARMED'
        ? 'text-xs md:text-sm font-bold text-emerald-400'
        : 'text-xs md:text-sm font-bold text-rose-400';

      const isRedisOk = tel.redisStatus === 'UPSTASH_REDIS_VERIFIED';
      $('badge-5').textContent = isRedisOk ? 'VERIFIED' : 'DEGRADED';
      $('badge-5').className = isRedisOk ? 'text-emerald-400' : 'text-amber-400';
      $('sub-5').textContent = `${tel.region} · ${tel.redisStatus}`;
    }
  }

  function updatePipelineCards(data) {
    updateTelemetry(data);
    const pick = data.pick;
    if (!pick) return;

    $('badge-1').textContent = 'DONE';
    $('badge-1').className = 'text-emerald-400';
    $('val-1').textContent = `${pick.bybitSymbol} (${pick.direction})`;
    $('sub-1').textContent = `Quality ${pick.signalQualityScore || 0}/100 · Spread ${pick.spreadPct}%`;

    const isNoTrade = pick.decision === 'NO_TRADE';
    $('badge-2').textContent = isNoTrade ? 'REJECTED' : 'PASSED';
    $('badge-2').className = isNoTrade ? 'text-amber-400' : 'text-emerald-400';
    $('val-2').textContent = `MTF ${pick.mtfConfluenceScore}%`;
    $('sub-2').textContent = pick.noTradeReason || 'All safety gates passed';

    $('badge-3').textContent = pick.orderQty > 0 ? 'SIZED' : 'BLOCKED';
    $('val-3').textContent = `QTY: ${pick.orderQty}`;
    $('sub-3').textContent = `Step: ${pick.qtyStep} · R:R 1:${pick.rrRatio}`;

    $('val-4').textContent = pick.decision;
    $('sub-4').textContent = `Entry ${pick.entry} · SL ${pick.sl}`;

    $('chart-title').textContent = `${pick.bybitSymbol} · ${pick.chartTf.toUpperCase()} (${pick.decision})`;
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
    if ($('pos-count')) $('pos-count').textContent = `${positions.length} open`;
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
            <div class="text-[11px] ${pnlColor}">uPnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(4)} · SL: ${p.stopLoss || 'NONE'} · TP: ${p.takeProfit || 'NONE'}</div>
          </div>
          <button onclick="window.__closeBybitPos('${p.symbol}')" class="px-2.5 py-1 rounded bg-rose-500/20 hover:bg-rose-500/40 text-rose-300 text-[11px] shrink-0">Close</button>
        </div>
      `;
    }).join('');
  }

  window.__closeBybitPos = async (symbol) => {
    try {
      logLine('EXECUTOR', `Closing verified live Bybit position ${symbol}...`, 'text-amber-300');
      const res = await callAgent({ action: 'live_close', symbol });
      logLine('BYBIT', `Closed ${res.symbol} · Qty ${res.qty} · Order ${res.orderId}`, 'text-emerald-400');
      showBanner(`Closed live position ${res.symbol} (Order ${res.orderId})`, 'success');
      await refreshStatus();
    } catch (e) {
      logLine('ERROR', e.message, 'text-rose-400');
      showBanner(e.message, 'error');
    }
  };

  async function refreshStatus() {
    try {
      const st = await callAgent({ action: 'status' });
      updateTelemetry(st);
      renderPositions(st.positions || []);
      logLine('BYBIT', `Synced [${st.systemTelemetry?.region}]: $${Number(st.wallet?.availableBalance || 0).toFixed(2)} avail · ${(st.positions || []).length} open pos.`, 'text-sky-300');
    } catch (e) {
      logLine('AUTH', `Sync status: ${e.message}`, 'text-amber-400');
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    initChart();
    loadChartCandles('BTC', '15m');

    $('btn-refresh')?.addEventListener('click', refreshStatus);
    $('btn-clear-logs')?.addEventListener('click', () => { $('terminal-logs').innerHTML = ''; });

    $('btn-analyze')?.addEventListener('click', async () => {
      try {
        logLine('SCANNER', 'Running 20-module Bybit V5 scan...', 'text-sky-300');
        const res = await callAgent({
          action: 'analyze_only',
          coinMode: $('inp-coin-mode').value,
          manualCoin: $('inp-manual-coin').value,
          humanBias: $('inp-bias').value,
          riskPerTradePct: Number($('inp-risk').value || 3) / 100,
          leverage: Number($('inp-lev').value || 5)
        });
        updatePipelineCards(res);
        if (res.walletWarning) logLine('WALLET', res.walletWarning, 'text-amber-400');
        if (res.decision === 'NO_TRADE') {
          logLine('SAFETY', res.noTradeReason || 'NO_TRADE', 'text-amber-300');
          showBanner(res.noTradeReason || 'NO_TRADE', 'info');
        } else {
          logLine('SCANNER', res.pick.summaryNote, 'text-emerald-400');
          showBanner(`Setup Verified: ${res.pick.bybitSymbol} ${res.decision} @ ${res.pick.entry}`, 'success');
        }
      } catch (e) { logLine('ERROR', e.message, 'text-rose-400'); showBanner(e.message, 'error'); }
    });

    $('btn-trade')?.addEventListener('click', async () => {
      try {
        if (!$('inp-live-confirm').checked) {
          showBanner('Tick "Arm Real Bybit Orders" first.', 'error');
          return;
        }
        logLine('EXECUTOR', 'Submitting verified LIVE Bybit V5 order...', 'text-rose-300');
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
        logLine('BYBIT', res.exec?.orderTypeLabel || 'Order placed', 'text-emerald-400');
        showBanner(`LIVE ORDER FILLED: ${res.exec?.orderTypeLabel}`, 'success');
        await refreshStatus();
      } catch (e) { logLine('BLOCKED', e.message, 'text-rose-400'); showBanner(e.message, 'error'); }
    });

    $('btn-backtest')?.addEventListener('click', async () => {
      try {
        const coin = $('inp-manual-coin').value || 'BTC';
        logLine('BACKTEST', `Running Walk-Forward validation on ${coin}USDT (15m)...`, 'text-indigo-300');
        const res = await callAgent({ action: 'backtest', manualCoin: coin });
        const wf = res.walkForward;
        logLine('BACKTEST', `IS: ${wf.inSample?.sampleCount} trades (WR ${wf.inSample?.winRate}%, Exp ${wf.inSample?.expectancyR}R, PF ${wf.inSample?.profitFactor}) | OOS: ${wf.outOfSample?.sampleCount} trades (WR ${wf.outOfSample?.winRate}%, Exp ${wf.outOfSample?.expectancyR}R) | Enabled=${wf.enabled}`, 'text-indigo-300');
        showBanner(`Walk-Forward (${res.symbol}): OOS Expectancy ${wf.outOfSample?.expectancyR}R · Strategy Enabled=${wf.enabled}`, wf.enabled ? 'success' : 'info');
      } catch (e) { logLine('ERROR', e.message, 'text-rose-400'); showBanner(e.message, 'error'); }
    });

    $('btn-stop')?.addEventListener('click', async () => {
      if (!confirm('HALT trading, cancel ALL open orders, and close ALL live Bybit positions?')) return;
      try {
        const res = await callAgent({ action: 'emergency_stop' });
        logLine('EMERGENCY', `Halted=${res.tradingHalted} · Closed ${res.closedCount} positions · CancelledOrders=${res.cancelledOrders}`, 'text-rose-400');
        showBanner(`Emergency Stop active. Closed ${res.closedCount} live positions.`, 'error');
        await refreshStatus();
      } catch (e) { showBanner(e.message, 'error'); }
    });

    $('btn-resume')?.addEventListener('click', async () => {
      try {
        const res = await callAgent({ action: 'resume_trading' });
        logLine('SYSTEM', `Trading resumed (halted=${res.tradingHalted}).`, 'text-emerald-400');
        showBanner('Trading halt cleared.', 'success');
        await refreshStatus();
      } catch (e) { showBanner(e.message, 'error'); }
    });
  });
})();
