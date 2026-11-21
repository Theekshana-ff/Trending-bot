// Module 23: v9.0 Advanced Safety Guards & Analytics
// #3 Session/Weekend Filter, #4 Liquidation Distance Guard, #5 Correlation Guard, #9 Funding Countdown Guard, #10 Coin Analytics

const ALT_CORR_GROUPS = {
  L1_ALTS: new Set(['SOL', 'SUI', 'AVAX', 'NEAR', 'APT', 'ADA', 'INJ', 'TRX']),
  L2_DEFI: new Set(['OP', 'ARB', 'LINK', 'RENDER']),
  MEME_BETA: new Set(['DOGE', 'XRP'])
};

// #3 Trading Session & Weekend Filter (UTC)
function checkTradingSession({ nowMs = Date.now(), blockWeekend = false, sessionOnly = false } = {}) {
  const d = new Date(nowMs);
  const day = d.getUTCDay(); // 0 = Sun, 6 = Sat
  const hour = d.getUTCHours();

  if (blockWeekend && (day === 0 || day === 6)) {
    return { ok: false, errorCode: 'WEEKEND_FILTER', reason: 'NO_TRADE: Weekend trading filter is active (Sat/Sun UTC).' };
  }
  // London (07-16 UTC) + New York (12-21 UTC) => High-volume window: 07:00 - 21:00 UTC
  if (sessionOnly && (hour < 7 || hour >= 21)) {
    return { ok: false, errorCode: 'OFF_SESSION_FILTER', reason: `NO_TRADE: Off-session UTC hour (${hour}:00). Active window: 07:00-21:00 UTC (London/NY).` };
  }
  return { ok: true, errorCode: null, session: (hour >= 7 && hour < 21) ? 'LONDON_NY_ACTIVE' : 'ASIA_LOW_VOL' };
}

// #4 Liquidation Distance Safety Guard (for 5x-20x Leverage)
function checkLiquidationSafety({ entryPrice, slPrice, leverage, direction, safetyBufferPct = 0.005 }) {
  const entry = Number(entryPrice);
  const sl = Number(slPrice);
  const lev = Math.max(1, Number(leverage || 5));
  if (!Number.isFinite(entry) || !Number.isFinite(sl) || entry <= 0) {
    return { ok: false, errorCode: 'INVALID_LIQ_INPUT', reason: 'NO_TRADE: Invalid entry/SL for liquidation check.' };
  }
  // Approximate Isolated Liquidation distance (~ (1 / lev) - 0.5% maintenance margin)
  const maintMargin = 0.005;
  const liqDistPct = Math.max(0.01, (1 / lev) - maintMargin);
  const estLiqPrice = direction === 'LONG' ? entry * (1 - liqDistPct) : entry * (1 + liqDistPct);
  const slDistPct = Math.abs(entry - sl) / entry;

  if (slDistPct >= (liqDistPct - safetyBufferPct)) {
    return {
      ok: false,
      errorCode: 'SL_BEYOND_LIQUIDATION',
      estLiqPrice: +estLiqPrice.toPrecision(6),
      reason: `NO_TRADE: SL (${(slDistPct * 100).toFixed(2)}%) is too close to or beyond ${lev}x Est. Liquidation (${(liqDistPct * 100).toFixed(2)}%).`
    };
  }
  return { ok: true, errorCode: null, estLiqPrice: +estLiqPrice.toPrecision(6) };
}

// #5 Correlation Guard (max 2 same-direction positions in same altcoin correlation group)
function checkCorrelationGuard({ symbol, direction, openPositions = [], maxSameGroup = 2 }) {
  const base = String(symbol || '').toUpperCase().replace(/USDT$/, '');
  const targetSide = direction === 'LONG' ? 'Buy' : 'Sell';

  let groupName = null;
  for (const [g, set] of Object.entries(ALT_CORR_GROUPS)) {
    if (set.has(base)) { groupName = g; break; }
  }
  if (!groupName) return { ok: true, errorCode: null };

  const groupSet = ALT_CORR_GROUPS[groupName];
  const sameDirCount = (openPositions || []).filter(p => {
    const pBase = String(p.symbol || '').toUpperCase().replace(/USDT$/, '');
    return groupSet.has(pBase) && p.side === targetSide;
  }).length;

  if (sameDirCount >= maxSameGroup) {
    return {
      ok: false,
      errorCode: 'CORRELATION_LIMIT',
      reason: `NO_TRADE: Correlation Guard (${groupName}) already has ${sameDirCount} ${direction} positions open.`
    };
  }
  return { ok: true, errorCode: null };
}

// #9 Funding Rate Countdown Guard (blocks high adverse funding within 15m of 00:00/08:00/16:00 UTC)
function checkFundingCountdownGuard({ direction, fundingRate = 0, nowMs = Date.now(), windowMinutes = 15 }) {
  const fr = Number(fundingRate || 0);
  const d = new Date(nowMs);
  const minsSinceDayStart = d.getUTCHours() * 60 + d.getUTCMinutes();
  const minsToNextFunding = 480 - (minsSinceDayStart % 480);

  const adverseFunding = (direction === 'LONG' && fr >= 0.0003) || (direction === 'SHORT' && fr <= -0.0003);
  if (adverseFunding && minsToNextFunding <= windowMinutes) {
    return {
      ok: false,
      errorCode: 'FUNDING_COUNTDOWN_BLOCK',
      minsToNextFunding,
      reason: `NO_TRADE: High adverse funding (${(fr * 100).toFixed(3)}%) settles in ${minsToNextFunding}m.`
    };
  }
  return { ok: true, errorCode: null, minsToNextFunding };
}

// #10 Per-Coin Analytics from Bybit Closed PnL
function computeCoinAnalytics(recentClosed = []) {
  const map = {};
  for (const t of recentClosed || []) {
    const sym = String(t.symbol || 'UNKNOWN');
    const pnl = Number(t.closedPnl || 0);
    if (!map[sym]) map[sym] = { symbol: sym, trades: 0, wins: 0, losses: 0, netPnl: 0 };
    map[sym].trades++;
    if (pnl > 0) map[sym].wins++;
    else if (pnl < 0) map[sym].losses++;
    map[sym].netPnl = +(map[sym].netPnl + pnl).toFixed(4);
  }
  return Object.values(map)
    .map(c => ({ ...c, winRate: c.trades > 0 ? +((c.wins / c.trades) * 100).toFixed(1) : 0 }))
    .sort((a, b) => b.netPnl - a.netPnl);
}

module.exports = {
  checkTradingSession,
  checkLiquidationSafety,
  checkCorrelationGuard,
  checkFundingCountdownGuard,
  computeCoinAnalytics
};
