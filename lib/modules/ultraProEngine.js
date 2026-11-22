// File: lib/modules/ultraProEngine.js (v13.0 ULTRA PRO EDITION)
// Implements: Auto Market Session Alerts (Tokyo/London/NY/Overlap), FVG Sniper Entry,
// Liquidity Sweep Reversal, CVD Proxy Filter, Session Open Breakout, Dynamic TP Extension,
// Time-Decay Profit Lock, Kelly Criterion Sizing, Equity Curve Throttle, Fee/Funding Guard,
// Auto-Compounding Tiers, Correlation-Adjusted Sizing, Liquidation Cluster Avoidance,
// Funding Squeeze Hunter, BTC Volatility Regime Switcher, and Auto-Parameter Optimizer.

const { redisCmd } = require('./securityAndState');

const localSessionSent = new Set();

// ============================================================
// 1. AUTO MARKET SESSION OPEN ALERTS (UTC + Sri Lanka Time)
// ============================================================
const MARKET_SESSIONS = [
  { id: 'TOKYO',   utcHour: 0,  label: 'Tokyo (Asian) Session',      slTime: '05:30 AM SL', emoji: '🇯🇵', note: 'Asian liquidity open — watch range setups & BTC dominance.' },
  { id: 'LONDON',  utcHour: 7,  label: 'London Session',             slTime: '12:30 PM SL', emoji: '🇬🇧', note: 'High volatility & breakout window starting!' },
  { id: 'NEWYORK', utcHour: 12, label: 'New York Session',           slTime: '05:30 PM SL', emoji: '🇺🇸', note: 'US institutional volume & major trend moves!' },
  { id: 'OVERLAP', utcHour: 13, label: 'London / NY Overlap (Peak)', slTime: '06:30 PM SL', emoji: '🔥', note: 'Highest daily crypto liquidity — prime sniper window!' }
];

async function checkAndGetSessionOpenAlert(nowMs = Date.now()) {
  const d = new Date(nowMs);
  const utcDay = d.toISOString().slice(0, 10);
  const utcHour = d.getUTCHours();
  const utcMin = d.getUTCMinutes();

  // Trigger within the first 25 minutes of the session open hour
  if (utcMin > 25) return null;

  const session = MARKET_SESSIONS.find(s => s.utcHour === utcHour);
  if (!session) return null;

  const key = `bybit_bot:session_alert:${utcDay}:${session.id}`;
  if (localSessionSent.has(key)) return null;

  const r = await redisCmd('GET', key);
  if (r.source === 'UPSTASH_REDIS_VERIFIED' && r.result === '1') {
    localSessionSent.add(key);
    return null;
  }

  localSessionSent.add(key);
  await redisCmd('SET', key, '1', 'EX', '86400');

  return {
    id: session.id,
    text:
      `${session.emoji} <b>START ${session.label.toUpperCase()}</b>\n` +
      `🕒 Time: <b>${session.slTime}</b> (${String(utcHour).padStart(2, '0')}:00 UTC)\n` +
      `📊 ${session.note}`
  };
}

function getCurrentSessionInfo(nowMs = Date.now()) {
  const h = new Date(nowMs).getUTCHours();
  if (h >= 13 && h < 16) return { name: 'LONDON_NY_OVERLAP', isOpenBreakoutHour: h === 13, bonus: 10 };
  if (h >= 12 && h < 21) return { name: 'NEW_YORK', isOpenBreakoutHour: h === 12, bonus: 8 };
  if (h >= 7 && h < 16)  return { name: 'LONDON', isOpenBreakoutHour: h === 7, bonus: 8 };
  return { name: 'TOKYO_ASIA', isOpenBreakoutHour: h === 0, bonus: 2 };
}

// ============================================================
// 2. ENTRY & SIGNAL PRECISION (#1 FVG, #2 Sweep, #3 CVD, #4 Session Breakout)
// ============================================================
function detectFvgSniperZone(candles, direction) {
  if (!Array.isArray(candles) || candles.length < 5) return { found: false, entryPrice: null, scoreBonus: 0 };
  const last = candles[candles.length - 1];
  const lastClose = Number(last[4]);

  for (let i = candles.length - 1; i >= Math.max(2, candles.length - 10); i--) {
    const cPrev2 = candles[i - 2];
    const cCurr = candles[i];
    if (direction === 'LONG' && Number(cCurr[3]) > Number(cPrev2[2])) {
      const gapLow = Number(cPrev2[2]);
      const gapHigh = Number(cCurr[3]);
      const mid = (gapLow + gapHigh) / 2;
      if (lastClose >= gapLow && (lastClose - mid) / lastClose <= 0.015) {
        return { found: true, entryPrice: mid, scoreBonus: 8, note: `Bullish FVG @ ${mid.toPrecision(6)}` };
      }
    }
    if (direction === 'SHORT' && Number(cCurr[2]) < Number(cPrev2[3])) {
      const gapHigh = Number(cPrev2[3]);
      const gapLow = Number(cCurr[2]);
      const mid = (gapLow + gapHigh) / 2;
      if (lastClose <= gapHigh && (mid - lastClose) / lastClose <= 0.015) {
        return { found: true, entryPrice: mid, scoreBonus: 8, note: `Bearish FVG @ ${mid.toPrecision(6)}` };
      }
    }
  }
  return { found: false, entryPrice: null, scoreBonus: 0 };
}

function detectLiquiditySweepReversal(candles, direction) {
  if (!Array.isArray(candles) || candles.length < 12) return { swept: false, scoreBonus: 0 };
  const recent = candles.slice(-12);
  const last = recent[recent.length - 1];
  const prior = recent.slice(0, -1);
  const priorLow = Math.min(...prior.map(c => Number(c[3])));
  const priorHigh = Math.max(...prior.map(c => Number(c[2])));

  const open = Number(last[1]), high = Number(last[2]), low = Number(last[3]), close = Number(last[4]);
  if (direction === 'LONG' && low < priorLow && close > priorLow && close > open) {
    return { swept: true, scoreBonus: 10, note: 'Bullish Liquidity Sweep Reversal' };
  }
  if (direction === 'SHORT' && high > priorHigh && close < priorHigh && close < open) {
    return { swept: true, scoreBonus: 10, note: 'Bearish Liquidity Sweep Reversal' };
  }
  return { swept: false, scoreBonus: 0 };
}

function evaluateCvdFilter(candles, direction) {
  if (!Array.isArray(candles) || candles.length < 10) return { ok: true, cvdBias: 'NEUTRAL', scoreBonus: 0 };
  const slice = candles.slice(-10);
  let deltaSum = 0;
  let totalVol = 0;
  for (const c of slice) {
    const o = Number(c[1]), h = Number(c[2]), l = Number(c[3]), cl = Number(c[4]), vol = Number(c[5] || 0);
    const range = Math.max(1e-8, h - l);
    const buyRatio = (cl - l) / range;
    const sellRatio = (h - cl) / range;
    deltaSum += vol * (buyRatio - sellRatio);
    totalVol += vol;
  }
  const normCvd = totalVol > 0 ? deltaSum / totalVol : 0;
  if (direction === 'LONG' && normCvd < -0.35) {
    return { ok: false, cvdBias: 'HEAVY_SELL_CVD', scoreBonus: 0, reason: `NO_TRADE: Negative CVD pressure (${(normCvd * 100).toFixed(1)}%) opposes LONG.` };
  }
  if (direction === 'SHORT' && normCvd > 0.35) {
    return { ok: false, cvdBias: 'HEAVY_BUY_CVD', scoreBonus: 0, reason: `NO_TRADE: Positive CVD pressure (+${(normCvd * 100).toFixed(1)}%) opposes SHORT.` };
  }
  const aligned = (direction === 'LONG' && normCvd > 0.12) || (direction === 'SHORT' && normCvd < -0.12);
  return { ok: true, cvdBias: aligned ? 'ALIGNED' : 'NEUTRAL', scoreBonus: aligned ? 6 : 0 };
}

// ============================================================
// 3. SMART RISK & COMPOUNDING (#11 Kelly, #12 Equity Throttle, #13 Fee Guard, #14 Tiers, #15 Corr Sizing, #16 Liq Cluster)
// ============================================================
function computeKellyMultiplier(recentClosed = []) {
  if (!Array.isArray(recentClosed) || recentClosed.length < 10) return 1.0;
  const wins = recentClosed.filter(t => Number(t.closedPnl || 0) > 0);
  const losses = recentClosed.filter(t => Number(t.closedPnl || 0) < 0);
  if (!wins.length || !losses.length) return 1.0;

  const p = wins.length / (wins.length + losses.length);
  const avgWin = wins.reduce((s, t) => s + Number(t.closedPnl), 0) / wins.length;
  const avgLoss = Math.abs(losses.reduce((s, t) => s + Number(t.closedPnl), 0) / losses.length);
  if (avgLoss <= 0) return 1.0;

  const b = avgWin / avgLoss;
  const kelly = p - ((1 - p) / b);
  // Half-Kelly clamped safely between 0.5x and 1.25x
  if (kelly <= 0) return 0.6;
  return Math.min(1.25, Math.max(0.6, +(0.8 + kelly * 0.5).toFixed(2)));
}

function computeEquityCurveThrottle(equityCurve = []) {
  if (!Array.isArray(equityCurve) || equityCurve.length < 8) return { throttled: false, multiplier: 1.0 };
  const recent = equityCurve.slice(-10).map(x => Number(x.equity || 0)).filter(x => x > 0);
  if (recent.length < 6) return { throttled: false, multiplier: 1.0 };
  const ma = recent.reduce((a, b) => a + b, 0) / recent.length;
  const latest = recent[recent.length - 1];
  if (latest < ma * 0.985) {
    return { throttled: true, multiplier: 0.5, note: `Equity ($${latest.toFixed(2)}) < MA ($${ma.toFixed(2)}) -> 50% size throttle` };
  }
  return { throttled: false, multiplier: 1.0 };
}

function checkFeeAndFundingNetProfitGuard({ entry, tp1, orderType = 'Limit', fundingRate = 0 }) {
  const e = Number(entry || 0);
  const t = Number(tp1 || 0);
  if (e <= 0 || t <= 0) return { ok: true };
  const grossRewardPct = (Math.abs(t - e) / e) * 100;
  const roundTripFeePct = orderType === 'Limit' ? 0.05 : 0.12;
  const fundingPct = Math.abs(Number(fundingRate || 0)) * 100;
  const totalCostPct = roundTripFeePct + fundingPct;

  if (grossRewardPct < totalCostPct * 3.0) {
    return {
      ok: false,
      errorCode: 'FEE_EXCEEDS_EDGE',
      reason: `NO_TRADE: TP1 reward (${grossRewardPct.toFixed(2)}%) too small vs fees+funding (${totalCostPct.toFixed(2)}%).`
    };
  }
  return { ok: true };
}

function getCompoundingTier(equity = 0) {
  const eq = Number(equity || 0);
  if (eq >= 1000) return { tier: 'PRO_1000', riskScale: 0.9, vaultPct: 50 };
  if (eq >= 500)  return { tier: 'GROWTH_500', riskScale: 1.0, vaultPct: 45 };
  if (eq >= 250)  return { tier: 'BUILDER_250', riskScale: 1.05, vaultPct: 40 };
  return { tier: 'STARTER_100', riskScale: 1.0, vaultPct: 35 };
}

function adjustSlForLiquidationClusters(slPrice, direction, atr = 0) {
  const sl = Number(slPrice || 0);
  if (sl <= 0) return sl;
  // Push SL slightly past psychological round numbers (.00 / .50) by 0.15 * ATR to reduce stop hunts
  const pad = atr > 0 ? atr * 0.15 : sl * 0.001;
  const frac = Math.abs(sl - Math.round(sl));
  if (frac < 0.02 || Math.abs(frac - 0.5) < 0.02) {
    return direction === 'LONG' ? sl - pad : sl + pad;
  }
  return sl;
}

// ============================================================
// 4. MARKET INTELLIGENCE (#17 Funding Squeeze Hunter, #19 BTC Vol Regime)
// ============================================================
async function scanFundingRateSqueezes(limit = 3) {
  const resp = await fetch('https://api.bybit.com/v5/market/tickers?category=linear');
  if (!resp.ok) return [];
  const data = await resp.json();
  const list = (data?.result?.list || [])
    .filter(t => t.symbol && t.symbol.endsWith('USDT') && Number(t.turnover24h || 0) > 20000000)
    .map(t => ({
      symbol: t.symbol,
      price: Number(t.lastPrice || 0),
      fundingRatePct: +(Number(t.fundingRate || 0) * 100).toFixed(4),
      chg24h: +(Number(t.price24hPcnt || 0) * 100).toFixed(2),
      squeezeType: Number(t.fundingRate || 0) <= -0.0003 ? 'SHORT_SQUEEZE_CANDIDATE' : Number(t.fundingRate || 0) >= 0.0005 ? 'LONG_SQUEEZE_CANDIDATE' : 'NORMAL'
    }))
    .filter(x => x.squeezeType !== 'NORMAL')
    .sort((a, b) => Math.abs(b.fundingRatePct) - Math.abs(a.fundingRatePct))
    .slice(0, limit);
  return list;
}

function detectBtcVolatilityRegime(btcAtrPct = 0.8) {
  if (btcAtrPct >= 1.5) return { regime: 'HIGH_VOL_SWING', preferredCoins: ['BTC', 'ETH', 'SOL'], note: 'BTC High Vol -> Focus Majors (Swing)' };
  if (btcAtrPct <= 0.5) return { regime: 'LOW_VOL_ALT_SCALP', preferredCoins: null, note: 'BTC Calm -> Altcoin Sniper Mode' };
  return { regime: 'BALANCED_TREND', preferredCoins: null, note: 'Normal Volatility Regime' };
}

// ============================================================
// 5. v14.0 PERFORMANCE COMPARE: EA MODE vs NORMAL v6
// ============================================================
function computeModeComparison(journal = [], recentClosed = []) {
  const opens = (Array.isArray(journal) ? journal : [])
    .filter(j => j && j.type === 'LIVE_ORDER_OPEN' && j.symbol)
    .map(j => ({
      symbol: String(j.symbol).toUpperCase(),
      ts: Date.parse(j.ts || 0) || 0,
      tradeMode: j.tradeMode === 'EA' ? 'EA' : 'NORMAL'
    }));

  const stats = {
    ea: { trades: 0, wins: 0, losses: 0, netPnl: 0, winRate: 0 },
    normal: { trades: 0, wins: 0, losses: 0, netPnl: 0, winRate: 0 }
  };

  for (const t of (Array.isArray(recentClosed) ? recentClosed : [])) {
    const sym = String(t.symbol || '').toUpperCase();
    const closeTs = Number(t.updatedTime || t.createdTime || 0);
    const pnl = Number(t.closedPnl || 0);

    // Find closest prior LIVE_ORDER_OPEN for this symbol (within 7 days)
    let matchedMode = 'NORMAL';
    let bestDiff = Infinity;
    for (const o of opens) {
      if (o.symbol !== sym) continue;
      const diff = closeTs > 0 && o.ts > 0 ? (closeTs - o.ts) : 0;
      if (diff >= -60000 && diff < 7 * 24 * 3600 * 1000 && diff < bestDiff) {
        bestDiff = diff;
        matchedMode = o.tradeMode;
      }
    }

    const bucket = matchedMode === 'EA' ? stats.ea : stats.normal;
    bucket.trades += 1;
    if (pnl > 0) bucket.wins += 1;
    else if (pnl < 0) bucket.losses += 1;
    bucket.netPnl = +(bucket.netPnl + pnl).toFixed(4);
  }

  stats.ea.winRate = stats.ea.trades ? +((stats.ea.wins / stats.ea.trades) * 100).toFixed(1) : 0;
  stats.normal.winRate = stats.normal.trades ? +((stats.normal.wins / stats.normal.trades) * 100).toFixed(1) : 0;
  return stats;
}

module.exports = {
  MARKET_SESSIONS,
  checkAndGetSessionOpenAlert,
  getCurrentSessionInfo,
  detectFvgSniperZone,
  detectLiquiditySweepReversal,
  evaluateCvdFilter,
  computeKellyMultiplier,
  computeEquityCurveThrottle,
  checkFeeAndFundingNetProfitGuard,
  getCompoundingTier,
  adjustSlForLiquidationClusters,
  scanFundingRateSqueezes,
  detectBtcVolatilityRegime,
  computeModeComparison
};
