// Module 24: v10.0 Profit & Alpha Engine
// Covers: #1 VWAP Institutional Filter, #2 RSI & MACD Divergence, #3 OBI Eval,
//         #4 BTC.D Filter, #7 Chandelier/Supertrend Trailing, #14 Volatility Squeeze (BB+KC),
//         #15 Flash Crash Detector, #16 Self-Learning Coin Scoring,
//         #17 Macro Economic Calendar Guard, #18 Multi-Strategy Regime Switcher

const { calcEMA, calcRSI, calcWilderATR } = require('./indicators');
const { fetchWithTimeout } = require('./marketData');

let cachedBtcDom = { ok: false, dominance: 55, chg24h: 0, fetchedAt: 0 };

// #1 VWAP Institutional Filter
function calcVWAP(candles, lookback = 48) {
  if (!Array.isArray(candles) || candles.length < 5) return 0;
  const slice = candles.slice(-Math.min(candles.length, lookback));
  let pvSum = 0;
  let volSum = 0;
  for (const c of slice) {
    const typical = (Number(c[2]) + Number(c[3]) + Number(c[4])) / 3;
    const vol = Math.max(0, Number(c[5] || 0));
    pvSum += typical * vol;
    volSum += vol;
  }
  return volSum > 0 ? pvSum / volSum : slice[slice.length - 1][4];
}

function checkVwapFilter(price, vwap, direction, tolerancePct = 0.0025) {
  if (!Number.isFinite(price) || !Number.isFinite(vwap) || vwap <= 0) {
    return { ok: true, aligned: true, vwap: 0, reason: null };
  }
  if (direction === 'LONG' && price < vwap * (1 - tolerancePct)) {
    return {
      ok: false,
      aligned: false,
      vwap: +vwap.toPrecision(6),
      errorCode: 'BELOW_VWAP_LONG',
      reason: `NO_TRADE: Price (${price}) is below institutional VWAP (${vwap.toPrecision(6)}) for LONG.`
    };
  }
  if (direction === 'SHORT' && price > vwap * (1 + tolerancePct)) {
    return {
      ok: false,
      aligned: false,
      vwap: +vwap.toPrecision(6),
      errorCode: 'ABOVE_VWAP_SHORT',
      reason: `NO_TRADE: Price (${price}) is above institutional VWAP (${vwap.toPrecision(6)}) for SHORT.`
    };
  }
  return { ok: true, aligned: true, vwap: +vwap.toPrecision(6), reason: null };
}

// #2 RSI & MACD Divergence Detector
function calcMACD(closes) {
  if (!Array.isArray(closes) || closes.length < 30) {
    return { macd: 0, signal: 0, histogram: 0, prevHistogram: 0 };
  }
  const macdSeries = [];
  for (let i = 26; i <= closes.length; i++) {
    const sub = closes.slice(0, i);
    macdSeries.push(calcEMA(sub, 12) - calcEMA(sub, 26));
  }
  const signal = calcEMA(macdSeries, 9);
  const macd = macdSeries[macdSeries.length - 1];
  const prevSignal = macdSeries.length > 1 ? calcEMA(macdSeries.slice(0, -1), 9) : signal;
  const prevMacd = macdSeries.length > 1 ? macdSeries[macdSeries.length - 2] : macd;
  return {
    macd: +macd.toFixed(6),
    signal: +signal.toFixed(6),
    histogram: +(macd - signal).toFixed(6),
    prevHistogram: +(prevMacd - prevSignal).toFixed(6)
  };
}

function detectDivergence(candles) {
  if (!Array.isArray(candles) || candles.length < 35) {
    return { type: 'NONE', bias: 'NEUTRAL', scoreBonus: 0, macdHist: 0 };
  }
  const closes = candles.map(c => c[4]);
  const macd = calcMACD(closes);

  // Compare recent 10-bar window vs prior 10-bar window
  const recentSlice = candles.slice(-10);
  const priorSlice = candles.slice(-22, -10);

  const recentLow = Math.min(...recentSlice.map(c => c[3]));
  const priorLow = Math.min(...priorSlice.map(c => c[3]));
  const recentHigh = Math.max(...recentSlice.map(c => c[2]));
  const priorHigh = Math.max(...priorSlice.map(c => c[2]));

  const recentRsi = calcRSI(closes, 14);
  const priorRsi = calcRSI(closes.slice(0, -10), 14);

  if (recentLow < priorLow * 0.998 && recentRsi > priorRsi + 3 && macd.histogram >= macd.prevHistogram) {
    return { type: 'BULLISH_RSI_MACD_DIV', bias: 'LONG', scoreBonus: 12, macdHist: macd.histogram };
  }
  if (recentHigh > priorHigh * 1.002 && recentRsi < priorRsi - 3 && macd.histogram <= macd.prevHistogram) {
    return { type: 'BEARISH_RSI_MACD_DIV', bias: 'SHORT', scoreBonus: 12, macdHist: macd.histogram };
  }
  return { type: 'NONE', bias: 'NEUTRAL', scoreBonus: 0, macdHist: macd.histogram };
}

// #3 Order Book Imbalance (OBI) Evaluation
function evaluateOrderBookImbalance(obiData, direction) {
  if (!obiData || !obiData.ok) return { ok: true, scoreBonus: 0, obi: 0, reason: null };
  const obi = Number(obiData.obi || 0); // -1 to +1
  if (direction === 'LONG' && obi < -0.45) {
    return { ok: false, scoreBonus: 0, obi, errorCode: 'HEAVY_ASK_WALL', reason: `NO_TRADE: Order book heavily skewed to sellers (OBI ${(obi * 100).toFixed(1)}%).` };
  }
  if (direction === 'SHORT' && obi > 0.45) {
    return { ok: false, scoreBonus: 0, obi, errorCode: 'HEAVY_BID_WALL', reason: `NO_TRADE: Order book heavily skewed to buyers (OBI +${(obi * 100).toFixed(1)}%).` };
  }
  const aligned = (direction === 'LONG' && obi > 0.15) || (direction === 'SHORT' && obi < -0.15);
  return { ok: true, scoreBonus: aligned ? 6 : 0, obi, reason: null };
}

// #4 BTC Dominance (BTC.D) Filter (Cached 15m via CoinGecko Global)
async function fetchBtcDominanceContext() {
  if (cachedBtcDom.ok && Date.now() - cachedBtcDom.fetchedAt < 15 * 60 * 1000) {
    return cachedBtcDom;
  }
  try {
    const r = await fetchWithTimeout('https://api.coingecko.com/api/v3/global', {
      headers: { 'Accept': 'application/json', 'User-Agent': 'BybitQuantBot/10.0' }
    }, 3000);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const dom = Number(j?.data?.market_cap_percentage?.btc || 0);
    const prevDom = cachedBtcDom.ok ? cachedBtcDom.dominance : dom;
    const delta = +(dom - prevDom).toFixed(3);
    cachedBtcDom = { ok: dom > 0, dominance: +dom.toFixed(2), delta, fetchedAt: Date.now() };
    return cachedBtcDom;
  } catch (e) {
    return { ...cachedBtcDom, error: e.message };
  }
}

function checkBtcDominanceFilter({ coin, direction, btcDom, btcTrend }) {
  if (!coin || coin === 'BTC' || !btcDom || !btcDom.ok) return { ok: true, reason: null };
  // If BTC.D is surging high (>60%) AND rising while BTC itself is bearish, altcoin LONGs suffer heavy bleed
  if (direction === 'LONG' && btcDom.dominance >= 62 && btcDom.delta > 0.25 && btcTrend === 'BEAR') {
    return {
      ok: false,
      errorCode: 'BTC_DOMINANCE_ALT_BLEED',
      reason: `NO_TRADE: BTC.D surging (${btcDom.dominance}%, +${btcDom.delta}%) while BTC is BEAR — blocking altcoin LONG.`
    };
  }
  return { ok: true, reason: null };
}

// #7 Chandelier Exit / Supertrend Trailing Distance Calculator
function calcChandelierTrail({ candles, atr, entryPrice, multiplier = 2.2 }) {
  const baseAtr = Number(atr || 0);
  if (baseAtr > 0) {
    return Math.max(baseAtr * multiplier, Number(entryPrice || 0) * 0.0035);
  }
  if (Array.isArray(candles) && candles.length >= 16) {
    const computedAtr = calcWilderATR(candles.map(c => c[2]), candles.map(c => c[3]), candles.map(c => c[4]), 14);
    if (computedAtr > 0) return Math.max(computedAtr * multiplier, Number(entryPrice || 0) * 0.0035);
  }
  return Number(entryPrice || 0) * 0.006;
}

// #14 Volatility Squeeze Breakout Mode (Bollinger Bands inside Keltner Channels)
function detectVolatilitySqueeze(candles, period = 20) {
  if (!Array.isArray(candles) || candles.length < period + 2) {
    return { inSqueeze: false, breakout: 'NONE', scoreBonus: 0 };
  }
  const slice = candles.slice(-period);
  const closes = slice.map(c => c[4]);
  const mean = closes.reduce((a, b) => a + b, 0) / period;
  const variance = closes.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / period;
  const std = Math.sqrt(variance);
  const bbUpper = mean + 2 * std;
  const bbLower = mean - 2 * std;

  const atr = calcWilderATR(candles.map(c => c[2]), candles.map(c => c[3]), candles.map(c => c[4]), 14);
  const kcUpper = mean + 1.5 * atr;
  const kcLower = mean - 1.5 * atr;

  const inSqueeze = bbUpper < kcUpper && bbLower > kcLower;
  const lastClose = closes[closes.length - 1];
  let breakout = 'NONE';
  if (lastClose > bbUpper) breakout = 'SQUEEZE_BREAKOUT_LONG';
  else if (lastClose < bbLower) breakout = 'SQUEEZE_BREAKOUT_SHORT';

  return {
    inSqueeze,
    breakout,
    scoreBonus: breakout !== 'NONE' ? 10 : 0
  };
}

// #15 Flash Crash / Spike Circuit Breaker (BTC 5m move >= 2.5%)
function detectFlashCrash(btc5mCandles, thresholdPct = 2.5) {
  if (!Array.isArray(btc5mCandles) || btc5mCandles.length < 2) {
    return { triggered: false, movePct: 0, reason: null };
  }
  const last = btc5mCandles[btc5mCandles.length - 1];
  const open = Number(last[1] || 0);
  const high = Number(last[2] || 0);
  const low = Number(last[3] || 0);
  const close = Number(last[4] || 0);
  if (open <= 0) return { triggered: false, movePct: 0, reason: null };

  const bodyMovePct = Math.abs((close - open) / open) * 100;
  const rangeMovePct = ((high - low) / open) * 100;
  const movePct = +Math.max(bodyMovePct, rangeMovePct).toFixed(2);

  if (movePct >= thresholdPct) {
    return {
      triggered: true,
      movePct,
      errorCode: 'FLASH_CRASH_CIRCUIT_BREAKER',
      reason: `CIRCUIT_BREAKER: BTC moved ${movePct}% in 5m (>=${thresholdPct}%). Auto-pausing new trades for 60m.`
    };
  }
  return { triggered: false, movePct, reason: null };
}

// #16 Self-Learning Coin Scoring from Historical Closed PnL
function evaluateSelfLearningCoin(symbol, recentClosed = []) {
  const sym = String(symbol || '').toUpperCase();
  const trades = (recentClosed || []).filter(t => String(t.symbol || '').toUpperCase() === sym);
  if (trades.length < 3) return { ok: true, scoreBonus: 0, note: 'Learning (insufficient sample)' };

  const wins = trades.filter(t => Number(t.closedPnl || 0) > 0).length;
  const netPnl = trades.reduce((acc, t) => acc + Number(t.closedPnl || 0), 0);
  const winRate = (wins / trades.length) * 100;

  if (trades.length >= 4 && winRate <= 25 && netPnl < 0) {
    return {
      ok: false,
      scoreBonus: -15,
      errorCode: 'SELF_LEARNING_AUTO_BLOCK',
      reason: `NO_TRADE: Self-Learning Engine auto-blocked ${sym} (WR ${winRate.toFixed(0)}%, Net $${netPnl.toFixed(2)}).`
    };
  }
  if (winRate >= 60 && netPnl > 0) {
    return { ok: true, scoreBonus: 8, note: `Top Performer (${winRate.toFixed(0)}% WR)` };
  }
  return { ok: true, scoreBonus: 0, note: `Neutral (${winRate.toFixed(0)}% WR)` };
}

// #17 Macro Economic Calendar Guard (FOMC, CPI, NFP ±30m blackout via env MACRO_BLACKOUT_WINDOWS)
function checkMacroCalendarGuard({ nowMs = Date.now(), windowMinutes = 30, rawWindows = null } = {}) {
  const envStr = rawWindows !== null ? String(rawWindows) : String(process.env.MACRO_BLACKOUT_WINDOWS || '');
  if (!envStr.trim()) return { ok: true, errorCode: null, reason: null };

  const halfWindowMs = windowMinutes * 60 * 1000;
  const items = envStr.split(',').map(s => s.trim()).filter(Boolean);
  for (const item of items) {
    const [labelOrTs, maybeTs] = item.includes('|') ? item.split('|') : ['MACRO_EVENT', item];
    const ts = Date.parse(maybeTs || labelOrTs);
    if (!Number.isFinite(ts)) continue;
    if (Math.abs(nowMs - ts) <= halfWindowMs) {
      return {
        ok: false,
        errorCode: 'MACRO_EVENT_BLACKOUT',
        reason: `NO_TRADE: Macro Economic Guard active (±${windowMinutes}m around ${labelOrTs.trim()}).`
      };
    }
  }
  return { ok: true, errorCode: null, reason: null };
}

// #18 Multi-Strategy Regime Switcher (Trend-Following vs Mean-Reversion)
function selectStrategyRegime({ adx, rsi, price, supportLevels = [], resistanceLevels = [], divergence = null, patternData = null }) {
  if (Number(adx || 0) >= 22) {
    return { regime: 'TREND_FOLLOWING', allowMeanReversion: false, mrDirection: null };
  }
  // Ranging market (ADX < 20): allow Mean-Reversion bounce only at strong S/R + extreme RSI or Divergence
  if (Number(adx || 0) <= 20 && Number(price || 0) > 0) {
    const nearSup = (supportLevels || []).some(s => Math.abs(price - s) / price <= 0.008);
    const nearRes = (resistanceLevels || []).some(r => Math.abs(r - price) / price <= 0.008);
    if (nearSup && (rsi <= 34 || divergence?.bias === 'LONG' || patternData?.bias === 'LONG')) {
      return { regime: 'MEAN_REVERSION', allowMeanReversion: true, mrDirection: 'LONG' };
    }
    if (nearRes && (rsi >= 66 || divergence?.bias === 'SHORT' || patternData?.bias === 'SHORT')) {
      return { regime: 'MEAN_REVERSION', allowMeanReversion: true, mrDirection: 'SHORT' };
    }
  }
  return { regime: 'CHOPPY_NO_TRADE', allowMeanReversion: false, mrDirection: null };
}


// v11.0 #5: High-Momentum Breakout Mode (Volume spike >= 2.0x breaking S/R with strong candle body)
function detectMomentumBreakout({ closedCandles = [], direction = 'LONG', volRatio = 1, supportLevels = [], resistanceLevels = [] } = {}) {
  if (!Array.isArray(closedCandles) || closedCandles.length < 5 || Number(volRatio || 0) < 2.0) {
    return { isBreakout: false, scoreBonus: 0, note: 'NONE' };
  }
  const last = closedCandles[closedCandles.length - 1];
  const open = Number(last[1] || 0);
  const high = Number(last[2] || 0);
  const low = Number(last[3] || 0);
  const close = Number(last[4] || 0);
  const range = Math.max(1e-8, high - low);
  const bodyRatio = Math.abs(close - open) / range;
  if (bodyRatio < 0.55) return { isBreakout: false, scoreBonus: 0, note: 'WEAK_BODY' };

  if (direction === 'LONG' && close > open) {
    const brokeRes = (resistanceLevels || []).some(r => open <= r * 1.002 && close > r * 1.001);
    const prevHigh = Math.max(...closedCandles.slice(-10, -1).map(c => Number(c[2] || 0)));
    if (brokeRes || close > prevHigh) {
      return { isBreakout: true, scoreBonus: 8, note: `BULL_BREAKOUT (Vol ${Number(volRatio).toFixed(1)}x)` };
    }
  }
  if (direction === 'SHORT' && close < open) {
    const brokeSup = (supportLevels || []).some(s => open >= s * 0.998 && close < s * 0.999);
    const prevLow = Math.min(...closedCandles.slice(-10, -1).map(c => Number(c[3] || 0)));
    if (brokeSup || close < prevLow) {
      return { isBreakout: true, scoreBonus: 8, note: `BEAR_BREAKOUT (Vol ${Number(volRatio).toFixed(1)}x)` };
    }
  }
  return { isBreakout: false, scoreBonus: 0, note: 'NONE' };
}

// v11.0 #6: Smart Funding Rate Farming Bonus (prefer coins paying funding in trade direction)
function evaluateFundingBonus({ direction = 'LONG', fundingRate = 0 } = {}) {
  const fr = Number(fundingRate || 0);
  if (direction === 'LONG' && fr <= -0.0001) {
    return { favorable: true, scoreBonus: 6, note: `FUNDING_PAYS_LONG (${(fr * 100).toFixed(4)}%)` };
  }
  if (direction === 'SHORT' && fr >= 0.0001) {
    return { favorable: true, scoreBonus: 6, note: `FUNDING_PAYS_SHORT (${(fr * 100).toFixed(4)}%)` };
  }
  return { favorable: false, scoreBonus: 0, note: 'NEUTRAL_FUNDING' };
}

// v11.0 #7: Auto-Reentry on Stop-Hunt Wick (detect recent SL wick-out followed by strong reversal close)
function detectStopHuntReentry({ symbol = '', direction = 'LONG', closedCandles = [], recentClosed = [] } = {}) {
  if (!symbol || !Array.isArray(closedCandles) || closedCandles.length < 3 || !Array.isArray(recentClosed)) {
    return { triggered: false, scoreBonus: 0, note: 'NONE' };
  }
  const now = Date.now();
  const targetSide = direction === 'LONG' ? 'Buy' : 'Sell';
  const recentLoss = recentClosed.find(t => {
    const symMatch = String(t.symbol || '').toUpperCase() === String(symbol).toUpperCase();
    const pnlLoss = Number(t.closedPnl || 0) < 0;
    const ageMs = now - Number(t.updatedTime || 0);
    const sideMatch = !t.side || String(t.side).toLowerCase() === targetSide.toLowerCase() || String(t.side).toUpperCase() === direction;
    return symMatch && pnlLoss && sideMatch && ageMs > 0 && ageMs <= 60 * 60 * 1000;
  });
  if (!recentLoss) return { triggered: false, scoreBonus: 0, note: 'NONE' };

  const last = closedCandles[closedCandles.length - 1];
  const open = Number(last[1] || 0);
  const high = Number(last[2] || 0);
  const low = Number(last[3] || 0);
  const close = Number(last[4] || 0);
  const body = Math.max(1e-8, Math.abs(close - open));
  const lowerWick = Math.min(open, close) - low;
  const upperWick = high - Math.max(open, close);

  if (direction === 'LONG' && close > open && lowerWick >= body * 1.4) {
    return { triggered: true, scoreBonus: 10, note: 'STOP_HUNT_BULL_REENTRY' };
  }
  if (direction === 'SHORT' && close < open && upperWick >= body * 1.4) {
    return { triggered: true, scoreBonus: 10, note: 'STOP_HUNT_BEAR_REENTRY' };
  }
  return { triggered: false, scoreBonus: 0, note: 'NONE' };
}

// v11.0 #10: Best-Hour Auto-Boost (scale size +10-12% during historically winning UTC hours or LDN/NY overlap)
function evaluateBestHourBoost(recentClosed = [], nowDate = new Date()) {
  const utcHour = nowDate.getUTCHours();
  const byHour = {};
  (Array.isArray(recentClosed) ? recentClosed : []).forEach(t => {
    const ts = Number(t.updatedTime || 0);
    if (!ts) return;
    const h = new Date(ts).getUTCHours();
    if (!byHour[h]) byHour[h] = { wins: 0, total: 0, netPnl: 0 };
    byHour[h].total += 1;
    const pnl = Number(t.closedPnl || 0);
    byHour[h].netPnl += pnl;
    if (pnl > 0) byHour[h].wins += 1;
  });

  const stat = byHour[utcHour];
  if (stat && stat.total >= 2) {
    const wr = stat.wins / stat.total;
    if (wr >= 0.60 && stat.netPnl > 0) {
      return { boosted: true, multiplier: 1.12, utcHour, reason: `BEST_HOUR_${utcHour}UTC (WR ${Math.round(wr * 100)}%)` };
    }
    return { boosted: false, multiplier: 1.0, utcHour, reason: 'STANDARD_HOUR' };
  }
  // Default prime liquidity window: London/NY Overlap (13:00 - 17:59 UTC)
  if (utcHour >= 13 && utcHour <= 17) {
    return { boosted: true, multiplier: 1.10, utcHour, reason: 'LDN_NY_PRIME_HOUR' };
  }
  return { boosted: false, multiplier: 1.0, utcHour, reason: 'STANDARD_HOUR' };
}

module.exports = {
  calcVWAP,
  checkVwapFilter,
  calcMACD,
  detectDivergence,
  evaluateOrderBookImbalance,
  fetchBtcDominanceContext,
  checkBtcDominanceFilter,
  calcChandelierTrail,
  detectVolatilitySqueeze,
  detectFlashCrash,
  evaluateSelfLearningCoin,
  checkMacroCalendarGuard,
  selectStrategyRegime,
  detectMomentumBreakout,
  evaluateFundingBonus,
  detectStopHuntReentry,
  evaluateBestHourBoost
};
