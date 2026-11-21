// Modules 11, 12, 13: Pullback/Limit Entry, OI/Funding Squeeze Guard, Auto Leverage & Live Risk Manager (v6)

function getDecimalsFromStep(stepVal) {
  const s = String(stepVal || '0.01');
  if (s.includes('e-')) return Number(s.split('e-')[1]) || 4;
  if (!s.includes('.')) return 0;
  return s.split('.')[1].replace(/0+$/, '').length;
}

function formatBybitPrice(rawPrice, tickSize = 0.01) {
  const tick = Number(tickSize) > 0 ? Number(tickSize) : 0.01;
  const dec = getDecimalsFromStep(tick);
  return Number((Math.round(Number(rawPrice) / tick) * tick).toFixed(dec));
}

function formatBybitQty(rawQty, qtyStep = 0.01) {
  const step = Number(qtyStep) > 0 ? Number(qtyStep) : 0.01;
  const dec = getDecimalsFromStep(step);
  return Number((Math.floor((Number(rawQty) + 1e-12) / step) * step).toFixed(dec));
}

function computeAutoLeverage({ atrPct = 0.8, signalQualityScore = 70, maxLeverage = 20 }) {
  const cap = Math.min(20, Math.max(1, Number(maxLeverage || 20)));
  const floor = Math.min(cap, 5);
  let lev = 5;
  if (atrPct > 1.5) lev = 5;
  else if (atrPct > 1.1) lev = signalQualityScore >= 80 ? 8 : 6;
  else if (atrPct > 0.7) lev = signalQualityScore >= 80 ? 12 : 9;
  else if (atrPct > 0.4) lev = signalQualityScore >= 80 ? 16 : 13;
  else lev = signalQualityScore >= 80 ? 20 : 17;
  return Math.min(cap, Math.max(floor, lev));
}

// v6 Update #10: Open Interest & Funding Rate Squeeze Filter
function checkOiFundingSqueeze({ direction, fundingRate = 0, oiChangePct = 0 }) {
  const fr = Number(fundingRate || 0);
  const oi = Number(oiChangePct || 0);
  if (direction === 'LONG' && fr > 0.0005 && oi > 3.0) {
    return { ok: false, errorCode: 'LONG_SQUEEZE_RISK', reason: `NO_TRADE: Crowded LONG squeeze risk (Funding ${(fr * 100).toFixed(3)}%, OI +${oi}%).` };
  }
  if (direction === 'SHORT' && fr < -0.0005 && oi > 3.0) {
    return { ok: false, errorCode: 'SHORT_SQUEEZE_RISK', reason: `NO_TRADE: Crowded SHORT squeeze risk (Funding ${(fr * 100).toFixed(3)}%, OI +${oi}%).` };
  }
  return { ok: true, errorCode: null };
}

function validateSlTpLevels({ direction, entry, sl, tp1, tp }) {
  const vals = [entry, sl, tp1, tp];
  if (!['LONG', 'SHORT'].includes(direction)) {
    return { valid: false, errorCode: 'INVALID_DIRECTION', reason: `Direction must be LONG or SHORT, got ${direction}` };
  }
  if (!vals.every(v => typeof v === 'number' && Number.isFinite(v) && v > 0)) {
    return { valid: false, errorCode: 'INVALID_LEVEL_NUMBERS', reason: 'Entry, SL, TP1, or TP contains missing/NaN/non-positive value.' };
  }
  if (direction === 'LONG') {
    if (!(sl < entry && entry < tp1 && tp1 <= tp)) {
      return { valid: false, errorCode: 'INVERTED_LONG_SL_TP', reason: `Invalid LONG bounds: SL(${sl}) < Entry(${entry}) < TP1(${tp1}) <= TP(${tp})` };
    }
  } else {
    if (!(sl > entry && entry > tp1 && tp1 >= tp)) {
      return { valid: false, errorCode: 'INVERTED_SHORT_SL_TP', reason: `Invalid SHORT bounds: SL(${sl}) > Entry(${entry}) > TP1(${tp1}) >= TP(${tp})` };
    }
  }
  const riskDist = Math.abs(entry - sl);
  const rewardDist = Math.abs(tp1 - entry);
  if (riskDist / entry < 0.0015) {
    return { valid: false, errorCode: 'SL_TOO_TIGHT', reason: 'SL distance is tighter than 0.15% (liquidation/whipsaw risk).' };
  }
  if (rewardDist / riskDist < 1.15) {
    return { valid: false, errorCode: 'POOR_RR', reason: `TP1 R:R too low (${(rewardDist / riskDist).toFixed(2)}).` };
  }
  return { valid: true, errorCode: null };
}

// v6 Update #1: Supports Pullback Limit Entry (EMA20 / OB / Fib) or Market Entry
function computeAndValidateEntry({
  closedCandles, livePrice, direction, tickSize, atr, spreadPct,
  fundingRate = 0, entryMode = 'limit_pullback', ema20 = 0, orderBlock = null, fib = null,
  supportLevels = [], resistanceLevels = [], bestBid = 0, bestAsk = 0, multiCandleConfirm = false
}) {
  if (!Array.isArray(closedCandles) || closedCandles.length < 20) {
    return { valid: false, errorCode: 'INSUFFICIENT_CANDLES', reason: 'NO_TRADE: Insufficient closed candles.' };
  }
  if (!Number.isFinite(livePrice) || livePrice <= 0 || !Number.isFinite(atr) || atr <= 0) {
    return { valid: false, errorCode: 'INVALID_PRICE_OR_ATR', reason: 'NO_TRADE: Invalid live price or ATR.' };
  }
  if (Number(spreadPct) > 0.25) {
    return { valid: false, errorCode: 'SPREAD_TOO_WIDE', reason: `NO_TRADE: Spread ${spreadPct}% exceeds 0.25% max cap.` };
  }

  const last = closedCandles[closedCandles.length - 1];
  const prev = closedCandles[closedCandles.length - 2];
  const prev2 = closedCandles[closedCandles.length - 3] || prev;
  const isLong = direction === 'LONG';
  const bar1Ok = isLong ? (last[4] > last[1] && last[4] >= prev[4]) : (last[4] < last[1] && last[4] <= prev[4]);
  // v10.0 #5: Optional 2-Bar Close Confirmation
  const bar2Ok = !multiCandleConfirm || (isLong ? (prev[4] >= prev2[4]) : (prev[4] <= prev2[4]));
  const momentumOk = bar1Ok && bar2Ok;

  if (!momentumOk) {
    return { valid: false, errorCode: 'NO_CANDLE_CONFIRMATION', reason: `NO_TRADE: Latest closed candle did not confirm ${direction} momentum.` };
  }

  let rawEntry = livePrice;
  let orderType = 'Market';

  if (entryMode === 'limit_pullback') {
    orderType = 'Limit';
    const maxPullback = Math.min(atr * 0.45, livePrice * 0.004);
    const defaultLimit = isLong ? livePrice - Math.max(livePrice * 0.0012, maxPullback * 0.5) : livePrice + Math.max(livePrice * 0.0012, maxPullback * 0.5);

    // Prefer EMA20 or Order Block or Fib 0.5 if within reasonable pullback range
    const candidates = [defaultLimit];
    if (ema20 > 0) {
      if (isLong && ema20 < livePrice && (livePrice - ema20) <= atr * 0.8) candidates.push(ema20);
      if (!isLong && ema20 > livePrice && (ema20 - livePrice) <= atr * 0.8) candidates.push(ema20);
    }
    if (orderBlock) {
      if (isLong && orderBlock.type === 'BULL_OB' && orderBlock.high < livePrice && (livePrice - orderBlock.high) <= atr) candidates.push(orderBlock.high);
      if (!isLong && orderBlock.type === 'BEAR_OB' && orderBlock.low > livePrice && (orderBlock.low - livePrice) <= atr) candidates.push(orderBlock.low);
    }
    if (fib && fib.fib500 > 0) {
      if (isLong && fib.fib500 < livePrice && (livePrice - fib.fib500) <= atr * 0.8) candidates.push(fib.fib500);
      if (!isLong && fib.fib500 > livePrice && (fib.fib500 - livePrice) <= atr * 0.8) candidates.push(fib.fib500);
    }
    rawEntry = isLong ? Math.max(...candidates) : Math.min(...candidates);
  }

  // v10.0 #9: Maker-Only Rebate Optimization (1 tick passive inside best bid/ask)
  const tick = Number(tickSize) > 0 ? Number(tickSize) : 0.01;
  if (orderType === 'Limit') {
    if (isLong && bestBid > 0 && rawEntry >= bestBid) rawEntry = bestBid - tick;
    if (!isLong && bestAsk > 0 && rawEntry <= bestAsk) rawEntry = bestAsk + tick;
  }
  const entry = formatBybitPrice(rawEntry, tickSize);
  const sign = isLong ? 1 : -1;
  const recentLows = closedCandles.slice(-12).map(c => c[3]);
  const recentHighs = closedCandles.slice(-12).map(c => c[2]);
  // v10.0 #12: Smart SL Hunt Protection (ATR x 0.35 wick buffer outside recent swings)
  const swingInv = isLong ? Math.min(...recentLows) - atr * 0.35 : Math.max(...recentHighs) + atr * 0.35;

  const feePct = orderType === 'Limit' ? 0.04 : 0.11;
  const fundingPenaltyPct = Math.abs(Number(fundingRate || 0)) * 100;
  const cost = entry * ((feePct + Number(spreadPct || 0.02) + fundingPenaltyPct) / 100);
  const riskDist = Math.max(atr * 1.30, Math.abs(entry - swingInv)) + cost;

  const sl = formatBybitPrice(entry - sign * riskDist, tickSize);
  let rawTp1 = entry + sign * (riskDist * 1.5 + cost);
  let rawTp2 = entry + sign * (riskDist * 3.0 + cost);

  // v10.0 #8: Dynamic R:R Targeting — snap TP1/TP2 to nearby Liquidity Pool (S/R) if R:R >= 1.25
  if (isLong && Array.isArray(resistanceLevels) && resistanceLevels.length) {
    const validRes = resistanceLevels.filter(r => r > entry + riskDist * 1.25).sort((a, b) => a - b);
    if (validRes[0] && validRes[0] < rawTp1 * 1.15) rawTp1 = validRes[0] * 0.999;
    if (validRes[1] && validRes[1] > rawTp1) rawTp2 = validRes[1] * 0.999;
  } else if (!isLong && Array.isArray(supportLevels) && supportLevels.length) {
    const validSup = supportLevels.filter(s => s < entry - riskDist * 1.25).sort((a, b) => b - a);
    if (validSup[0] && validSup[0] > rawTp1 * 0.85) rawTp1 = validSup[0] * 1.001;
    if (validSup[1] && validSup[1] < rawTp1) rawTp2 = validSup[1] * 1.001;
  }

  const tp1 = formatBybitPrice(rawTp1, tickSize);
  const tp2 = formatBybitPrice(rawTp2, tickSize);
  const tp3 = formatBybitPrice(entry + sign * (riskDist * 5.0 + cost), tickSize);
  const tp4 = formatBybitPrice(entry + sign * (riskDist * 8.0 + cost), tickSize);

  const slTpCheck = validateSlTpLevels({ direction, entry, sl, tp1, tp: tp4 });
  if (!slTpCheck.valid) return { valid: false, errorCode: slTpCheck.errorCode, reason: `NO_TRADE: ${slTpCheck.reason}` };

  const rrRatio = +((Math.abs(tp2 - entry) - cost) / Math.max(1e-8, riskDist)).toFixed(2);
  return { valid: true, orderType, entry, sl, tp1, tp2, tp3, tp4, tp: tp4, rrRatio, estimatedCost: +cost.toFixed(6) };
}


// v10.0.3 #8: Coin-Specific Risk Profiles (auto-cap leverage by volatility tier)
const MAJOR_COINS = new Set(['BTC', 'ETH']);
const LARGE_ALT_COINS = new Set(['SOL', 'BNB', 'XRP', 'LINK', 'AVAX', 'LTC', 'ADA']);

function getCoinRiskProfile(symbol = '') {
  const coin = String(symbol || '').toUpperCase().replace(/USDT$/, '');
  if (MAJOR_COINS.has(coin)) return { tier: 'MAJOR', maxLevCap: 15 };
  if (LARGE_ALT_COINS.has(coin)) return { tier: 'LARGE_ALT', maxLevCap: 10 };
  return { tier: 'VOLATILE_ALT', maxLevCap: 6 };
}

function evaluateLiveRisk({
  availBal, entryPrice, slPrice, qtyStep, minOrderQty, maxOrderQty,
  minNotionalValue = 5, riskPerTradePct = 0.03, maxMarginPct = 0.20,
  leverage = 5, autoLeverage = false, atrPct = 0.8, signalQualityScore = 70,
  maxLeverage = 20, openPositionsCount = 0, maxOpenPositions = 3,
  consecutiveLosses = 0, maxConsecutiveLosses = 3,
  walletAllocEnabled = false, walletAllocPct = 0.50, symbol = ''
}) {
  if (consecutiveLosses >= maxConsecutiveLosses) {
    return { approved: false, orderQty: 0, errorCode: 'COOLDOWN_ACTIVE', reason: `NO_TRADE: Consecutive loss cooldown (${consecutiveLosses}/${maxConsecutiveLosses}).` };
  }
  if (openPositionsCount >= maxOpenPositions) {
    return { approved: false, orderQty: 0, errorCode: 'MAX_POSITIONS_REACHED', reason: `NO_TRADE: Max open positions reached (${openPositionsCount}/${maxOpenPositions}).` };
  }

  const coinProfile = getCoinRiskProfile(symbol);
  const effectiveMaxLev = autoLeverage ? Math.min(Number(maxLeverage || 20), coinProfile.maxLevCap) : Number(maxLeverage || 20);
  const levCap = Math.min(20, Math.max(1, effectiveMaxLev));
  const levFloor = Math.min(levCap, 5);
  const chosenLev = autoLeverage
    ? computeAutoLeverage({ atrPct, signalQualityScore, maxLeverage: levCap })
    : Math.min(levCap, Math.max(levFloor, Number(leverage || 5)));

  // v8.3: Enforce environment risk/margin caps strictly so minimum limits never bypass risk budget
  const envMaxRiskCap = Math.min(0.10, Math.max(0.0025, Number(process.env.MAX_RISK_PER_TRADE_PCT || 0.02)));
  const envMaxMarginCap = Math.min(0.50, Math.max(0.05, Number(process.env.MAX_MARGIN_PCT || 0.20)));
  const safeRiskPct = Math.min(envMaxRiskCap, Math.max(0.0025, Number(riskPerTradePct || 0.015)));
  const safeMaxMarginPct = Math.min(envMaxMarginCap, Math.max(0.05, Number(maxMarginPct || 0.20)));
  const slDist = Math.abs(Number(entryPrice) - Number(slPrice));

  if (!Number.isFinite(availBal) || availBal <= 0 || !Number.isFinite(slDist) || slDist <= 0) {
    return { approved: false, orderQty: 0, leverage: chosenLev, errorCode: 'INSUFFICIENT_BALANCE', reason: 'NO_TRADE: Available Bybit USDT balance is 0 or SL distance invalid.' };
  }

  const unitRisk = slDist + entryPrice * 0.0015;
  const useWalletAlloc = Boolean(walletAllocEnabled);
  const cleanAllocPct = Math.min(1.0, Math.max(0.10, Number(walletAllocPct || 0.50)));
  // Keep 3% fee buffer when 100% is chosen so Bybit doesn't reject for fee margin
  const effectiveAllocPct = cleanAllocPct >= 0.98 ? 0.97 : cleanAllocPct;

  // v10.0 #13: Consecutive Loss Size Reduction (50% cut after 2 consecutive losses)
  const lossScale = consecutiveLosses >= 2 ? 0.5 : 1.0;
  // v10.0 #10: Auto-Compounding Anti-Martingale Multiplier (scales gently with win streak / balance)
  const compoundScale = consecutiveLosses === 0 && signalQualityScore >= 85 ? 1.15 : 1.0;
  const finalScale = Math.min(1.15, Math.max(0.5, lossScale * compoundScale));

  const riskBudget = availBal * safeRiskPct * finalScale;
  const maxMarginUsdt = (useWalletAlloc ? (availBal * effectiveAllocPct) : (availBal * safeMaxMarginPct)) * lossScale;
  const maxQtyByMargin = (maxMarginUsdt * chosenLev) / entryPrice;

  const rawQty = useWalletAlloc
    ? Math.min(Number(maxOrderQty || 100000), maxQtyByMargin)
    : Math.min(Number(maxOrderQty || 100000), maxQtyByMargin, riskBudget / Math.max(1e-8, unitRisk));
  const orderQty = formatBybitQty(rawQty, qtyStep);

  if (!Number.isFinite(orderQty) || orderQty <= 0 || orderQty < Number(minOrderQty || 0.01)) {
    return { approved: false, orderQty: 0, leverage: chosenLev, errorCode: 'QTY_BELOW_MIN', reason: `NO_TRADE: Calculated qty (${orderQty}) < Bybit minOrderQty (${minOrderQty}).` };
  }

  const notional = orderQty * entryPrice;
  if (notional < Number(minNotionalValue || 5)) {
    return { approved: false, orderQty: 0, leverage: chosenLev, errorCode: 'NOTIONAL_BELOW_MIN', reason: `NO_TRADE: Order notional ($${notional.toFixed(2)}) < Bybit minimum ($${minNotionalValue}).` };
  }

  const actualRiskUsdt = orderQty * unitRisk;
  const requiredMarginVal = notional / chosenLev;
  if (!useWalletAlloc && actualRiskUsdt > riskBudget * 1.02) {
    return { approved: false, orderQty: 0, leverage: chosenLev, errorCode: 'RISK_CAP_EXCEEDED', reason: `NO_TRADE: Actual risk ($${actualRiskUsdt.toFixed(2)}) exceeds cap ($${riskBudget.toFixed(2)}).` };
  }
  if (requiredMarginVal > maxMarginUsdt * 1.02) {
    return { approved: false, orderQty: 0, leverage: chosenLev, errorCode: 'MARGIN_CAP_EXCEEDED', reason: `NO_TRADE: Required margin ($${requiredMarginVal.toFixed(2)}) exceeds cap ($${maxMarginUsdt.toFixed(2)}).` };
  }

  return {
    approved: true,
    errorCode: null,
    orderQty,
    leverage: chosenLev,
    autoLeverageUsed: Boolean(autoLeverage),
    coinRiskTier: coinProfile.tier,
    notional: +notional.toFixed(2),
    requiredMargin: +(notional / chosenLev).toFixed(2),
    maxMarginPct: +(safeMaxMarginPct * 100).toFixed(1),
    maxRiskUsdt: +(useWalletAlloc ? actualRiskUsdt : riskBudget).toFixed(2),
    walletAllocUsed: useWalletAlloc,
    walletAllocPct: useWalletAlloc ? Math.round(cleanAllocPct * 100) : null
  };
}

module.exports = {
  getDecimalsFromStep,
  formatBybitPrice,
  formatBybitQty,
  computeAutoLeverage,
  checkOiFundingSqueeze,
  validateSlTpLevels,
  computeAndValidateEntry,
  getCoinRiskProfile,
  evaluateLiveRisk
};
