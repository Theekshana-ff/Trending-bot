// File: agent.js (v6 Complete Sniper Edition — TF Selector, S/R Chart Lines, Patterns, ADX/RSI/BTC/Daily Lock)
(function () {
  const $ = (id) => document.getElementById(id);
  let chart = null;
  let candleSeries = null;
  let activePriceLines = [];
  let lastJournalData = [];

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
    b.classList.remove('hidden', 'bg-amber-500/10', 'border-amber-500/40', 'text-amber-300', 'bg-emerald-500/10', 'border-emerald-500/40', 'text-emerald-300', 'bg-rose-500/10', 'border-rose-500/40', 'text-rose-300');
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

  function clearChartLines() {
    if (!candleSeries) return;
    activePriceLines.forEach(line => {
      try { candleSeries.removePriceLine(line); } catch (e) {}
    });
    activePriceLines = [];
  }

  function drawOverlayLines(pick) {
    if (!candleSeries || !pick) return;
    clearChartLines();
    const addLine = (price, color, title, style = 2) => {
      if (!Number.isFinite(Number(price)) || Number(price) <= 0) return;
      const l = candleSeries.createPriceLine({
        price: Number(price), color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title
      });
      activePriceLines.push(l);
    };
    (pick.supportLevels || []).forEach((s, i) => addLine(s, '#10b981', `SUP ${i + 1}`, 2));
    (pick.resistanceLevels || []).forEach((r, i) => addLine(r, '#f43f5e', `RES ${i + 1}`, 2));
    addLine(pick.entry, '#38bdf8', `ENTRY (${pick.orderType || 'Mkt'})`, 0);
    addLine(pick.sl, '#fb7185', 'SL', 1);
    addLine(pick.tp1, '#34d399', 'TP1 (50%)', 1);
  }

  async function loadChartCandles(symbol = 'BTC', tf = '15m', pick = null) {
    try {
      const j = await safeFetchJson(`/api/futures-agent?action=bybit_klines&symbol=${encodeURIComponent(symbol)}&tf=${encodeURIComponent(tf)}`);
      if (j.ok && Array.isArray(j.candles) && j.candles.length && candleSeries) {
        candleSeries.setData(j.candles);
        if (pick) drawOverlayLines(pick);
        chart.timeScale().fitContent();
      }
    } catch (e) { logLine('CHART', e.message, 'text-rose-400'); }
  }

  function renderAnalytics(data) {
    if (data.pnlStats) {
      const s = data.pnlStats;
      $('stat-winrate').textContent = `${s.winRate}%`;
      $('stat-wl').textContent = `${s.wins}W / ${s.losses}L · Best: $${Number(s.bestTrade || 0).toFixed(2)}`;
      $('stat-closed-pnl').textContent = `Closed PnL: ${s.totalClosedPnl >= 0 ? '+' : ''}$${Number(s.totalClosedPnl || 0).toFixed(2)}`;
      $('donut-arc')?.setAttribute('stroke-dasharray', `${s.winRate}, 100`);
    }
    if (Array.isArray(data.equityCurve) && data.equityCurve.length >= 2) {
      const vals = data.equityCurve.map(p => p.equity);
      const minV = Math.min(...vals);
      const maxV = Math.max(...vals);
      const span = Math.max(0.01, maxV - minV);
      const pts = vals.map((v, idx) => {
        const x = Math.round((idx / (vals.length - 1)) * 240);
        const y = Math.round(58 - ((v - minV) / span) * 52);
        return `${x},${y}`;
      }).join(' ');
      $('equity-line')?.setAttribute('points', pts);
    }
    if (Array.isArray(data.coinAnalytics) && $('coin-analytics-box')) {
      $('coin-analytics-box').innerHTML = data.coinAnalytics.length
        ? data.coinAnalytics.map(c => `<div class="bg-slate-900/80 border border-slate-800 rounded p-2"><div class="font-bold text-white">${c.symbol}</div><div class="${c.netPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}">${c.netPnl >= 0 ? '+' : ''}$${c.netPnl}</div><div class="text-[10px] text-slate-400">WR ${c.winRate}% (${c.wins}W/${c.losses}L)</div></div>`).join('')
        : '<span>No closed coin analytics yet.</span>';
    }
    if (data.botFilters) {
      if ($('inp-whitelist')) $('inp-whitelist').value = (data.botFilters.whitelist || []).join(',');
      if ($('inp-blacklist')) $('inp-blacklist').value = (data.botFilters.blacklist || []).join(',');
      if ($('inp-block-weekend')) $('inp-block-weekend').checked = Boolean(data.botFilters.blockWeekend);
      if ($('inp-session-only')) $('inp-session-only').checked = Boolean(data.botFilters.sessionOnly);
    }
    if (Array.isArray(data.journal) && data.journal.length) {
      lastJournalData = data.journal;
      const lastOrder = data.journal.find(j => j.type === 'LIVE_ORDER_OPEN');
      if (lastOrder) {
        $('why-box').textContent = `${lastOrder.symbol} ${lastOrder.orderType || ''} ${lastOrder.direction} (${lastOrder.leverage}x Iso): ${lastOrder.why || 'Verified'}`;
      }
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
      const dailyTxt = data.dailyGuard ? ` (${data.dailyGuard.dailyPnlPct >= 0 ? '+' : ''}${data.dailyGuard.dailyPnlPct}% d)` : '';
      $('kpi-pnl').textContent = `${uPnl >= 0 ? '+' : ''}$${uPnl.toFixed(3)}${dailyTxt}`;
      $('kpi-pnl').className = `text-sm md:text-base font-bold ${uPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`;
    }
    const tel = data.systemTelemetry;
    if (tel) {
      $('kpi-gate').textContent = data.dailyGuard?.locked ? data.dailyGuard.errorCode : tel.liveTradingStatus;
      $('kpi-gate').className = (tel.liveTradingStatus === 'BYBIT_LIVE_ARMED' && !data.dailyGuard?.locked)
        ? 'text-xs md:text-sm font-bold text-emerald-400'
        : 'text-xs md:text-sm font-bold text-rose-400';
      $('badge-5').textContent = tel.telegramEnabled ? 'TG ON' : 'TG OFF';
      $('badge-5').className = tel.telegramEnabled ? 'text-emerald-400' : 'text-slate-400';
      $('val-5').textContent = data.dailyGuard?.locked ? 'DAILY LOCKED' : 'DAILY OK';
      $('sub-5').textContent = `${tel.region} · ${tel.autoPilotStatus || 'MANUAL'}`;
    }
    if (data.fearGreed && $('pill-fng')) $('pill-fng').textContent = `F&G: ${data.fearGreed.value} (${data.fearGreed.classification})`;
    if (tel?.aiProvider && $('badge-ai-provider')) $('badge-ai-provider').textContent = `AI: ${tel.aiProvider}`;
    if (data.autoWalletAlloc) {
      if ($('inp-wallet-alloc-en')) $('inp-wallet-alloc-en').checked = Boolean(data.autoWalletAlloc.enabled);
      if ($('inp-wallet-alloc-pct')) $('inp-wallet-alloc-pct').value = String(data.autoWalletAlloc.pct || 50);
      if ($('badge-wallet-alloc')) {
        $('badge-wallet-alloc').textContent = data.autoWalletAlloc.enabled
          ? `ACTIVE: ${data.autoWalletAlloc.pct}% Wallet Margin (Auto-Lev)`
          : 'OFF (Normal Risk Mode)';
        $('badge-wallet-alloc').className = data.autoWalletAlloc.enabled ? 'text-[11px] text-amber-400 font-bold mono' : 'text-[11px] text-slate-400 mono';
      }
    }
    renderAnalytics(data);
  }

  function updatePipelineCards(data) {
    updateTelemetry(data);
    const pick = data.pick;
    if (!pick) return;

    $('badge-1').textContent = pick.chartTf.toUpperCase();
    $('badge-1').className = 'text-sky-400';
    $('val-1').textContent = `${pick.bybitSymbol} (${pick.direction})`;
    $('sub-1').textContent = `Score ${pick.signalQualityScore || 0}/100 · OI ${pick.oiChangePct >= 0 ? '+' : ''}${pick.oiChangePct}%`;

    const isNoTrade = pick.decision === 'NO_TRADE';
    $('badge-2').textContent = isNoTrade ? 'VETOED' : 'SNIPER OK';
    $('badge-2').className = isNoTrade ? 'text-amber-400' : 'text-emerald-400';
    $('val-2').textContent = `ADX ${pick.adx} · RSI ${pick.rsi}`;
    $('sub-2').textContent = pick.noTradeReason || `Pattern: ${pick.pattern}`;

    $('badge-3').textContent = `${pick.leverage}x ${pick.autoLeverageUsed ? 'AUTO' : 'MAN'}`;
    $('val-3').textContent = `QTY: ${pick.orderQty}`;
    $('sub-3').textContent = `Margin $${pick.requiredMargin} · R:R 1:${pick.rrRatio}`;

    $('val-4').textContent = `${pick.decision} (${pick.orderType})`;
    $('sub-4').textContent = `Entry ${pick.entry} · SL ${pick.sl}`;
    $('why-box').textContent = pick.summaryNote || '';
    $('badge-pattern').textContent = `PATTERN: ${pick.pattern || 'NONE'}`;

    $('chart-title').textContent = `${pick.bybitSymbol} · ${pick.chartTf.toUpperCase()} (${pick.decision})`;
    $('chart-sub').textContent = `S: ${(pick.supportLevels || []).join(', ') || '--'} | R: ${(pick.resistanceLevels || []).join(', ') || '--'}`;
    $('pill-adx').textContent = `ADX: ${pick.adx}`;
    $('pill-rsi').textContent = `RSI: ${pick.rsi}`;
    $('pill-btc').textContent = `BTC: ${pick.btcTrend || '--'}`;
    if ($('pill-whale')) $('pill-whale').textContent = `WHALE: ${pick.whaleAlert || 'NONE'}`;
    if (data.aiReview?.used) $('why-box').textContent = `[${data.aiReview.provider} ${data.aiReview.approve ? 'OK' : 'VETO'}] ${data.aiReview.summary} | ${pick.summaryNote || ''}`;
    $('pill-entry').textContent = `Entry (${pick.orderType}): ${pick.entry}`;
    $('pill-sl').textContent = `SL: ${pick.sl}`;
    $('pill-tp').textContent = `TP1 (50%): ${pick.tp1} | TP4: ${pick.tp}`;

    const bd = pick.mtfBreakdown || {};
    ['1D', '4H', '1H', '15M', '5M'].forEach(tf => {
      const el = $(`tf-${tf.toLowerCase()}`);
      if (!el) return;
      const v = bd[tf] || '--';
      el.textContent = v;
      el.className = v === 'BULL' ? 'font-bold text-emerald-400' : v === 'BEAR' ? 'font-bold text-rose-400' : 'font-bold text-slate-400';
    });

    loadChartCandles(pick.coin, pick.chartTf || '15m', pick);
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
            <span class="font-bold ${p.side === 'Buy' ? 'text-emerald-400' : 'text-rose-400'}">${p.symbol} ${p.side === 'Buy' ? 'LONG' : 'SHORT'} (${p.leverage}x ${p.tradeMode === 1 ? 'ISO' : 'CROSS'})</span>
            <div class="text-[11px] text-slate-400">Size: ${p.size} · Entry: ${p.avgPrice} · Mark: ${p.markPrice}</div>
            <div class="text-[11px] ${pnlColor}">uPnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(4)} · SL: ${p.stopLoss || 'NONE'} · Trail: ${p.trailingStop || '--'}</div>
          </div>
          <button onclick="window.__closeBybitPos('${p.symbol}')" class="px-2.5 py-1 rounded bg-rose-500/20 hover:bg-rose-500/40 text-rose-300 text-[11px] shrink-0">Close</button>
        </div>
      `;
    }).join('');
  }

  window.__closeBybitPos = async (symbol) => {
    try {
      const res = await callAgent({ action: 'live_close', symbol });
      logLine('BYBIT', `Closed ${res.symbol} · Order ${res.orderId}`, 'text-emerald-400');
      showBanner(`Closed live position ${res.symbol}`, 'success');
      await refreshStatus();
    } catch (e) { logLine('ERROR', e.message, 'text-rose-400'); showBanner(e.message, 'error'); }
  };

  function getFormParams() {
    return {
      coinMode: $('inp-coin-mode').value,
      manualCoin: $('inp-manual-coin').value,
      timeframe: $('inp-tf').value,
      entryMode: $('inp-entry-mode').value,
      humanBias: $('inp-bias').value,
      riskPerTradePct: Number($('inp-risk').value || 3) / 100,
      maxMarginPct: Number($('inp-margin').value || 20) / 100,
      maxDailyLossPct: Number($('inp-daily-loss').value || 5),
      dailyProfitTargetPct: Number($('inp-daily-profit').value || 10),
      autoLeverage: $('inp-auto-lev').value === 'auto' || $('inp-auto-lev').value === 'true',
      leverage: ($('inp-auto-lev').value === 'auto' || $('inp-auto-lev').value === 'true') ? 5 : Math.min(20, Math.max(5, Number($('inp-auto-lev').value) || 5)),
      walletAllocEnabled: Boolean($('inp-wallet-alloc-en')?.checked),
      walletAllocPct: Number($('inp-wallet-alloc-pct')?.value || 50)
    };
  }

  async function refreshStatus() {
    try {
      const p = getFormParams();
      const st = await callAgent({ action: 'status', maxDailyLossPct: p.maxDailyLossPct, dailyProfitTargetPct: p.dailyProfitTargetPct });
      updateTelemetry(st);
      renderPositions(st.positions || []);
      logLine('BYBIT', `Synced [${st.systemTelemetry?.region}]: $${Number(st.wallet?.availableBalance || 0).toFixed(2)} avail · Daily ${st.dailyGuard?.dailyPnlPct || 0}%`, 'text-sky-300');
    } catch (e) { logLine('AUTH', `Sync status: ${e.message}`, 'text-amber-400'); }
  }

  document.addEventListener('DOMContentLoaded', () => {
    initChart();
    loadChartCandles('BTC', '15m');

    $('inp-tf')?.addEventListener('change', () => {
      const coin = $('inp-manual-coin')?.value || 'BTC';
      loadChartCandles(coin, $('inp-tf').value);
    });
    $('btn-refresh')?.addEventListener('click', refreshStatus);

    async function saveWalletAllocMode() {
      const enabled = Boolean($('inp-wallet-alloc-en')?.checked);
      const pct = Number($('inp-wallet-alloc-pct')?.value || 50);
      try {
        const res = await callAgent({ action: 'set_auto_wallet_alloc', enabled, pct });
        updateTelemetry(res);
        logLine('AUTO-ALLOC', enabled ? `Enabled ${pct}% Wallet Auto-Trading Mode (Saved to Redis).` : 'Disabled Wallet % Mode (Back to Normal Risk).', 'text-amber-300');
        showBanner(enabled ? `Auto Wallet Mode ON: ${pct}% Margin + Auto Leverage` : 'Auto Wallet Mode OFF (Normal Risk Mode)', 'info');
      } catch (e) {
        logLine('ERROR', e.message, 'text-rose-400');
        showBanner(e.message, 'error');
      }
    }
    $('inp-wallet-alloc-en')?.addEventListener('change', saveWalletAllocMode);
    $('inp-wallet-alloc-pct')?.addEventListener('change', () => {
      if ($('inp-wallet-alloc-en')?.checked) saveWalletAllocMode();
    });

    $('btn-save-filters')?.addEventListener('click', async () => {
      try {
        const res = await callAgent({
          action: 'set_bot_filters',
          whitelist: $('inp-whitelist')?.value || '',
          blacklist: $('inp-blacklist')?.value || '',
          blockWeekend: Boolean($('inp-block-weekend')?.checked),
          sessionOnly: Boolean($('inp-session-only')?.checked)
        });
        updateTelemetry(res);
        logLine('FILTERS', 'Saved Coin Whitelist/Blacklist & Session Filters to Redis.', 'text-sky-300');
        showBanner('v9.0 Filters Saved!', 'success');
      } catch (e) { showBanner(e.message, 'error'); }
    });

    $('btn-export-csv')?.addEventListener('click', () => {
      if (!lastJournalData.length) { showBanner('Click Sync Bybit first to load journal.', 'error'); return; }
      const headers = ['ts', 'type', 'symbol', 'direction', 'qty', 'leverage', 'entry', 'sl', 'tp1', 'score', 'reason'];
      const rows = [headers.join(',')].concat(lastJournalData.map(j => headers.map(h => JSON.stringify(j[h] ?? '')).join(',')));
      const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `bybit-bot-journal-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
    });

    async function sendAiChat() {
      const inp = $('inp-ai-chat');
      const box = $('ai-chat-log');
      const q = (inp?.value || '').trim();
      if (!q || !box) return;
      inp.value = '';
      const uDiv = document.createElement('div');
      uDiv.className = 'text-sky-300 font-semibold';
      uDiv.textContent = `You: ${q}`;
      box.appendChild(uDiv);
      box.scrollTop = box.scrollHeight;
      try {
        const res = await callAgent({ action: 'ai_chat', question: q });
        const aDiv = document.createElement('div');
        aDiv.className = 'text-slate-200 whitespace-pre-wrap';
        aDiv.textContent = `AI (${res.provider || 'BOT'}): ${res.reply}`;
        box.appendChild(aDiv);
        if (res.fearGreed && $('pill-fng')) $('pill-fng').textContent = `F&G: ${res.fearGreed.value} (${res.fearGreed.classification})`;
      } catch (e) {
        const eDiv = document.createElement('div');
        eDiv.className = 'text-rose-400';
        eDiv.textContent = `AI Error: ${e.message}`;
        box.appendChild(eDiv);
      }
      box.scrollTop = box.scrollHeight;
    }
    $('btn-ai-send')?.addEventListener('click', sendAiChat);
    $('inp-ai-chat')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendAiChat(); });

    $('btn-clear-logs')?.addEventListener('click', () => { $('terminal-logs').innerHTML = ''; });

    $('btn-analyze')?.addEventListener('click', async () => {
      try {
        const p = getFormParams();
        logLine('SNIPER', `Running v6 scan (${p.timeframe}, ${p.entryMode})...`, 'text-sky-300');
        const res = await callAgent({ action: 'analyze_only', ...p });
        updatePipelineCards(res);
        if (res.walletWarning) logLine('WALLET', res.walletWarning, 'text-amber-400');
        showBanner(res.decision === 'NO_TRADE' ? (res.noTradeReason || 'NO_TRADE') : `Sniper Verified: ${res.pick.bybitSymbol} ${res.decision} (${res.pick.orderType} @ ${res.pick.entry})`, res.decision === 'NO_TRADE' ? 'info' : 'success');
      } catch (e) { logLine('ERROR', e.message, 'text-rose-400'); showBanner(e.message, 'error'); }
    });

    $('btn-trade')?.addEventListener('click', async () => {
      try {
        if (!$('inp-live-confirm').checked) { showBanner('Tick "Arm" first.', 'error'); return; }
        const p = getFormParams();
        logLine('EXECUTOR', `Submitting LIVE v6 ${p.entryMode} order...`, 'text-rose-300');
        const res = await callAgent({ action: 'scan_and_trade', liveConfirmed: true, ...p });
        updatePipelineCards(res);
        logLine('BYBIT', res.exec?.orderTypeLabel || 'Order placed', 'text-emerald-400');
        showBanner(`LIVE ORDER SUBMITTED: ${res.exec?.orderTypeLabel}`, 'success');
        await refreshStatus();
      } catch (e) { logLine('BLOCKED', e.message, 'text-rose-400'); showBanner(e.message, 'error'); }
    });

    $('btn-backtest')?.addEventListener('click', async () => {
      try {
        const p = getFormParams();
        const res = await callAgent({ action: 'backtest', manualCoin: p.manualCoin || 'BTC', timeframe: p.timeframe });
        const wf = res.walkForward;
        logLine('BACKTEST', `${res.symbol} (${res.tf}) OOS: ${wf.outOfSample?.sampleCount} trades · WR ${wf.outOfSample?.winRate}% · Exp ${wf.outOfSample?.expectancyR}R`, 'text-indigo-300');
        showBanner(`Walk-Forward (${res.symbol} ${res.tf}): OOS Exp ${wf.outOfSample?.expectancyR}R`, wf.enabled ? 'success' : 'info');
      } catch (e) { logLine('ERROR', e.message, 'text-rose-400'); showBanner(e.message, 'error'); }
    });

    $('btn-stop')?.addEventListener('click', async () => {
      if (!confirm('HALT trading, cancel ALL open orders, and close ALL live Bybit positions?')) return;
      try {
        const res = await callAgent({ action: 'emergency_stop' });
        logLine('EMERGENCY', `Halted=${res.tradingHalted} · Closed ${res.closedCount} positions.`, 'text-rose-400');
        showBanner(`Emergency Stop active. Closed ${res.closedCount} positions.`, 'error');
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
