// File: api/futures-agent.js
// BYBIT V5 LIVE-ONLY 6-STAGE QUANT PIPELINE ENGINE (v6.0 COMPLETE SNIPER EDITION)
// All 11 Updates: Pullback/Limit Entry, ADX Filter, BTC Trend Filter, Partial TP1 (50%), RSI Guard,
// Manual Timeframe (5m/15m/1h/4h), S/R Zone Guard + Chart Lines, Chart Patterns, Daily Loss/Profit Lock,
// OI & Funding Squeeze Filter, Instant Telegram Trade Alerts.

const { getBybitMarketData, fetchKlines, fetchOpenInterest } = require('../lib/modules/marketData');
const { analyzeVolumeVolatility, evaluateMTF, detectTrend, checkRsiGuard } = require('../lib/modules/indicators');
const { analyzeMarketStructure, checkSrProximity, detectChartPatterns, analyzeLiquidityAndSMC, analyzeFibonacci, analyzeElliottWave } = require('../lib/modules/structureSmc');
const { computeAndValidateEntry, evaluateLiveRisk, checkOiFundingSqueeze, formatBybitPrice } = require('../lib/modules/riskAndValidation');
const { buildDeterministicExplanation, runWalkForward } = require('../lib/modules/aiBrainAndBacktest');
const {
  safeCompareSecret, makeResponse, acquireLock, releaseLock,
  validateRequestNonce, checkRateLimit, getTradingHalted, setTradingHalted,
  appendJournalEntry, getJournalEntries, getSystemHealth,
  recordEquitySnapshot, getEquityHistory, checkDailyGuard
} = require('../lib/modules/securityAndState');
const {
  bybitV5Req, fetchBybitWalletAndPositions, fetchBybitClosedPnlStats,
  configureIsolatedAndLeverage, applyTrailingAndBreakeven,
  closeVerifiedLivePosition, executeLiveEmergencyStop
} = require('../lib/modules/bybitLiveClient');
const { sendTelegramAlert } = require('../lib/modules/telegramNotifier');
const { getAiProviderConfig, fetchFearAndGreed, fetchLiveCryptoHeadlines, runAiSecondOpinion, runGrokStyleChat } = require('../lib/modules/aiAgent');

const TOP_COINS = ['SOL', 'XRP', 'DOGE', 'SUI', 'ADA', 'OP', 'ARB', 'LINK', 'AVAX', 'NEAR', 'APT', 'INJ', 'RENDER', 'TRX', 'LTC', 'BNB', 'ETH', 'BTC'];
const ALLOWED_TFS = new Set(['5m', '15m', '1h', '4h']);
const ALLOWED_ACTIONS = new Set([
  'health', 'status', 'bybit_klines', 'analyze_only', 'scan_and_trade',
  'live_close', 'emergency_stop', 'resume_trading', 'cron_tick', 'backtest', 'journal', 'ai_chat'
]);

function isServerLiveAuthorized() {
  return String(process.env.ALLOW_LIVE_TRADING || '').trim().toLowerCase() === 'true';
}

function isAutoExecuteEnabled() {
  return String(process.env.AUTO_EXECUTE || '').trim().toLowerCase() === 'true';
}

// v6 Update #3: BTC Trend Filter (15m + 1h) for Altcoin Fakeout Prevention
async function getBtcTrendContext() {
  try {
    const [b15, b1h] = await Promise.all([
      fetchKlines('BTC', '15m', 60).catch(() => ({ ok: false })),
      fetchKlines('BTC', '1h', 60).catch(() => ({ ok: false }))
    ]);
    const t15 = b15.ok ? detectTrend(b15.closedCandles.map(x => x[4])).bias : 'NEUTRAL';
    const t1h = b1h.ok ? detectTrend(b1h.closedCandles.map(x => x[4])).bias : 'NEUTRAL';
    let trend = 'NEUTRAL';
    if (t15 === 'BULL' && t1h === 'BULL') trend = 'BULL';
    else if (t15 === 'BEAR' && t1h === 'BEAR') trend = 'BEAR';
    return { ok: true, trend, t15, t1h };
  } catch (e) {
    return { ok: false, trend: 'NEUTRAL', t15: 'NEUTRAL', t1h: 'NEUTRAL' };
  }
}

async function runSixStagePipeline({
  coinMode, manualCoin, humanBias, timeframe = '15m', entryMode = 'limit_pullback',
  riskPerTradePct, maxMarginPct, leverage, autoLeverage, availBal, openPositionsCount, enforceVeto
}) {
  const primaryTf = ALLOWED_TFS.has(timeframe) ? timeframe : '15m';
  const [{ tickers, instMap }, btcTrend] = await Promise.all([
    getBybitMarketData(),
    getBtcTrendContext()
  ]);

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
    const [k1d, k4h, k1h, k15m, k5m, oiData] = await Promise.all([
      safeK('1d', 60), safeK('4h', 60), safeK('1h', 60), safeK('15m', 90), safeK('5m', 60),
      fetchOpenInterest(cand.bybitSymbol, '15min')
    ]);

    const tfMap = { '5m': k5m, '15m': k15m, '1h': k1h, '4h': k4h };
    const primaryK = tfMap[primaryTf] || k15m;

    if (!primaryK.ok) {
      return {
        decision: 'NO_TRADE', noTradeReason: `Data Validation Failed (${primaryTf}): ${primaryK.reason}`,
        coin: cand.coin, bybitSymbol: cand.bybitSymbol, direction: 'NONE',
        spreadPct: +cand.spreadPct.toFixed(3), mtfConfluenceScore: 0,
        mtfBreakdown: { '1D': '--', '4H': '--', '1H': '--', '15M': '--', '5M': '--' },
        orderQty: 0, qtyStep: cand.spec.qtyStep, leverage: leverage || 5, requiredMargin: 0,
        entry: cand.price, sl: 0, tp1: 0, tp: 0, rrRatio: 0, chartTf: primaryTf,
        supportLevels: [], resistanceLevels: [], pattern: 'NONE', adx: 0, rsi: 50,
        btcTrend: btcTrend.trend, oiChangePct: oiData.oiChangePct, summaryNote: primaryK.reason
      };
    }

    const cPrimary = primaryK.closedCandles;
    const mtf = evaluateMTF({
      closes1d: k1d.ok ? k1d.closedCandles.map(x => x[4]) : [],
      closes4h: k4h.ok ? k4h.closedCandles.map(x => x[4]) : [],
      closes1h: k1h.ok ? k1h.closedCandles.map(x => x[4]) : [],
      closes15m: k15m.ok ? k15m.closedCandles.map(x => x[4]) : [],
      closes5m: k5m.ok ? k5m.closedCandles.map(x => x[4]) : []
    });

    const volVol = analyzeVolumeVolatility(cPrimary);
    const structure = analyzeMarketStructure(cPrimary);
    const smc = analyzeLiquidityAndSMC(cPrimary, structure);
    const fib = analyzeFibonacci(cPrimary);
    const elliott = analyzeElliottWave(structure.swingHighs, structure.swingLows);
    const patternData = detectChartPatterns(cPrimary, structure);

    let dir = (mtf.decision === 'LONG' || mtf.decision === 'SHORT') ? mtf.decision : (structure.structure === 'BEARISH_LH_LL' ? 'SHORT' : 'LONG');
    if (humanBias === 'long_only') dir = 'LONG';
    if (humanBias === 'short_only') dir = 'SHORT';

    // v6 Sniper Safety Gates
    const btcOpposing = cand.coin !== 'BTC' && (
      (dir === 'LONG' && btcTrend.trend === 'BEAR') ||
      (dir === 'SHORT' && btcTrend.trend === 'BULL')
    );
    const adxFail = !volVol.isTrending;
    const rsiCheck = checkRsiGuard(volVol.rsi, dir);
    const srCheck = checkSrProximity(cand.price, dir, structure.supportLevels, structure.resistanceLevels);
    const oiCheck = checkOiFundingSqueeze({ direction: dir, fundingRate: cand.fundingRate, oiChangePct: oiData.oiChangePct });

    const levels = computeAndValidateEntry({
      closedCandles: cPrimary, livePrice: cand.price, direction: dir,
      tickSize: cand.spec.tickSize, atr: volVol.atr, spreadPct: cand.spreadPct,
      fundingRate: cand.fundingRate, entryMode, ema20: volVol.ema20, orderBlock: smc.orderBlock, fib
    });

    const preScore = (mtf.ok ? 30 : 10) + (volVol.isTrending ? 15 : 0) + (smc.sweep !== 'NONE' ? 12 : 0) + (patternData.bias === dir ? patternData.scoreBonus : 0) + (volVol.volumeConfirmed ? 12 : 0);

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

    let noTradeReason = null;
    if (mtf.conflictDetected) noTradeReason = mtf.reason;
    else if (btcOpposing) noTradeReason = `NO_TRADE: BTC 15m/1h trend is ${btcTrend.trend} (opposes ${cand.coin} ${dir}).`;
    else if (adxFail) noTradeReason = `NO_TRADE: Choppy market (ADX ${volVol.adx} < 22).`;
    else if (!rsiCheck.ok) noTradeReason = rsiCheck.reason;
    else if (!srCheck.ok) noTradeReason = srCheck.reason;
    else if (!oiCheck.ok) noTradeReason = oiCheck.reason;
    else if (volVol.regime === 'EXTREME_VOLATILITY') noTradeReason = `NO_TRADE: Extreme volatility (${volVol.atrPct}% ATR).`;
    else if (!levels.valid) noTradeReason = levels.reason;
    else if (!risk.approved) noTradeReason = risk.reason;

    const decision = noTradeReason ? 'NO_TRADE' : dir;
    const btcContext = { trend: btcTrend.trend, aligned: !btcOpposing };
    const aiExplanation = buildDeterministicExplanation({
      symbol: cand.bybitSymbol, direction: dir, decision, mtf, structure, smc, fib, elliott, volVol, levels, risk,
      patternData, btcContext, oiData, noTradeReason
    });

    const entry = levels.entry || cand.price;
    const sl = levels.sl || formatBybitPrice(entry * (dir === 'LONG' ? 0.985 : 1.015), cand.spec.tickSize);
    const tp1 = levels.tp1 || formatBybitPrice(entry * (dir === 'LONG' ? 1.02 : 0.98), cand.spec.tickSize);
    const tp = levels.tp || formatBybitPrice(entry * (dir === 'LONG' ? 1.08 : 0.92), cand.spec.tickSize);

    return {
      decision, noTradeReason,
      coin: cand.coin, bybitSymbol: cand.bybitSymbol, direction: dir,
      orderType: levels.orderType || (entryMode === 'limit_pullback' ? 'Limit' : 'Market'),
      spreadPct: +cand.spreadPct.toFixed(3), rrRatio: levels.rrRatio || 0, chartTf: primaryTf,
      mtfConfluenceScore: mtf.agreementPct, mtfBreakdown: mtf.breakdown,
      signalQualityScore: aiExplanation.signalQualityScore, aiExplanation,
      adx: volVol.adx, rsi: volVol.rsi, btcTrend: btcTrend.trend,
      pattern: patternData.pattern, patternNote: patternData.note,
      oiChangePct: oiData.oiChangePct, fundingRatePct: +(cand.fundingRate * 100).toFixed(4),
      whaleAlert: (volVol.volRatio >= 2.5 || Math.abs(oiData.oiChangePct) >= 4) ? `WHALE_SPIKE (Vol ${volVol.volRatio}x, OI ${oiData.oiChangePct}%)` : 'NONE',
      supportLevels: structure.supportLevels, resistanceLevels: structure.resistanceLevels,
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
  return { scannedCount: candidates.length, pick: best, btcTrend };
}

async function executeLivePick(pick, sourceTag = 'MANUAL_UI') {
  const marginConf = await configureIsolatedAndLeverage(pick.bybitSymbol, pick.leverage);
  const side = pick.direction === 'LONG' ? 'Buy' : 'Sell';
  const isLimit = pick.orderType === 'Limit';

  const orderPayload = {
    category: 'linear',
    symbol: pick.bybitSymbol,
    side,
    orderType: isLimit ? 'Limit' : 'Market',
    qty: String(pick.orderQty),
    timeInForce: isLimit ? 'GTC' : 'IOC',
    stopLoss: String(pick.sl),
    takeProfit: String(pick.tp),
    positionIdx: 0
  };
  if (isLimit) orderPayload.price = String(pick.entry);

  const orderRes = await bybitV5Req('POST', '/v5/order/create', orderPayload);

  const journalEntry = await appendJournalEntry({
    type: 'LIVE_ORDER_OPEN',
    source: sourceTag,
    symbol: pick.bybitSymbol,
    direction: pick.direction,
    orderType: orderPayload.orderType,
    qty: pick.orderQty,
    leverage: marginConf.leverage,
    isolated: marginConf.isolatedSet,
    requiredMargin: pick.requiredMargin,
    entry: pick.entry,
    sl: pick.sl,
    tp1: pick.tp1,
    tp: pick.tp,
    pattern: pick.pattern,
    score: pick.signalQualityScore,
    why: pick.aiExplanation?.summary || pick.summaryNote,
    orderId: orderRes?.orderId || null
  });

  await sendTelegramAlert(
    `🚀 <b>BYBIT V6 ${orderPayload.orderType.toUpperCase()} ${pick.direction}</b>\n` +
    `Pair: <b>${pick.bybitSymbol}</b> (${pick.chartTf})\n` +
    `Entry: <code>${pick.entry}</code> | SL: <code>${pick.sl}</code> | TP1: <code>${pick.tp1}</code>\n` +
    `Qty: ${pick.orderQty} | Lev: ${marginConf.leverage}x Isolated | Margin: $${pick.requiredMargin}\n` +
    `Score: ${pick.signalQualityScore}/100 | ADX: ${pick.adx} | Pattern: ${pick.pattern}`
  );

  return {
    orderId: orderRes?.orderId || null,
    marginConf,
    journalEntry,
    orderTypeLabel: `LIVE ${orderPayload.orderType} ${pick.bybitSymbol} ${pick.direction} · Qty ${pick.orderQty} @ ${pick.entry} (${marginConf.leverage}x Iso)`
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
      const tf = ALLOWED_TFS.has(body.tf) ? body.tf : '15m';
      const k = await fetchKlines(body.symbol || 'BTC', tf, 110);
      if (!k.ok) return res.status(200).json(makeResponse(false, { candles: [], error: k.reason }, { sourceStatus: 'UNAVAILABLE', errorCode: k.errorCode }));
      const all = k.incompleteCandle ? [...k.closedCandles, k.incompleteCandle] : k.closedCandles;
      const candles = all.map(c => ({ time: Math.floor(c[0] / 1000), open: c[1], high: c[2], low: c[3], close: c[4] }));
      return res.status(200).json(makeResponse(true, { candles, tf, closedCount: k.closedCandles.length }));
    }

    const maxDailyLossPct = Number(body.maxDailyLossPct || process.env.MAX_DAILY_LOSS_PCT || 5);
    const dailyProfitTargetPct = Number(body.dailyProfitTargetPct || process.env.DAILY_PROFIT_TARGET_PCT || 10);

    // Cron Guardian: Monitors positions, Partial TP1 (50%), Breakeven/Trailing Stop, Daily Lock, Auto-Pilot & Telegram
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
        const [acct, mkt] = await Promise.all([
          fetchBybitWalletAndPositions(),
          getBybitMarketData().catch(() => ({ instMap: {} }))
        ]);
        await recordEquitySnapshot(acct.wallet.totalEquity);
        const dailyGuard = await checkDailyGuard(acct.wallet.totalEquity, { maxDailyLossPct, dailyProfitTargetPct });

        const trailingUpdates = await applyTrailingAndBreakeven(acct.positions, mkt.instMap || {});
        for (const u of trailingUpdates) {
          if (u.action === 'PARTIAL_TP1_50PCT_LOCKED') {
            await sendTelegramAlert(`💰 <b>PARTIAL TP1 LOCKED (50%)</b>\nPair: <b>${u.symbol}</b>\nClosed Qty: ${u.closedQty} at +${u.rMultiple}R`);
          } else if (u.action === 'BREAKEVEN_AND_TRAILING_SET') {
            await sendTelegramAlert(`🛡️ <b>BREAKEVEN & TRAILING ACTIVE</b>\nPair: <b>${u.symbol}</b>\nBE SL: <code>${u.bePrice}</code> | Trail: ${u.trailDist}`);
          }
        }

        const unprotected = acct.positions.filter(p => !p.hasSlProtection).map(p => p.symbol);
        let autoExecResult = null;
        if (!haltedState.halted && !dailyGuard.locked && isServerLiveAuthorized() && isAutoExecuteEnabled() && acct.positions.length < 3) {
          try {
            const scanRes = await runSixStagePipeline({
              coinMode: 'auto', humanBias: 'ai_100', timeframe: '15m', entryMode: 'limit_pullback',
              riskPerTradePct: 0.03, maxMarginPct: 0.20, autoLeverage: true,
              availBal: acct.wallet.availableBalance, openPositionsCount: acct.positions.length, enforceVeto: true
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
          dailyGuardLocked: dailyGuard.locked,
          dailyPnlPct: dailyGuard.dailyPnlPct,
          openPositions: acct.positions.length,
          unprotectedPositions: unprotected,
          trailingUpdatesCount: trailingUpdates.length,
          autoExecTriggered: Boolean(autoExecResult?.orderId),
          availableBalance: acct.wallet.availableBalance
        });

        return res.status(200).json(makeResponse(true, {
          guardian: { checkedPositions: acct.positions.length, unprotectedPositions: unprotected, trailingUpdates, dailyGuard, autoExecResult, tradingHalted: haltedState.halted, log: logRec },
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
      telegramEnabled: Boolean((process.env.TELEGRAM_BOT_TOKEN || '').trim() && (process.env.TELEGRAM_CHAT_ID || '').trim()),
      aiProvider: getAiProviderConfig().provider,
      region: health.region,
      redisStatus: health.redisStatus,
      tradingHalted: health.tradingHalted
    };

    if (action === 'status') {
      const [acct, pnlStats, journal, equityCurve, fearGreed] = await Promise.all([
        fetchBybitWalletAndPositions(),
        fetchBybitClosedPnlStats(50),
        getJournalEntries(),
        getEquityHistory(),
        fetchFearAndGreed()
      ]);
      await recordEquitySnapshot(acct.wallet.totalEquity);
      const dailyGuard = await checkDailyGuard(acct.wallet.totalEquity, { maxDailyLossPct, dailyProfitTargetPct });
      return res.status(200).json(makeResponse(true, { systemTelemetry: telemetry, dailyGuard, fearGreed, pnlStats, journal, equityCurve, ...acct }));
    }


    if (action === 'ai_chat') {
      const question = String(body.question || '').trim();
      if (!question) return res.status(400).json(makeResponse(false, { error: 'Question is required.' }, { errorCode: 'EMPTY_QUESTION' }));
      const [fearGreed, newsRes, acct] = await Promise.all([
        fetchFearAndGreed(),
        fetchLiveCryptoHeadlines(4),
        fetchBybitWalletAndPositions().catch(() => ({ wallet: { availableBalance: 0, totalEquity: 0 }, positions: [] }))
      ]);
      const ctx = [
        `Wallet: Avail $${Number(acct.wallet?.availableBalance || 0).toFixed(2)}, Equity $${Number(acct.wallet?.totalEquity || 0).toFixed(2)}`,
        `Open Positions: ${(acct.positions || []).map(p => `${p.symbol} ${p.side} (${p.leverage}x, uPnL $${Number(p.unrealisedPnl || 0).toFixed(2)})`).join(', ') || 'None'}`,
        `Fear & Greed: ${fearGreed.value} (${fearGreed.classification})`,
        `Top News: ${(newsRes.headlines || []).map(h => h.title).join(' | ') || 'None'}`
      ].join('\n');
      const chatRes = await runGrokStyleChat({ question, contextSummary: ctx });
      return res.status(200).json(makeResponse(chatRes.ok, { reply: chatRes.reply, provider: chatRes.provider, fearGreed }));
    }

    if (action === 'journal') {
      const journal = await getJournalEntries();
      return res.status(200).json(makeResponse(true, { journal, systemTelemetry: telemetry }));
    }

    if (action === 'backtest') {
      const coin = String(body.manualCoin || body.symbol || 'BTC').toUpperCase();
      const tf = ALLOWED_TFS.has(body.timeframe) ? body.timeframe : '15m';
      const k = await fetchKlines(coin, tf, 200);
      if (!k.ok) return res.status(400).json(makeResponse(false, { error: k.reason }, { errorCode: k.errorCode }));
      const wf = runWalkForward(k.closedCandles);
      return res.status(200).json(makeResponse(true, { symbol: `${coin}USDT`, tf, walkForward: wf }));
    }

    if (action === 'analyze_only') {
      let acct = { wallet: { availableBalance: 0, totalEquity: 0, unrealizedPnl: 0 }, positions: [] };
      let walletWarning = null;
      try { acct = await fetchBybitWalletAndPositions(); } catch (e) { walletWarning = `Bybit Wallet Sync Warning: ${e.message}`; }
      const dailyGuard = await checkDailyGuard(acct.wallet.totalEquity, { maxDailyLossPct, dailyProfitTargetPct });

      const scanRes = await runSixStagePipeline({
        coinMode: body.coinMode || 'auto',
        manualCoin: body.manualCoin || 'SOL',
        humanBias: body.humanBias || 'ai_100',
        timeframe: body.timeframe || '15m',
        entryMode: body.entryMode || 'limit_pullback',
        riskPerTradePct: Number(body.riskPerTradePct || 0.03),
        maxMarginPct: Number(body.maxMarginPct || 0.20),
        leverage: Number(body.leverage || 5),
        autoLeverage: body.autoLeverage !== false,
        availBal: acct.wallet.availableBalance,
        openPositionsCount: acct.positions.length,
        enforceVeto: false
      });
      const [fearGreed, newsRes, pnlStats] = await Promise.all([
        fetchFearAndGreed(),
        fetchLiveCryptoHeadlines(5),
        fetchBybitClosedPnlStats(10).catch(() => ({ recent: [] }))
      ]);
      const aiReview = await runAiSecondOpinion({
        pick: scanRes.pick, fearGreed, headlines: newsRes.headlines, recentClosed: pnlStats.recent || []
      });
      return res.status(200).json(makeResponse(true, {
        decision: scanRes.pick.decision, noTradeReason: scanRes.pick.noTradeReason,
        dailyGuard, fearGreed, aiReview, walletWarning, systemTelemetry: telemetry, ...acct, ...scanRes
      }));
    }

    if (action === 'scan_and_trade') {
      if (health.tradingHalted) return res.status(423).json(makeResponse(false, { error: 'TRADING_HALTED: Emergency Stop is active.' }, { errorCode: 'TRADING_HALTED' }));
      if (!liveArmed) return res.status(403).json(makeResponse(false, { error: 'SERVER_LIVE_GATE_LOCKED: Set ALLOW_LIVE_TRADING=true.' }, { errorCode: 'LIVE_GATE_LOCKED' }));
      if (body.liveConfirmed !== true) return res.status(403).json(makeResponse(false, { error: 'LIVE_CONFIRMATION_MISSING: Tick Arm Live.' }, { errorCode: 'CONFIRMATION_MISSING' }));

      const lock = await acquireLock('bybit_live_trade_lock', 15000);
      if (!lock.acquired) return res.status(409).json(makeResponse(false, { error: lock.reason }, { errorCode: 'LOCK_BUSY' }));

      try {
        const acct = await fetchBybitWalletAndPositions();
        const dailyGuard = await checkDailyGuard(acct.wallet.totalEquity, { maxDailyLossPct, dailyProfitTargetPct });
        if (dailyGuard.locked) {
          await sendTelegramAlert(`⛔ <b>${dailyGuard.errorCode}</b>\n${dailyGuard.reason}`);
          return res.status(423).json(makeResponse(false, { error: dailyGuard.reason, dailyGuard }, { errorCode: dailyGuard.errorCode }));
        }

        const scanRes = await runSixStagePipeline({
          coinMode: body.coinMode || 'auto',
          manualCoin: body.manualCoin || 'SOL',
          humanBias: body.humanBias || 'ai_100',
          timeframe: body.timeframe || '15m',
          entryMode: body.entryMode || 'limit_pullback',
          riskPerTradePct: Number(body.riskPerTradePct || 0.03),
          maxMarginPct: Number(body.maxMarginPct || 0.20),
          leverage: Number(body.leverage || 5),
          autoLeverage: body.autoLeverage !== false,
          availBal: acct.wallet.availableBalance,
          openPositionsCount: acct.positions.length,
          enforceVeto: true
        });
        const [fearGreed, newsRes, pnlStats] = await Promise.all([
          fetchFearAndGreed(),
          fetchLiveCryptoHeadlines(5),
          fetchBybitClosedPnlStats(10).catch(() => ({ recent: [] }))
        ]);
        const aiReview = await runAiSecondOpinion({
          pick: scanRes.pick, fearGreed, headlines: newsRes.headlines, recentClosed: pnlStats.recent || []
        });
        if (aiReview.used && aiReview.approve === false) {
          throw new Error(`AI_VETO (${aiReview.provider}): ${aiReview.summary}`);
        }
        const exec = await executeLivePick(scanRes.pick, 'MANUAL_UI');
        return res.status(200).json(makeResponse(true, { systemTelemetry: telemetry, dailyGuard, pick: scanRes.pick, exec }));
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
      await sendTelegramAlert(`🔒 <b>POSITION CLOSED</b>\nPair: <b>${closeRes.symbol}</b> | Qty: ${closeRes.qty}`);
      return res.status(200).json(makeResponse(true, closeRes));
    }

    if (action === 'emergency_stop') {
      if (!isServerLiveAuthorized()) return res.status(403).json(makeResponse(false, { error: 'ALLOW_LIVE_TRADING=true required.' }, { errorCode: 'LIVE_GATE_LOCKED' }));
      const haltState = await setTradingHalted(true);
      const stopRes = await executeLiveEmergencyStop();
      await appendJournalEntry({ type: 'EMERGENCY_STOP', ...stopRes });
      await sendTelegramAlert(`🚨 <b>EMERGENCY STOP TRIGGERED</b>\nClosed ${stopRes.closedCount} positions. Trading HALTED.`);
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
