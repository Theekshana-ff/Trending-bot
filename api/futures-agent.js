// File: api/futures-agent.js
// BYBIT V5 LIVE-ONLY 6-STAGE QUANT PIPELINE ENGINE (v5.0)
// Includes: Auto Leverage, Auto Isolated Margin + Cap, Auto Trailing Stop/BE, Auto-Pilot Cron, Equity Curve & Win Rate Analytics

const { getBybitMarketData, fetchKlines } = require('../lib/modules/marketData');
const { analyzeVolumeVolatility, evaluateMTF } = require('../lib/modules/indicators');
const { analyzeMarketStructure, analyzeLiquidityAndSMC, analyzeFibonacci, analyzeElliottWave } = require('../lib/modules/structureSmc');
const { computeAndValidateEntry, evaluateLiveRisk, formatBybitPrice } = require('../lib/modules/riskAndValidation');
const { buildDeterministicExplanation, runWalkForward } = require('../lib/modules/aiBrainAndBacktest');
const {
  safeCompareSecret, makeResponse, acquireLock, releaseLock,
  validateRequestNonce, checkRateLimit, getTradingHalted, setTradingHalted,
  appendJournalEntry, getJournalEntries, getSystemHealth,
  recordEquitySnapshot, getEquityHistory
} = require('../lib/modules/securityAndState');
const {
  bybitV5Req, fetchBybitWalletAndPositions, fetchBybitClosedPnlStats,
  configureIsolatedAndLeverage, applyTrailingAndBreakeven,
  closeVerifiedLivePosition, executeLiveEmergencyStop
} = require('../lib/modules/bybitLiveClient');

const TOP_COINS = ['SOL', 'XRP', 'DOGE', 'SUI', 'ADA', 'OP', 'ARB', 'LINK', 'AVAX', 'NEAR', 'APT', 'INJ', 'RENDER', 'TRX', 'LTC', 'BNB', 'ETH', 'BTC'];
const ALLOWED_ACTIONS = new Set([
  'health', 'status', 'bybit_klines', 'analyze_only', 'scan_and_trade',
  'live_close', 'emergency_stop', 'resume_trading', 'cron_tick', 'backtest', 'journal'
]);

function isServerLiveAuthorized() {
  return String(process.env.ALLOW_LIVE_TRADING || '').trim().toLowerCase() === 'true';
}

function isAutoExecuteEnabled() {
  return String(process.env.AUTO_EXECUTE || '').trim().toLowerCase() === 'true';
}

async function runSixStagePipeline({
  coinMode, manualCoin, humanBias, riskPerTradePct, maxMarginPct,
  leverage, autoLeverage, availBal, openPositionsCount, enforceVeto
}) {
  const { tickers, instMap } = await getBybitMarketData();
  const cleanManual = String(manualCoin || 'SOL').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/USDT$/, '');
  const list = coinMode === 'manual' && cleanManual ? [cleanManual] : TOP_COINS;

  const candidates = list.map(coin => {
    const bybitSymbol = `${coin}USDT`;
    const t = tickers[bybitSymbol];
    const spec = instMap[bybitSymbol];
    if (!t || !spec) return null;
    const spreadPct = t.bid1 > 0 ? ((t.ask1 - t.bid1) / t.bid1) * 100 : 0.02;
    return { coin, bybitSymbol, price: t.lastPrice, chgPct: t.chgPct, spreadPct, fundingRate: t.fundingRate, spec };
  }).filter(Boolean).sort((a, b) => Math.abs(b.chgPct) - Math.abs(a.chgPct)).slice(0, 4);

  if (!candidates.length) {
    throw new Error('NO_TRADE: No valid active Bybit USDT linear contracts returned.');
  }

  const results = await Promise.all(candidates.map(async cand => {
    const safeK = (tf, lim) => fetchKlines(cand.coin, tf, lim).catch(e => ({ ok: false, reason: e.message, closedCandles: [] }));
    const [k1d, k4h, k1h, k15m, k5m] = await Promise.all([
      safeK('1d', 60), safeK('4h', 60), safeK('1h', 60), safeK('15m', 90), safeK('5m', 60)
    ]);

    if (!k15m.ok) {
      return {
        decision: 'NO_TRADE', noTradeReason: `Data Validation Failed: ${k15m.reason}`,
        coin: cand.coin, bybitSymbol: cand.bybitSymbol, direction: 'NONE',
        spreadPct: +cand.spreadPct.toFixed(3), mtfConfluenceScore: 0,
        mtfBreakdown: { '1D': '--', '4H': '--', '1H': '--', '15M': 'STALE', '5M': '--' },
        orderQty: 0, qtyStep: cand.spec.qtyStep, leverage: leverage || 5, requiredMargin: 0,
        entry: cand.price, sl: 0, tp1: 0, tp: 0, rrRatio: 0, chartTf: '15m', summaryNote: k15m.reason
      };
    }

    const c15m = k15m.closedCandles;
    const mtf = evaluateMTF({
      closes1d: k1d.ok ? k1d.closedCandles.map(x => x[4]) : [],
      closes4h: k4h.ok ? k4h.closedCandles.map(x => x[4]) : [],
      closes1h: k1h.ok ? k1h.closedCandles.map(x => x[4]) : [],
      closes15m: c15m.map(x => x[4]),
      closes5m: k5m.ok ? k5m.closedCandles.map(x => x[4]) : []
    });

    const volVol = analyzeVolumeVolatility(c15m);
    const structure = analyzeMarketStructure(c15m);
    const smc = analyzeLiquidityAndSMC(c15m, structure);
    const fib = analyzeFibonacci(c15m);
    const elliott = analyzeElliottWave(structure.swingHighs, structure.swingLows);

    let dir = (mtf.decision === 'LONG' || mtf.decision === 'SHORT') ? mtf.decision : (structure.structure === 'BEARISH_LH_LL' ? 'SHORT' : 'LONG');
    if (humanBias === 'long_only') dir = 'LONG';
    if (humanBias === 'short_only') dir = 'SHORT';

    const levels = computeAndValidateEntry({
      closedCandles: c15m, livePrice: cand.price, direction: dir,
      tickSize: cand.spec.tickSize, atr: volVol.atr, spreadPct: cand.spreadPct, fundingRate: cand.fundingRate
    });

    // Preliminary score for auto-leverage sizing
    const preScore = (mtf.ok ? 35 : 10) + (smc.sweep !== 'NONE' ? 15 : 0) + (smc.fvg !== 'NONE' ? 10 : 0) + (fib.inGoldenPocket ? 15 : 0) + (volVol.volumeConfirmed ? 15 : 0);

    const risk = levels.valid
      ? evaluateLiveRisk({
          availBal, entryPrice: levels.entry, slPrice: levels.sl,
          qtyStep: cand.spec.qtyStep, minOrderQty: cand.spec.minOrderQty, maxOrderQty: cand.spec.maxOrderQty,
          minNotionalValue: cand.spec.minNotionalValue,
          riskPerTradePct, maxMarginPct, leverage, autoLeverage,
          atrPct: volVol.atrPct, signalQualityScore: preScore,
          maxLeverage: cand.spec.maxLeverage, openPositionsCount
        })
      : { approved: false, orderQty: 0, leverage: leverage || 5, requiredMargin: 0, reason: levels.reason };

    const isNoTrade = mtf.conflictDetected || volVol.regime === 'EXTREME_VOLATILITY' || !levels.valid || !risk.approved;
    const noTradeReason = mtf.conflictDetected
      ? mtf.reason
      : volVol.regime === 'EXTREME_VOLATILITY'
        ? `NO_TRADE: Extreme volatility (${volVol.atrPct}% ATR).`
        : (!levels.valid ? levels.reason : (!risk.approved ? risk.reason : null));

    const decision = isNoTrade ? 'NO_TRADE' : dir;
    const aiExplanation = buildDeterministicExplanation({
      symbol: cand.bybitSymbol, direction: dir, decision, mtf, structure, smc, fib, elliott, volVol, levels, risk, noTradeReason
    });

    const entry = levels.entry || cand.price;
    const sl = levels.sl || formatBybitPrice(entry * (dir === 'LONG' ? 0.985 : 1.015), cand.spec.tickSize);
    const tp1 = levels.tp1 || formatBybitPrice(entry * (dir === 'LONG' ? 1.02 : 0.98), cand.spec.tickSize);
    const tp = levels.tp || formatBybitPrice(entry * (dir === 'LONG' ? 1.08 : 0.92), cand.spec.tickSize);

    return {
      decision, noTradeReason,
      coin: cand.coin, bybitSymbol: cand.bybitSymbol, direction: dir,
      spreadPct: +cand.spreadPct.toFixed(3), rrRatio: levels.rrRatio || 0, chartTf: '15m',
      mtfConfluenceScore: mtf.agreementPct, mtfBreakdown: mtf.breakdown,
      signalQualityScore: aiExplanation.signalQualityScore, aiExplanation,
      orderQty: risk.orderQty, qtyStep: cand.spec.qtyStep,
      leverage: risk.leverage || leverage || 5,
      autoLeverageUsed: Boolean(risk.autoLeverageUsed),
      requiredMargin: risk.requiredMargin || 0,
      entry, sl, tp1, tp,
      summaryNote: aiExplanation.summary
    };
  }));

  const valid = results.filter(x => x.decision !== 'NO_TRADE').sort((a, b) => b.signalQualityScore - a.signalQualityScore);
  const chosen = valid.length ? valid : results.sort((a, b) => (b.signalQualityScore || 0) - (a.signalQualityScore || 0));
  const best = chosen[0];
  if (best.decision === 'NO_TRADE' && enforceVeto) {
    throw new Error(best.noTradeReason || 'NO_TRADE: Safety gate rejected setup.');
  }
  return { scannedCount: candidates.length, pick: best };
}

async function executeLivePick(pick, sourceTag = 'MANUAL_UI') {
  const marginConf = await configureIsolatedAndLeverage(pick.bybitSymbol, pick.leverage);
  const side = pick.direction === 'LONG' ? 'Buy' : 'Sell';
  const orderRes = await bybitV5Req('POST', '/v5/order/create', {
    category: 'linear',
    symbol: pick.bybitSymbol,
    side,
    orderType: 'Market',
    qty: String(pick.orderQty),
    timeInForce: 'IOC',
    stopLoss: String(pick.sl),
    takeProfit: String(pick.tp),
    positionIdx: 0
  });

  const journalEntry = await appendJournalEntry({
    type: 'LIVE_ORDER_OPEN',
    source: sourceTag,
    symbol: pick.bybitSymbol,
    direction: pick.direction,
    qty: pick.orderQty,
    leverage: marginConf.leverage,
    isolated: marginConf.isolatedSet,
    requiredMargin: pick.requiredMargin,
    entry: pick.entry,
    sl: pick.sl,
    tp: pick.tp,
    score: pick.signalQualityScore,
    why: pick.aiExplanation?.summary || pick.summaryNote,
    orderId: orderRes?.orderId || null
  });

  return {
    orderId: orderRes?.orderId || null,
    marginConf,
    journalEntry,
    orderTypeLabel: `LIVE ${pick.bybitSymbol} ${pick.direction} · Qty ${pick.orderQty} @ ${pick.entry} (${marginConf.leverage}x Isolated)`
  };
}

module.exports = async (req, res) => {
  try {
    const method = String(req.method || 'GET').toUpperCase();
    if (!['GET', 'POST'].includes(method)) {
      return res.status(405).json(makeResponse(false, { error: 'Method Not Allowed' }, { errorCode: 'METHOD_NOT_ALLOWED' }));
    }

    if (req.query && (req.query.secret || req.query.agent_secret || req.query.api_key)) {
      return res.status(400).json(makeResponse(false, { error: 'Secrets must not be passed in URL query parameters.' }, { errorCode: 'QUERY_SECRET_FORBIDDEN' }));
    }

    const clientIp = String(req.headers?.['x-vercel-forwarded-for'] || req.socket?.remoteAddress || 'local').split(',')[0].trim();
    if (!checkRateLimit(clientIp, 90)) {
      return res.status(429).json(makeResponse(false, { error: 'Rate limit exceeded.' }, { errorCode: 'RATE_LIMITED' }));
    }

    let body = {};
    if (method === 'POST') {
      if (typeof req.body === 'string') {
        try { body = JSON.parse(req.body || '{}'); }
        catch (e) { return res.status(400).json(makeResponse(false, { error: 'Invalid JSON request body.' }, { errorCode: 'INVALID_JSON' })); }
      } else {
        body = req.body || {};
      }
    } else {
      body = req.query || {};
    }

    const action = String(body.action || 'health').trim();
    if (!ALLOWED_ACTIONS.has(action)) {
      return res.status(400).json(makeResponse(false, { error: `Unsupported action: ${action}` }, { errorCode: 'UNSUPPORTED_ACTION' }));
    }

    if (action === 'health') {
      const health = await getSystemHealth();
      return res.status(200).json(makeResponse(true, { health }, { sourceStatus: 'SYSTEM_HEALTH' }));
    }

    if (action === 'bybit_klines') {
      const k = await fetchKlines(body.symbol || 'BTC', body.tf || '15m', 110);
      if (!k.ok) return res.status(200).json(makeResponse(false, { candles: [], error: k.reason }, { sourceStatus: 'UNAVAILABLE', errorCode: k.errorCode }));
      const all = k.incompleteCandle ? [...k.closedCandles, k.incompleteCandle] : k.closedCandles;
      const candles = all.map(c => ({ time: Math.floor(c[0] / 1000), open: c[1], high: c[2], low: c[3], close: c[4] }));
      return res.status(200).json(makeResponse(true, { candles, closedCount: k.closedCandles.length }));
    }

    // Cron Guardian: Monitors positions, applies Auto Breakeven/Trailing Stop, records Equity Curve, and optionally Auto-Executes
    if (action === 'cron_tick') {
      const expectedCron = (process.env.CRON_SECRET || '').trim();
      const providedCron = String(req.headers?.['x-cron-secret'] || req.headers?.authorization?.replace(/^Bearer\s+/i, '') || '').trim();
      if (!expectedCron || !safeCompareSecret(providedCron, expectedCron)) {
        return res.status(401).json(makeResponse(false, { error: 'Unauthorized: Valid CRON_SECRET required.' }, { errorCode: 'CRON_UNAUTHORIZED' }));
      }
      const lock = await acquireLock('bybit_cron_guardian_lock', 25000);
      if (!lock.acquired) return res.status(409).json(makeResponse(false, { error: lock.reason }, { errorCode: 'CRON_LOCKED' }));

      try {
        const haltedState = await getTradingHalted();
        const acct = await fetchBybitWalletAndPositions();
        await recordEquitySnapshot(acct.wallet.totalEquity);

        const trailingUpdates = await applyTrailingAndBreakeven(acct.positions);
        const unprotected = acct.positions.filter(p => !p.hasSlProtection).map(p => p.symbol);

        let autoExecResult = null;
        if (!haltedState.halted && isServerLiveAuthorized() && isAutoExecuteEnabled() && acct.positions.length < 3) {
          try {
            const scanRes = await runSixStagePipeline({
              coinMode: 'auto', humanBias: 'ai_100', riskPerTradePct: 0.03, maxMarginPct: 0.20,
              autoLeverage: true, availBal: acct.wallet.availableBalance, openPositionsCount: acct.positions.length, enforceVeto: true
            });
            if (scanRes.pick.signalQualityScore >= 75) {
              autoExecResult = await executeLivePick(scanRes.pick, 'CRON_AUTOPILOT');
            }
          } catch (e) {
            autoExecResult = { skipped: true, reason: e.message };
          }
        }

        const logRec = await appendJournalEntry({
          type: 'CRON_GUARDIAN',
          tradingHalted: haltedState.halted,
          openPositions: acct.positions.length,
          unprotectedPositions: unprotected,
          trailingUpdatesCount: trailingUpdates.length,
          autoExecTriggered: Boolean(autoExecResult?.orderId),
          availableBalance: acct.wallet.availableBalance
        });

        return res.status(200).json(makeResponse(true, {
          guardian: { checkedPositions: acct.positions.length, unprotectedPositions: unprotected, trailingUpdates, autoExecResult, tradingHalted: haltedState.halted, log: logRec },
          ...acct
        }));
      } finally {
        await releaseLock('bybit_cron_guardian_lock', lock.token);
      }
    }

    const expectedSecret = (process.env.AGENT_SECRET || '').trim();
    const providedSecret = String(req.headers?.['x-agent-secret'] || '').trim();
    if (!expectedSecret) return res.status(503).json(makeResponse(false, { error: 'Server misconfigured: AGENT_SECRET not set.' }, { errorCode: 'ENV_MISSING_SECRET' }));
    if (!safeCompareSecret(providedSecret, expectedSecret)) return res.status(401).json(makeResponse(false, { error: 'Unauthorized: Valid AGENT_SECRET required.' }, { errorCode: 'UNAUTHORIZED' }));

    if (['scan_and_trade', 'live_close', 'emergency_stop', 'resume_trading'].includes(action)) {
      const nonceCheck = await validateRequestNonce(req.headers?.['x-request-nonce'], req.headers?.['x-request-ts'], true);
      if (!nonceCheck.valid) return res.status(401).json(makeResponse(false, { error: nonceCheck.reason }, { errorCode: nonceCheck.errorCode }));
    }

    const health = await getSystemHealth();
    const liveArmed = isServerLiveAuthorized() && !health.tradingHalted;
    const telemetry = {
      liveTradingStatus: health.tradingHalted ? 'EMERGENCY_HALTED' : (isServerLiveAuthorized() ? 'BYBIT_LIVE_ARMED' : 'ENV_GATE_LOCKED'),
      autoPilotStatus: isAutoExecuteEnabled() ? 'AUTO_PILOT_ON' : 'MANUAL_EXEC',
      region: health.region,
      redisStatus: health.redisStatus,
      tradingHalted: health.tradingHalted
    };

    if (action === 'status') {
      const [acct, pnlStats, journal, equityCurve] = await Promise.all([
        fetchBybitWalletAndPositions(),
        fetchBybitClosedPnlStats(50),
        getJournalEntries(),
        getEquityHistory()
      ]);
      await recordEquitySnapshot(acct.wallet.totalEquity);
      return res.status(200).json(makeResponse(true, { systemTelemetry: telemetry, pnlStats, journal, equityCurve, ...acct }));
    }

    if (action === 'journal') {
      const journal = await getJournalEntries();
      return res.status(200).json(makeResponse(true, { journal, systemTelemetry: telemetry }));
    }

    if (action === 'backtest') {
      const coin = String(body.manualCoin || body.symbol || 'BTC').toUpperCase();
      const k = await fetchKlines(coin, '15m', 200);
      if (!k.ok) return res.status(400).json(makeResponse(false, { error: k.reason }, { errorCode: k.errorCode }));
      const wf = runWalkForward(k.closedCandles);
      return res.status(200).json(makeResponse(true, { symbol: `${coin}USDT`, walkForward: wf }));
    }

    if (action === 'analyze_only') {
      let acct = { wallet: { availableBalance: 0, totalEquity: 0, unrealizedPnl: 0 }, positions: [] };
      let walletWarning = null;
      try { acct = await fetchBybitWalletAndPositions(); } catch (e) { walletWarning = `Bybit Wallet Sync Warning: ${e.message}`; }

      const scanRes = await runSixStagePipeline({
        coinMode: body.coinMode || 'auto',
        manualCoin: body.manualCoin || 'SOL',
        humanBias: body.humanBias || 'ai_100',
        riskPerTradePct: Number(body.riskPerTradePct || 0.03),
        maxMarginPct: Number(body.maxMarginPct || 0.20),
        leverage: Number(body.leverage || 5),
        autoLeverage: body.autoLeverage !== false,
        availBal: acct.wallet.availableBalance,
        openPositionsCount: acct.positions.length,
        enforceVeto: false
      });
      return res.status(200).json(makeResponse(true, {
        decision: scanRes.pick.decision, noTradeReason: scanRes.pick.noTradeReason,
        walletWarning, systemTelemetry: telemetry, ...acct, ...scanRes
      }));
    }

    if (action === 'scan_and_trade') {
      if (health.tradingHalted) return res.status(423).json(makeResponse(false, { error: 'TRADING_HALTED: Emergency Stop is active.' }, { errorCode: 'TRADING_HALTED' }));
      if (!liveArmed) return res.status(403).json(makeResponse(false, { error: 'SERVER_LIVE_GATE_LOCKED: Set ALLOW_LIVE_TRADING=true.' }, { errorCode: 'LIVE_GATE_LOCKED' }));
      if (body.liveConfirmed !== true) return res.status(403).json(makeResponse(false, { error: 'LIVE_CONFIRMATION_MISSING: Tick Arm Real Bybit Orders.' }, { errorCode: 'CONFIRMATION_MISSING' }));

      const lock = await acquireLock('bybit_live_trade_lock', 15000);
      if (!lock.acquired) return res.status(409).json(makeResponse(false, { error: lock.reason }, { errorCode: 'LOCK_BUSY' }));

      try {
        const acct = await fetchBybitWalletAndPositions();
        const scanRes = await runSixStagePipeline({
          coinMode: body.coinMode || 'auto',
          manualCoin: body.manualCoin || 'SOL',
          humanBias: body.humanBias || 'ai_100',
          riskPerTradePct: Number(body.riskPerTradePct || 0.03),
          maxMarginPct: Number(body.maxMarginPct || 0.20),
          leverage: Number(body.leverage || 5),
          autoLeverage: body.autoLeverage !== false,
          availBal: acct.wallet.availableBalance,
          openPositionsCount: acct.positions.length,
          enforceVeto: true
        });
        const exec = await executeLivePick(scanRes.pick, 'MANUAL_UI');
        return res.status(200).json(makeResponse(true, { systemTelemetry: telemetry, pick: scanRes.pick, exec }));
      } catch (err) {
        return res.status(400).json(makeResponse(false, { decision: 'NO_TRADE', error: err.message }, { errorCode: 'TRADE_REJECTED' }));
      } finally {
        await releaseLock('bybit_live_trade_lock', lock.token);
      }
    }

    if (action === 'live_close') {
      if (!isServerLiveAuthorized()) return res.status(403).json(makeResponse(false, { error: 'ALLOW_LIVE_TRADING=true required.' }, { errorCode: 'LIVE_GATE_LOCKED' }));
      const closeRes = await closeVerifiedLivePosition(body.symbol);
      if (!closeRes.closed) return res.status(404).json(makeResponse(false, { error: closeRes.reason }, { errorCode: closeRes.errorCode }));
      await appendJournalEntry({ type: 'LIVE_ORDER_CLOSE', ...closeRes });
      return res.status(200).json(makeResponse(true, closeRes));
    }

    if (action === 'emergency_stop') {
      if (!isServerLiveAuthorized()) return res.status(403).json(makeResponse(false, { error: 'ALLOW_LIVE_TRADING=true required.' }, { errorCode: 'LIVE_GATE_LOCKED' }));
      const haltState = await setTradingHalted(true);
      const stopRes = await executeLiveEmergencyStop();
      await appendJournalEntry({ type: 'EMERGENCY_STOP', ...stopRes });
      const allSucceeded = stopRes.failed.length === 0;
      return res.status(allSucceeded ? 200 : 207).json(makeResponse(allSucceeded, { tradingHalted: haltState.halted, ...stopRes }, { errorCode: allSucceeded ? null : 'PARTIAL_EMERGENCY_STOP' }));
    }

    if (action === 'resume_trading') {
      const haltState = await setTradingHalted(false);
      await appendJournalEntry({ type: 'RESUME_TRADING', storage: haltState.storage });
      return res.status(200).json(makeResponse(true, { tradingHalted: haltState.halted, storage: haltState.storage }));
    }

    return res.status(400).json(makeResponse(false, { error: `Unhandled action: ${action}` }, { errorCode: 'UNHANDLED_ACTION' }));
  } catch (err) {
    return res.status(500).json(makeResponse(false, { error: err.message }, { errorCode: 'INTERNAL_ERROR' }));
  }
};
