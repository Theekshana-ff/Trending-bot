// File: api/futures-agent.js
// BYBIT V5 LIVE-ONLY 6-STAGE QUANT PIPELINE ENGINE (v6.0 COMPLETE SNIPER EDITION + EA MODE ON/OFF GATE)
// All 11 Updates: Pullback/Limit Entry, ADX Filter, BTC Trend Filter, Partial TP1 (50%), RSI Guard,
// Manual Timeframe (5m/15m/1h/4h), S/R Zone Guard + Chart Lines, Chart Patterns, Daily Loss/Profit Lock,
// OI & Funding Squeeze Filter, Instant Telegram Trade Alerts, + EA Strategy Gate (ON/OFF).

const { getBybitMarketData, fetchKlines, fetchOpenInterest, fetchOrderBookImbalance } = require('../lib/modules/marketData');
const { analyzeVolumeVolatility, evaluateMTF, detectTrend, checkRsiGuard } = require('../lib/modules/indicators');
const { analyzeMarketStructure, checkSrProximity, detectChartPatterns, detectFalseBreakout, analyzeLiquidityAndSMC, analyzeFibonacci, analyzeElliottWave } = require('../lib/modules/structureSmc');
const { computeAndValidateEntry, evaluateLiveRisk, checkOiFundingSqueeze, formatBybitPrice, formatBybitQty } = require('../lib/modules/riskAndValidation');
const { buildDeterministicExplanation, runWalkForward } = require('../lib/modules/aiBrainAndBacktest');
const {
  safeCompareSecret, makeResponse, acquireLock, releaseLock,
  validateRequestNonce, checkRateLimit, getTradingHalted, setTradingHalted,
  appendJournalEntry, getJournalEntries, getSystemHealth,
  recordEquitySnapshot, getEquityHistory, checkDailyGuard, requireVerifiedRedis, savePositionMeta, sanitizeErrorForClient, getAutoWalletAlloc, setAutoWalletAlloc, getBotFilters, setBotFilters, shouldSendDailyReport, markDailyReportSent, tripCircuitBreaker, getCircuitBreaker, recordSlippage, getSlippageStats, hasLossPostMortemSent, markLossPostMortemSent, getProfitVaultState
} = require('../lib/modules/securityAndState');
const {
  bybitV5Req, fetchBybitWalletAndPositions, chaseOpenLimitOrders, cancelStaleLimitOrders, fetchBybitClosedPnlStats,
  configureIsolatedAndLeverage, applyTrailingAndBreakeven,
  closeVerifiedLivePosition, executeLiveEmergencyStop, verifyOrderStatus, checkDuplicateExposure, reconcileUnprotectedPositions
} = require('../lib/modules/bybitLiveClient');
const { sendTelegramAlert } = require('../lib/modules/telegramNotifier');
const { getAiProviderConfig, fetchFearAndGreed, fetchLiveCryptoHeadlines, runAiSecondOpinion, runGrokStyleChat, runAiLossPostMortem } = require('../lib/modules/aiAgent');
const { checkTradingSession, checkLiquidationSafety, checkCorrelationGuard, checkFundingCountdownGuard, computeCoinAnalytics } = require('../lib/modules/advancedGuards');
const { calcVWAP, checkVwapFilter, detectDivergence, evaluateOrderBookImbalance, fetchBtcDominanceContext, checkBtcDominanceFilter, detectVolatilitySqueeze, detectFlashCrash, evaluateSelfLearningCoin, checkMacroCalendarGuard, selectStrategyRegime, detectMomentumBreakout, evaluateFundingBonus, detectStopHuntReentry, evaluateBestHourBoost } = require('../lib/modules/profitEngine');
const { evaluateBeforeTrade } = require('../lib/modules/eaTradeGate');

const TOP_COINS = ['SOL', 'XRP', 'DOGE', 'SUI', 'ADA', 'OP', 'ARB', 'LINK', 'AVAX', 'NEAR', 'APT', 'INJ', 'RENDER', 'TRX', 'LTC', 'BNB', 'ETH', 'BTC'];
const ALLOWED_TFS = new Set(['5m', '15m', '1h', '4h']);
const ALLOWED_ACTIONS = new Set([
  'health', 'status', 'bybit_klines', 'analyze_only', 'scan_and_trade',
  'live_close', 'emergency_stop', 'resume_trading', 'cron_tick', 'backtest', 'journal', 'ai_chat', 'set_auto_wallet_alloc', 'set_bot_filters', 'weekly_optimize'
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
  riskPerTradePct, maxMarginPct, leverage, autoLeverage, availBal, openPositionsCount, openPositions = [], consecutiveLosses = 0, consecutiveWins = 0, activeSymbols = new Set(), enforceVeto, walletAllocEnabled = false, walletAllocPct = 0.50, botFilters = null, recentClosed = []
}) {
  const primaryTf = ALLOWED_TFS.has(timeframe) ? timeframe : '15m';
  const [{ tickers, instMap }, btcTrend, btcDom, btc5m, cbState] = await Promise.all([
    getBybitMarketData(),
    getBtcTrendContext(),
    fetchBtcDominanceContext(),
    fetchKlines('BTC', '5m', 10).catch(() => ({ ok: false, closedCandles: [] })),
    getCircuitBreaker()
  ]);

  // v10.0 #15: Flash Crash / Spike Circuit Breaker
  if (cbState.active && enforceVeto) {
    throw new Error(cbState.reason || 'NO_TRADE: Flash Crash Circuit Breaker active.');
  }
  if (btc5m.ok) {
    const fc = detectFlashCrash(btc5m.closedCandles);
    if (fc.triggered) {
      await tripCircuitBreaker(fc.reason, 60);
      if (enforceVeto) throw new Error(fc.reason);
    }
  }
  // v10.0 #17: Macro Economic Calendar Guard (FOMC/CPI/NFP)
  const macroCheck = checkMacroCalendarGuard();
  if (!macroCheck.ok && enforceVeto) {
    throw new Error(macroCheck.reason);
  }

  const cleanManual = String(manualCoin || 'SOL').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/USDT$/, '');
  let list = coinMode === 'manual' && cleanManual ? [cleanManual] : TOP_COINS;
  if (coinMode !== 'manual' && botFilters) {
    if (Array.isArray(botFilters.whitelist) && botFilters.whitelist.length) {
      list = list.filter(c => botFilters.whitelist.includes(c));
    }
    if (Array.isArray(botFilters.blacklist) && botFilters.blacklist.length) {
      list = list.filter(c => !botFilters.blacklist.includes(c));
    }
  }
  const sessionCheck = checkTradingSession({ blockWeekend: Boolean(botFilters?.blockWeekend), sessionOnly: Boolean(botFilters?.sessionOnly) });
  if (!sessionCheck.ok && enforceVeto) {
    throw new Error(sessionCheck.reason);
  }

  const useTopMover = Boolean(botFilters?.topMoverScanner) && coinMode !== 'manual';
  const candidates = list.map(coin => {
    const bybitSymbol = `${coin}USDT`;
    const t = tickers[bybitSymbol];
    const spec = instMap[bybitSymbol];
    if (!t || !spec) return null;
    const spreadPct = t.bid1 > 0 ? ((t.ask1 - t.bid1) / t.bid1) * 100 : 0.02;
    const turnover = Number(t.turnover24h || 0);
    const moverScore = Math.abs(t.chgPct) * Math.log10(Math.max(10, turnover));
    return { coin, bybitSymbol, price: t.lastPrice, chgPct: t.chgPct, turnover, moverScore, spreadPct, fundingRate: t.fundingRate, spec };
  }).filter(Boolean)
    .sort((a, b) => useTopMover ? (b.moverScore - a.moverScore) : (Math.abs(b.chgPct) - Math.abs(a.chgPct)))
    .slice(0, useTopMover ? 8 : 4);

  if (!candidates.length) {
    throw new Error('NO_TRADE: No valid active Bybit USDT linear contracts returned.');
  }

  const results = await Promise.all(candidates.map(async cand => {
    const safeK = (tf, lim) => fetchKlines(cand.coin, tf, lim).catch(e => ({ ok: false, reason: e.message, closedCandles: [] }));
    const [k1d, k4h, k1h, k15m, k5m, oiData, obiRaw, slipStats] = await Promise.all([
      safeK('1d', 60), safeK('4h', 60), safeK('1h', 60), safeK('15m', 90), safeK('5m', 60),
      fetchOpenInterest(cand.bybitSymbol, '15min'),
      fetchOrderBookImbalance(cand.bybitSymbol, 10),
      getSlippageStats(cand.bybitSymbol)
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
    const vwapVal = calcVWAP(cPrimary, 48);
    const divergence = detectDivergence(cPrimary);
    const squeeze = detectVolatilitySqueeze(cPrimary, 20);
    const regimeInfo = selectStrategyRegime({
      adx: volVol.adx, rsi: volVol.rsi, price: cand.price,
      supportLevels: structure.supportLevels, resistanceLevels: structure.resistanceLevels,
      divergence, patternData
    });
    if (regimeInfo.allowMeanReversion && regimeInfo.mrDirection && humanBias === 'ai_100') {
      dir = regimeInfo.mrDirection;
    }

    const isBalanced = botFilters?.strategyMode === 'balanced';
    const adxFail = !volVol.isTrending && !(isBalanced && volVol.adx >= 18) && !regimeInfo.allowMeanReversion;
    const rsiCheck = regimeInfo.allowMeanReversion ? { ok: true } : checkRsiGuard(volVol.rsi, dir);
    const vwapCheck = (regimeInfo.allowMeanReversion || isBalanced) ? { ok: true, vwap: vwapVal } : checkVwapFilter(cand.price, vwapVal, dir);
    const obiCheck = evaluateOrderBookImbalance(obiRaw, dir);
    const btcDomCheck = checkBtcDominanceFilter({ coin: cand.coin, direction: dir, btcDom, btcTrend: btcTrend.trend });
    const selfLearn = evaluateSelfLearningCoin(cand.bybitSymbol, recentClosed);
    const highSlippage = slipStats && slipStats.count >= 3 && slipStats.avgSlipPct > 0.25;
    const srCheck = regimeInfo.allowMeanReversion ? { ok: true } : checkSrProximity(cand.price, dir, structure.supportLevels, structure.resistanceLevels);
    const trapCheck = detectFalseBreakout(cPrimary, structure, dir);
    const oiCheck = checkOiFundingSqueeze({ direction: dir, fundingRate: cand.fundingRate, oiChangePct: oiData.oiChangePct });
    const fundingCountdown = checkFundingCountdownGuard({ direction: dir, fundingRate: cand.fundingRate });
    const corrCheck = checkCorrelationGuard({ symbol: cand.bybitSymbol, direction: dir, openPositions });

    const breakout = detectMomentumBreakout({
      closedCandles: cPrimary, direction: dir, volRatio: volVol.volRatio,
      supportLevels: structure.supportLevels, resistanceLevels: structure.resistanceLevels
    });
    const fundingBonus = evaluateFundingBonus({ direction: dir, fundingRate: cand.fundingRate });
    const stopHunt = detectStopHuntReentry({ symbol: cand.bybitSymbol, direction: dir, closedCandles: cPrimary, recentClosed });
    const bestHour = evaluateBestHourBoost(recentClosed);

    const levels = computeAndValidateEntry({
      closedCandles: cPrimary, livePrice: cand.price, direction: dir,
      tickSize: cand.spec.tickSize, atr: volVol.atr, spreadPct: cand.spreadPct,
      fundingRate: cand.fundingRate, entryMode, ema20: volVol.ema20, orderBlock: smc.orderBlock, fib,
      supportLevels: structure.supportLevels, resistanceLevels: structure.resistanceLevels,
      bestBid: obiRaw.bestBid || 0, bestAsk: obiRaw.bestAsk || 0,
      multiCandleConfirm: !isBalanced && !stopHunt.triggered,
      momentumBreakout: breakout.isBreakout
    });

    const preScore = (mtf.ok ? 30 : 10) + (volVol.isTrending ? 15 : 0) + (smc.sweep !== 'NONE' ? 12 : 0)
      + (patternData.bias === dir ? patternData.scoreBonus : 0) + (volVol.volumeConfirmed ? 12 : 0)
      + (divergence.bias === dir ? divergence.scoreBonus : 0) + obiCheck.scoreBonus
      + (squeeze.scoreBonus || 0) + (selfLearn.scoreBonus || 0)
      + (breakout.scoreBonus || 0) + (fundingBonus.scoreBonus || 0) + (stopHunt.scoreBonus || 0);

    const risk = levels.valid
      ? evaluateLiveRisk({
          availBal, entryPrice: levels.entry, slPrice: levels.sl,
          qtyStep: cand.spec.qtyStep, minOrderQty: cand.spec.minOrderQty, maxOrderQty: cand.spec.maxOrderQty,
          minNotionalValue: cand.spec.minNotionalValue,
          riskPerTradePct, maxMarginPct, leverage, autoLeverage,
          atrPct: volVol.atrPct, signalQualityScore: preScore,
          maxLeverage: cand.spec.maxLeverage, openPositionsCount, consecutiveLosses, consecutiveWins,
          bestHourMultiplier: bestHour.multiplier,
          walletAllocEnabled, walletAllocPct, symbol: cand.bybitSymbol
        })
      : { approved: false, orderQty: 0, leverage: leverage || 5, requiredMargin: 0, reason: levels.reason };

    let noTradeReason = null;
    if (activeSymbols.has(cand.bybitSymbol)) noTradeReason = `NO_TRADE: Active position or pending order already exists for ${cand.bybitSymbol}.`;
    else if (mtf.conflictDetected) noTradeReason = mtf.reason;
    else if (btcOpposing) noTradeReason = `NO_TRADE: BTC 15m/1h trend is ${btcTrend.trend} (opposes ${cand.coin} ${dir}).`;
    else if (adxFail) noTradeReason = `NO_TRADE: Choppy market (ADX ${volVol.adx} < 22).`;
    else if (!rsiCheck.ok) noTradeReason = rsiCheck.reason;
    else if (!srCheck.ok) noTradeReason = srCheck.reason;
    else if (trapCheck.isTrap) noTradeReason = trapCheck.reason;
    else if (!vwapCheck.ok) noTradeReason = vwapCheck.reason;
    else if (!obiCheck.ok) noTradeReason = obiCheck.reason;
    else if (!btcDomCheck.ok) noTradeReason = btcDomCheck.reason;
    else if (!selfLearn.ok) noTradeReason = selfLearn.reason;
    else if (highSlippage) noTradeReason = `NO_TRADE: High historical slippage on ${cand.bybitSymbol} (avg ${slipStats.avgSlipPct}%).`;
    else if (!oiCheck.ok) noTradeReason = oiCheck.reason;
    else if (volVol.regime === 'EXTREME_VOLATILITY') noTradeReason = `NO_TRADE: Extreme volatility (${volVol.atrPct}% ATR).`;
    else if (!levels.valid) noTradeReason = levels.reason;
    else if (!fundingCountdown.ok) noTradeReason = fundingCountdown.reason;
    else if (!corrCheck.ok) noTradeReason = corrCheck.reason;
    else if (!risk.approved) noTradeReason = risk.reason;
    else {
      const liqCheck = checkLiquidationSafety({ entryPrice: levels.entry, slPrice: levels.sl, leverage: risk.leverage, direction: dir });
      if (!liqCheck.ok) noTradeReason = liqCheck.reason;
    }

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
      minOrderQty: cand.spec.minOrderQty, minNotionalValue: cand.spec.minNotionalValue,
      leverage: risk.leverage || leverage || 5,
      autoLeverageUsed: Boolean(risk.autoLeverageUsed),
      requiredMargin: risk.requiredMargin || 0,
      entry, entry2: levels.entry2 || 0, sl, tp1, tp, atr: volVol.atr,
      sniperLimitScaling: Boolean(botFilters?.sniperLimitScaling),
      momentumBreakout: breakout.isBreakout,
      fundingFavorable: fundingBonus.favorable,
      stopHuntReentry: stopHunt.triggered,
      bestHourReason: bestHour.reason,
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

  // v11.0 #4: Sniper Limit Scaling (Split Entry 50% at entry + 50% at deeper entry2 when enabled & valid)
  const minQtyReq = Number(pick.minOrderQty || pick.qtyStep || 0.01);
  const minNotReq = Number(pick.minNotionalValue || 5);
  const halfQty1 = formatBybitQty(Number(pick.orderQty) * 0.5, pick.qtyStep);
  const halfQty2 = formatBybitQty(Number(pick.orderQty) - halfQty1, pick.qtyStep);
  const canSplitLimit = Boolean(pick.sniperLimitScaling) && isLimit && Number(pick.entry2 || 0) > 0
    && halfQty1 >= minQtyReq && halfQty2 >= minQtyReq
    && (halfQty1 * pick.entry) >= minNotReq && (halfQty2 * pick.entry2) >= minNotReq;

  const orderPayload = {
    category: 'linear',
    symbol: pick.bybitSymbol,
    side,
    orderType: isLimit ? 'Limit' : 'Market',
    qty: String(canSplitLimit ? halfQty1 : pick.orderQty),
    timeInForce: isLimit ? 'PostOnly' : 'IOC',
    stopLoss: String(pick.sl),
    takeProfit: String(pick.tp),
    positionIdx: 0
  };
  if (isLimit) orderPayload.price = String(pick.entry);

  const orderRes = await bybitV5Req('POST', '/v5/order/create', orderPayload);
  let splitOrder2Id = null;
  if (canSplitLimit) {
    try {
      const ord2 = await bybitV5Req('POST', '/v5/order/create', {
        category: 'linear',
        symbol: pick.bybitSymbol,
        side,
        orderType: 'Limit',
        qty: String(halfQty2),
        price: String(pick.entry2),
        timeInForce: 'PostOnly',
        stopLoss: String(pick.sl),
        takeProfit: String(pick.tp),
        positionIdx: 0
      });
      splitOrder2Id = ord2?.orderId || null;
    } catch (e) {}
  }
  const orderVerification = await verifyOrderStatus(pick.bybitSymbol, orderRes?.orderId);
  if (orderVerification?.verified && orderVerification.avgPrice > 0) {
    await recordSlippage(pick.bybitSymbol, pick.entry, orderVerification.avgPrice);
  }
  await savePositionMeta(pick.bybitSymbol, { entry: pick.entry, initialSl: pick.sl, direction: pick.direction, atr: pick.atr || 0 });

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
    `Entry: <code>${pick.entry}</code>${splitOrder2Id ? ` + Split2: <code>${pick.entry2}</code>` : ''} | SL: <code>${pick.sl}</code> | TP1: <code>${pick.tp1}</code>\n` +
    `Qty: ${pick.orderQty} | Lev: ${marginConf.leverage}x ${marginConf.marginModeLabel} | Margin: $${pick.requiredMargin}\n` +
    `Score: ${pick.signalQualityScore}/100 | ADX: ${pick.adx} | Pattern: ${pick.pattern}`
  );

  return {
    orderId: orderRes?.orderId || null,
    orderVerification,
    marginConf,
    journalEntry,
    orderTypeLabel: `LIVE ${orderPayload.orderType} ${pick.bybitSymbol} ${pick.direction} · Qty ${pick.orderQty} @ ${pick.entry} (${marginConf.leverage}x ${marginConf.marginModeLabel})`
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

    const envMaxDailyLoss = Number(process.env.MAX_DAILY_LOSS_PCT || 5);
    const envMaxRiskPct = Number(process.env.MAX_RISK_PER_TRADE_PCT || 0.02);
    const envMaxMarginPct = Number(process.env.MAX_MARGIN_PCT || 0.20);
    const maxDailyLossPct = Math.min(envMaxDailyLoss, Math.max(0.5, Number(body.maxDailyLossPct || envMaxDailyLoss)));
    const dailyProfitTargetPct = Math.max(1, Number(body.dailyProfitTargetPct || process.env.DAILY_PROFIT_TARGET_PCT || 10));
    const cappedRiskPct = Math.min(envMaxRiskPct, Math.max(0.0025, Number(body.riskPerTradePct || 0.015)));
    const cappedMarginPct = Math.min(envMaxMarginPct, Math.max(0.05, Number(body.maxMarginPct || 0.20)));

    // v10.0 #20: Automated Weekly Strategy Optimizer (Walk-Forward across top coins -> Telegram Report)
    if (action === 'weekly_optimize') {
      const expectedCron = (process.env.CRON_SECRET || '').trim();
      const providedCron = String(req.headers?.['x-cron-secret'] || req.headers?.authorization?.replace(/^Bearer\s+/i, '') || '').trim();
      if (!expectedCron || !safeCompareSecret(providedCron, expectedCron)) {
        return res.status(401).json(makeResponse(false, { error: 'Unauthorized: Valid CRON_SECRET required.' }, { errorCode: 'CRON_UNAUTHORIZED' }));
      }
      const coins = ['BTC', 'ETH', 'SOL', 'XRP', 'SUI'];
      const reports = [];
      for (const coin of coins) {
        const k = await fetchKlines(coin, '15m', 200).catch(() => ({ ok: false }));
        if (!k.ok) continue;
        const wf = runWalkForward(k.closedCandles);
        if (wf.ok) {
          reports.push({
            symbol: `${coin}USDT`,
            oosTrades: wf.outOfSample?.sampleCount || 0,
            oosWinRate: wf.outOfSample?.winRate || 0,
            oosExpR: wf.outOfSample?.expectancyR || 0,
            approved: wf.enabled
          });
        }
      }
      reports.sort((a, b) => b.oosExpR - a.oosExpR);
      const summaryLines = reports.map(r => `- <b>${r.symbol}</b>: WR ${r.oosWinRate}% | Exp ${r.oosExpR}R (${r.oosTrades} trades)`).join('\n') || 'No valid samples';
      let weeklyPerfBlock = '';
      try {
        const stats7d = await fetchBybitClosedPnlStats(50);
        const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
        const wk = (stats7d.recent || []).filter(t => Number(t.updatedTime || 0) >= weekAgo);
        if (wk.length) {
          const net = wk.reduce((s, t) => s + Number(t.closedPnl || 0), 0);
          const wins = wk.filter(t => Number(t.closedPnl || 0) > 0).length;
          const wr = ((wins / wk.length) * 100).toFixed(1);
          const byC = {};
          wk.forEach(t => { byC[t.symbol] = (byC[t.symbol] || 0) + Number(t.closedPnl || 0); });
          const sorted = Object.entries(byC).sort((a, b) => b[1] - a[1]);
          weeklyPerfBlock =
            `\n\n📅 <b>WEEKLY PERFORMANCE (7D)</b>\n` +
            `Net PnL: <b>$${net.toFixed(2)}</b> | WR: <b>${wr}%</b> (${wins}W/${wk.length - wins}L)\n` +
            `🏆 Best: <b>${sorted[0][0]}</b> ($${sorted[0][1].toFixed(2)}) | ⚠️ Worst: <b>${sorted[sorted.length - 1][0]}</b> ($${sorted[sorted.length - 1][1].toFixed(2)})`;
        }
      } catch (e) {}
      await sendTelegramAlert(`🧠 <b>WEEKLY WALK-FORWARD OPTIMIZER (v10.0)</b>\n${summaryLines}${weeklyPerfBlock}`);
      return res.status(200).json(makeResponse(true, { optimizer: reports }));
    }

    // Cron Guardian: Monitors positions, Partial TP1 (50%), Breakeven/Trailing Stop, Daily Lock, Auto-Pilot & Telegram
    if (action === 'cron_tick') {
      const expectedCron = (process.env.CRON_SECRET || '').trim();
      const providedCron = String(req.headers?.['x-cron-secret'] || req.headers?.authorization?.replace(/^Bearer\s+/i, '') || '').trim();
      if (!expectedCron || !safeCompareSecret(providedCron, expectedCron)) {
        return res.status(401).json(makeResponse(false, { error: 'Unauthorized: Valid CRON_SECRET required.' }, { errorCode: 'CRON_UNAUTHORIZED' }));
      }
      const lock = await acquireLock('bybit_cron_guardian_lock', 35000);
      if (!lock.acquired) return res.status(409).json(makeResponse(false, { error: lock.reason }, { errorCode: 'CRON_LOCKED' }));

      try {
        const haltedState = await getTradingHalted();
        const [acct, mkt, activeBotFilters] = await Promise.all([
          fetchBybitWalletAndPositions(),
          getBybitMarketData().catch(() => ({ instMap: {} })),
          getBotFilters()
        ]);
        await recordEquitySnapshot(acct.wallet.totalEquity);
        const dailyGuard = await checkDailyGuard(acct.wallet.totalEquity, { maxDailyLossPct, dailyProfitTargetPct, strict: true });

        const [trailingUpdates, chasedOrders, cancelledStale, slReconciled] = await Promise.all([
          applyTrailingAndBreakeven(acct.positions, mkt.instMap || {}, { pyramidingEnabled: Boolean(activeBotFilters?.pyramidingEnabled) }),
          chaseOpenLimitOrders(acct.openOrders || [], mkt.tickers || {}, mkt.instMap || {}),
          cancelStaleLimitOrders(acct.openOrders || [], 45),
          reconcileUnprotectedPositions(acct.positions, mkt.instMap || {})
        ]);
        for (const ch of chasedOrders) {
          await sendTelegramAlert(`🎯 <b>SMART CHASE LIMIT</b>\nPair: <b>${ch.symbol}</b> (${ch.side})\nAdjusted Entry: <code>${ch.oldPrice}</code> → <code>${ch.newPrice}</code>`);
        }
        for (const u of trailingUpdates) {
          if (u.action === 'PARTIAL_TP1_25PCT_LOCKED' || u.action === 'PARTIAL_TP1_40PCT_LOCKED' || u.action === 'PARTIAL_TP1_50PCT_LOCKED') {
            await sendTelegramAlert(`💰 <b>TP1 LOCKED (25% Runner Mode)</b>\nPair: <b>${u.symbol}</b>\nClosed Qty: ${u.closedQty} at +${u.rMultiple}R`);
          } else if (u.action === 'PARTIAL_TP2_25PCT_LOCKED' || u.action === 'PARTIAL_TP2_30PCT_LOCKED') {
            await sendTelegramAlert(`💰💰 <b>TP2 LOCKED (25% · 50% Runner Active)</b>\nPair: <b>${u.symbol}</b>\nClosed Qty: ${u.closedQty} at +${u.rMultiple}R`);
          } else if (u.action === 'TRAILING_TIGHTENED_4R') {
            await sendTelegramAlert(`🔒 <b>TRAILING TIGHTENED (1.0x ATR @ +${u.rMultiple}R)</b>\nPair: <b>${u.symbol}</b> | Trail: ${u.trailDist}`);
          } else if (u.action === 'BREAKEVEN_AND_TRAILING_SET') {
            await sendTelegramAlert(`🛡️ <b>CHANDELIER TRAILING ACTIVE</b>\nPair: <b>${u.symbol}</b>\nBE SL: <code>${u.bePrice}</code> | Trail: ${u.trailDist}`);
          } else if (u.action === 'PYRAMID_SCALED_IN_25PCT') {
            await sendTelegramAlert(`🔥 <b>PYRAMID SCALED IN (+25%)</b>\nPair: <b>${u.symbol}</b> at +${u.rMultiple}R`);
          } else if (u.action === 'DEAD_TRADE_EXITED') {
            await sendTelegramAlert(`⏱️ <b>DEAD TRADE AUTO-EXITED</b>\nPair: <b>${u.symbol}</b> (${u.rMultiple}R) to save funding fees.`);
          }
        }

        const unprotected = acct.positions.filter(p => !p.hasSlProtection).map(p => p.symbol);
        let autoExecResult = null;
        const redisOk = (await requireVerifiedRedis()).ok;
        const activeSymbols = new Set([...acct.positions.map(p => p.symbol), ...(acct.openOrders || []).map(o => o.symbol)]);
        const totalExposureCount = acct.positions.length + (acct.openOrders || []).length;
        if (redisOk && acct.openOrdersVerified !== false && !haltedState.halted && !dailyGuard.locked && isServerLiveAuthorized() && isAutoExecuteEnabled() && totalExposureCount < 3) {
          try {
            const [walletAlloc, botFilters, histPnl, profitVault] = await Promise.all([
              getAutoWalletAlloc(), getBotFilters(),
              fetchBybitClosedPnlStats(50).catch(() => ({ recent: [], consecutiveLosses: 0, consecutiveWins: 0 })),
              getProfitVaultState(acct.wallet.totalEquity)
            ]);
            const tradableAvail = Math.max(0, acct.wallet.availableBalance - (profitVault.lockedUsdt || 0));
            const scanRes = await runSixStagePipeline({
              coinMode: 'auto', humanBias: 'ai_100', timeframe: '15m', entryMode: 'limit_pullback',
              riskPerTradePct: cappedRiskPct, maxMarginPct: cappedMarginPct, autoLeverage: true,
              availBal: tradableAvail, openPositionsCount: totalExposureCount, openPositions: acct.positions,
              consecutiveLosses: histPnl.consecutiveLosses || 0, consecutiveWins: histPnl.consecutiveWins || 0,
              activeSymbols, enforceVeto: true, botFilters, recentClosed: histPnl.recent || [],
              walletAllocEnabled: walletAlloc.enabled,
              walletAllocPct: (walletAlloc.pct || 50) / 100
            });
            const minAutoScore = botFilters?.strategyMode === 'balanced' ? 60 : 75;
            if (scanRes.pick.signalQualityScore >= minAutoScore) {
              const [fearGreed, newsRes, pnlStats] = await Promise.all([
                fetchFearAndGreed(),
                fetchLiveCryptoHeadlines(6, scanRes.pick.bybitSymbol),
                fetchBybitClosedPnlStats(10).catch(() => ({ recent: [] }))
              ]);
              const aiReview = await runAiSecondOpinion({
                pick: scanRes.pick, fearGreed, headlines: newsRes.headlines, recentClosed: pnlStats.recent || []
              });
              if (aiReview.used && aiReview.approve === false) {
                autoExecResult = { vetoed: true, provider: aiReview.provider, reason: aiReview.summary, newsSentiment: aiReview.newsSentiment };
                await appendJournalEntry({ type: 'AI_NEWS_VETO', source: 'CRON_AUTOPILOT', symbol: scanRes.pick.bybitSymbol, direction: scanRes.pick.direction, ...autoExecResult });
                await sendTelegramAlert(`🚫 <b>AUTO-VETO (LIVE NEWS / AI)</b>\nPair: <b>${scanRes.pick.bybitSymbol}</b> (${scanRes.pick.direction})\nSource: ${aiReview.provider}\nReason: ${aiReview.summary}`);
              } else {
                // EA Mode ON/OFF Gate (OFF -> Normal v6 runs untouched; ON -> EA MTF confirmation required)
                const eaGate = await evaluateBeforeTrade(scanRes.pick.bybitSymbol, scanRes.pick.direction, 65);
                if (!eaGate.allow) {
                  autoExecResult = { vetoed: true, provider: 'EA_STRATEGY_GATE', reason: eaGate.reason };
                  await appendJournalEntry({ type: 'EA_GATE_VETO', source: 'CRON_AUTOPILOT', symbol: scanRes.pick.bybitSymbol, direction: scanRes.pick.direction, reason: eaGate.reason });
                } else {
                  autoExecResult = await executeLivePick(scanRes.pick, 'CRON_AUTOPILOT');
                  autoExecResult.aiReview = aiReview;
                  autoExecResult.eaGate = eaGate;
                }
              }
            }
          } catch (e) {
            autoExecResult = { skipped: true, reason: e.message };
          }
        }

        // v10.0.3 #5: AI Loss Post-Mortem Report for latest closed losing trade
        try {
          const recentPnl = await fetchBybitClosedPnlStats(5);
          const latestTrade = (recentPnl.recent || [])[0];
          if (latestTrade && Number(latestTrade.closedPnl || 0) < 0) {
            const tradeKey = `${latestTrade.symbol}_${latestTrade.updatedTime || latestTrade.createdTime || latestTrade.closedPnl}`;
            const ageMs = Date.now() - Number(latestTrade.updatedTime || Date.now());
            if (ageMs < 6 * 3600 * 1000 && !(await hasLossPostMortemSent(tradeKey))) {
              const fg = await fetchFearAndGreed().catch(() => null);
              const pm = await runAiLossPostMortem({ trade: latestTrade, fearGreed: fg });
              if (pm.ok && pm.report) {
                await sendTelegramAlert(`🧠 <b>AI LOSS POST-MORTEM (${latestTrade.symbol})</b>\nPnL: <b>$${Number(latestTrade.closedPnl).toFixed(4)}</b>\n${pm.report}`);
              }
              await markLossPostMortemSent(tradeKey);
            }
          }
        } catch (e) {}

        if (await shouldSendDailyReport()) {
          const stats = await fetchBybitClosedPnlStats(50);
          await sendTelegramAlert(
            `📈 <b>DAILY BOT REPORT (UTC)</b>\n` +
            `Equity: <b>$${acct.wallet.totalEquity.toFixed(2)}</b> (${dailyGuard.dailyPnlPct >= 0 ? '+' : ''}${dailyGuard.dailyPnlPct}%)\n` +
            `Win Rate (50): <b>${stats.winRate}%</b> (${stats.wins}W / ${stats.losses}L)\n` +
            `Closed PnL: <b>$${stats.totalClosedPnl}</b> | Best: $${stats.bestTrade}`
          );
          await markDailyReportSent();
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
      const [acct, pnlStats, journal, equityCurve, fearGreed, autoWalletAlloc, botFilters] = await Promise.all([
        fetchBybitWalletAndPositions(),
        fetchBybitClosedPnlStats(50),
        getJournalEntries(),
        getEquityHistory(),
        fetchFearAndGreed(),
        getAutoWalletAlloc(),
        getBotFilters()
      ]);
      await recordEquitySnapshot(acct.wallet.totalEquity);
      const [dailyGuard, profitVault] = await Promise.all([
        checkDailyGuard(acct.wallet.totalEquity, { maxDailyLossPct, dailyProfitTargetPct }),
        getProfitVaultState(acct.wallet.totalEquity)
      ]);
      const coinAnalytics = computeCoinAnalytics(pnlStats.recent || []);
      return res.status(200).json(makeResponse(true, { systemTelemetry: telemetry, dailyGuard, profitVault, fearGreed, autoWalletAlloc, botFilters, coinAnalytics, pnlStats, journal, equityCurve, ...acct }));
    }

    if (action === 'set_auto_wallet_alloc') {
      const saved = await setAutoWalletAlloc({
        enabled: body.enabled === true,
        pct: Number(body.pct || 50)
      });
      await appendJournalEntry({ type: 'AUTO_WALLET_ALLOC_UPDATED', ...saved });
      return res.status(200).json(makeResponse(true, { autoWalletAlloc: saved }));
    }

    if (action === 'set_bot_filters') {
      const existingFilters = (await getBotFilters()) || {};
      const saved = await setBotFilters({
        ...existingFilters,
        whitelist: body.whitelist,
        blacklist: body.blacklist,
        blockWeekend: body.blockWeekend === true,
        sessionOnly: body.sessionOnly === true,
        strategyMode: body.strategyMode === 'balanced' ? 'balanced' : 'strict',
        pyramidingEnabled: body.pyramidingEnabled === true,
        sniperLimitScaling: body.sniperLimitScaling === true,
        topMoverScanner: body.topMoverScanner === true,
        eaMode: typeof body.eaMode === 'boolean' ? body.eaMode : Boolean(existingFilters.eaMode)
      });
      await appendJournalEntry({ type: 'BOT_FILTERS_UPDATED', ...saved });
      return res.status(200).json(makeResponse(true, { botFilters: saved }));
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
        riskPerTradePct: cappedRiskPct,
        maxMarginPct: cappedMarginPct,
        leverage: Number(body.leverage || 5),
        autoLeverage: body.autoLeverage !== false,
        availBal: acct.wallet.availableBalance,
        openPositionsCount: acct.positions.length,
        botFilters: await getBotFilters(),
        enforceVeto: false,
        walletAllocEnabled: body.walletAllocEnabled === true,
        walletAllocPct: Number(body.walletAllocPct || 50) / 100
      });
      const [fearGreed, newsRes, pnlStats] = await Promise.all([
        fetchFearAndGreed(),
        fetchLiveCryptoHeadlines(6, scanRes.pick.bybitSymbol),
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

      const redisCheck = await requireVerifiedRedis();
      if (!redisCheck.ok) return res.status(503).json(makeResponse(false, { error: redisCheck.reason }, { errorCode: redisCheck.errorCode }));
      const lock = await acquireLock('bybit_live_trade_lock', 35000);
      if (!lock.acquired) return res.status(409).json(makeResponse(false, { error: lock.reason }, { errorCode: 'LOCK_BUSY' }));

      try {
        const [acct, pnlStatsPre] = await Promise.all([fetchBybitWalletAndPositions(), fetchBybitClosedPnlStats(20)]);
        const activeSymbols = new Set([...acct.positions.map(p => p.symbol), ...(acct.openOrders || []).map(o => o.symbol)]);
        const totalExposureCount = acct.positions.length + (acct.openOrders || []).length;
        if (acct.openOrdersVerified === false) {
          return res.status(503).json(makeResponse(false, { error: `FAIL_CLOSED: Open Orders API failed (${acct.openOrdersError}).` }, { errorCode: 'OPEN_ORDERS_UNVERIFIED' }));
        }
        const dailyGuard = await checkDailyGuard(acct.wallet.totalEquity, { maxDailyLossPct, dailyProfitTargetPct, strict: true });
        if (dailyGuard.locked) {
          await sendTelegramAlert(`⛔ <b>${dailyGuard.errorCode}</b>\n${dailyGuard.reason}`);
          return res.status(423).json(makeResponse(false, { error: dailyGuard.reason, dailyGuard }, { errorCode: dailyGuard.errorCode }));
        }

        const profitVault = await getProfitVaultState(acct.wallet.totalEquity);
        const tradableAvail = Math.max(0, acct.wallet.availableBalance - (profitVault.lockedUsdt || 0));
        const scanRes = await runSixStagePipeline({
          coinMode: body.coinMode || 'auto',
          manualCoin: body.manualCoin || 'SOL',
          humanBias: body.humanBias || 'ai_100',
          timeframe: body.timeframe || '15m',
          entryMode: body.entryMode || 'limit_pullback',
          riskPerTradePct: cappedRiskPct,
          maxMarginPct: cappedMarginPct,
          leverage: Number(body.leverage || 5),
          autoLeverage: body.autoLeverage !== false,
          availBal: tradableAvail,
          openPositionsCount: totalExposureCount,
          openPositions: acct.positions,
          botFilters: await getBotFilters(),
          consecutiveLosses: pnlStatsPre.consecutiveLosses || 0,
          consecutiveWins: pnlStatsPre.consecutiveWins || 0,
          recentClosed: pnlStatsPre.recent || [],
          activeSymbols,
          enforceVeto: true,
          walletAllocEnabled: body.walletAllocEnabled === true,
          walletAllocPct: Number(body.walletAllocPct || 50) / 100
        });
        const [fearGreed, newsRes, pnlStats] = await Promise.all([
          fetchFearAndGreed(),
          fetchLiveCryptoHeadlines(6, scanRes.pick.bybitSymbol),
          fetchBybitClosedPnlStats(10).catch(() => ({ recent: [] }))
        ]);
        const aiReview = await runAiSecondOpinion({
          pick: scanRes.pick, fearGreed, headlines: newsRes.headlines, recentClosed: pnlStats.recent || []
        });
        if (aiReview.used && aiReview.approve === false) {
          await appendJournalEntry({ type: 'AI_NEWS_VETO', source: 'MANUAL_UI', symbol: scanRes.pick.bybitSymbol, direction: scanRes.pick.direction, provider: aiReview.provider, reason: aiReview.summary });
          await sendTelegramAlert(`🚫 <b>TRADE VETOED (LIVE NEWS / AI)</b>\nPair: <b>${scanRes.pick.bybitSymbol}</b> (${scanRes.pick.direction})\nSource: ${aiReview.provider}\nReason: ${aiReview.summary}`);
          throw new Error(`AI_VETO (${aiReview.provider}): ${aiReview.summary}`);
        }
        const dupCheck = checkDuplicateExposure(scanRes.pick.bybitSymbol, acct);
        if (dupCheck.blocked) {
          throw new Error(dupCheck.reason);
        }
        // EA Mode ON/OFF Gate (OFF -> Normal v6 runs untouched; ON -> EA MTF confirmation required)
        const eaGate = await evaluateBeforeTrade(scanRes.pick.bybitSymbol, scanRes.pick.direction, 65);
        if (!eaGate.allow) {
          await appendJournalEntry({ type: 'EA_GATE_VETO', source: 'MANUAL_UI', symbol: scanRes.pick.bybitSymbol, direction: scanRes.pick.direction, reason: eaGate.reason });
          throw new Error(`EA_GATE_VETO: ${eaGate.reason}`);
        }
        const exec = await executeLivePick(scanRes.pick, 'MANUAL_UI');
        return res.status(200).json(makeResponse(true, { systemTelemetry: telemetry, dailyGuard, aiReview, eaGate, pick: scanRes.pick, exec }));
      } catch (err) {
        return res.status(400).json(makeResponse(false, { decision: 'NO_TRADE', error: err.message }, { errorCode: 'TRADE_REJECTED' }));
      } finally {
        await releaseLock('bybit_live_trade_lock', lock.token);
      }
    }

    if (action === 'live_close') {
      const closeRes = await closeVerifiedLivePosition(body.symbol);
      if (!closeRes.closed) return res.status(404).json(makeResponse(false, { error: closeRes.reason }, { errorCode: closeRes.errorCode }));
      await appendJournalEntry({ type: 'LIVE_ORDER_CLOSE', ...closeRes });
      await sendTelegramAlert(`🔒 <b>POSITION CLOSED</b>\nPair: <b>${closeRes.symbol}</b> | Qty: ${closeRes.qty}`);
      return res.status(200).json(makeResponse(true, closeRes));
    }

    if (action === 'emergency_stop') {
      const haltState = await setTradingHalted(true);
      const stopRes = await executeLiveEmergencyStop();
      await appendJournalEntry({ type: 'EMERGENCY_STOP', ...stopRes });
      await sendTelegramAlert(`🚨 <b>EMERGENCY STOP TRIGGERED</b>\nClosed ${stopRes.closedCount} positions. Trading HALTED.`);
      const allSucceeded = stopRes.failed.length === 0 && stopRes.cancelledOrders;
      return res.status(allSucceeded ? 200 : 207).json(makeResponse(allSucceeded, { tradingHalted: haltState.halted, ...stopRes }, { errorCode: allSucceeded ? null : 'PARTIAL_EMERGENCY_STOP' }));
    }

    if (action === 'resume_trading') {
      const haltState = await setTradingHalted(false);
      await appendJournalEntry({ type: 'RESUME_TRADING', storage: haltState.storage });
      return res.status(200).json(makeResponse(true, { tradingHalted: haltState.halted, storage: haltState.storage }));
    }

    return res.status(400).json(makeResponse(false, { error: `Unhandled action: ${action}` }, { errorCode: 'UNHANDLED_ACTION' }));
  } catch (err) {
    return res.status(500).json(makeResponse(false, { error: sanitizeErrorForClient(err) }, { errorCode: 'INTERNAL_ERROR' }));
  }
};
