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
  let lev = 5;
  if (atrPct > 1.5) lev = 2;
  else if (atrPct > 1.1) lev = 3;
  else if (atrPct > 0.7) lev = 5;
  else if (atrPct > 0.4) lev = signalQualityScore >= 80 ? 8 : 6;
  else lev = signalQualityScore >= 80 ? 10 : 7;
  return Math.min(cap, Math.max(1, lev));
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
  fundingRate = 0, entryMode = 'limit_pullback', ema20 = 0, orderBlock = null, fib = null
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
  const isLong = direction === 'LONG';
  const momentumOk = isLong
    ? (last[4] > last[1] && last[4] >= prev[4])
    : (last[4] < last[1] && last[4] <= prev[4]);

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

  const entry = formatBybitPrice(rawEntry, tickSize);
  const sign = isLong ? 1 : -1;
  const recentLows = closedCandles.slice(-12).map(c => c[3]);
  const recentHighs = closedCandles.slice(-12).map(c => c[2]);
  const swingInv = isLong ? Math.min(...recentLows) - atr * 0.25 : Math.max(...recentHighs) + atr * 0.25;

  const feePct = orderType === 'Limit' ? 0.04 : 0.11;
  const fundingPenaltyPct = Math.abs(Number(fundingRate || 0)) * 100;
  const cost = entry * ((feePct + Number(spreadPct || 0.02) + fundingPenaltyPct) / 100);
  const riskDist = Math.max(atr * 1.25, Math.abs(entry - swingInv)) + cost;

  const sl = formatBybitPrice(entry - sign * riskDist, tickSize);
  const tp1 = formatBybitPrice(entry + sign * (riskDist * 1.5 + cost), tickSize);
  const tp2 = formatBybitPrice(entry + sign * (riskDist * 3.0 + cost), tickSize);
  const tp3 = formatBybitPrice(entry + sign * (riskDist * 5.0 + cost), tickSize);
  const tp4 = formatBybitPrice(entry + sign * (riskDist * 8.0 + cost), tickSize);

  const slTpCheck = validateSlTpLevels({ direction, entry, sl, tp1, tp: tp4 });
  if (!slTpCheck.valid) return { valid: false, errorCode: slTpCheck.errorCode, reason: `NO_TRADE: ${slTpCheck.reason}` };

  const rrRatio = +((Math.abs(tp2 - entry) - cost) / Math.max(1e-8, riskDist)).toFixed(2);
  return { valid: true, orderType, entry, sl, tp1, tp2, tp3, tp4, tp: tp4, rrRatio, estimatedCost: +cost.toFixed(6) };
}

function evaluateLiveRisk({
  availBal, entryPrice, slPrice, qtyStep, minOrderQty, maxOrderQty,
  minNotionalValue = 5, riskPerTradePct = 0.03, maxMarginPct = 0.20,
  leverage = 5, autoLeverage = false, atrPct = 0.8, signalQualityScore = 70,
  maxLeverage = 20, openPositionsCount = 0, maxOpenPositions = 3,
  consecutiveLosses = 0, maxConsecutiveLosses = 3
}) {
  if (consecutiveLosses >= maxConsecutiveLosses) {
    return { approved: false, orderQty: 0, errorCode: 'COOLDOWN_ACTIVE', reason: `NO_TRADE: Consecutive loss cooldown (${consecutiveLosses}/${maxConsecutiveLosses}).` };
  }
  if (openPositionsCount >= maxOpenPositions) {
    return { approved: false, orderQty: 0, errorCode: 'MAX_POSITIONS_REACHED', reason: `NO_TRADE: Max open positions reached (${openPositionsCount}/${maxOpenPositions}).` };
  }

  const chosenLev = autoLeverage
    ? computeAutoLeverage({ atrPct, signalQualityScore, maxLeverage })
    : Math.min(Number(maxLeverage || 20), Math.max(1, Number(leverage || 5)));

  // v8.3: Enforce environment risk/margin caps strictly so minimum limits never bypass risk budget
  const envMaxRiskCap = Math.min(0.10, Math.max(0.0025, Number(process.env.MAX_RISK_PER_TRADE_PCT || 0.02)));
  const envMaxMarginCap = Math.min(0.50, Math.max(0.05, Number(process.env.MAX_MARGIN_PCT || 0.20)));
  const safeRiskPct = Math.min(envMaxRiskCap, Math.max(0.0025, Number(riskPerTradePct || 0.015)));
  const safeMaxMarginPct = Math.min(envMaxMarginCap, Math.max(0.05, Number(maxMarginPct || 0.20)));
  const slDist = Math.abs(Number(entryPrice) - Number(slPrice));

  if (!Number.isFinite(availBal) || availBal <= 0 || !Number.isFinite(slDist) || slDist <= 0) {
    return { approved: false, orderQty: 0, leverage: chosenLev, errorCode: 'INSUFFICIENT_BALANCE', reason: 'NO_TRADE: Available Bybit USDT balance is 0 or SL distance invalid.' };
  }

  const riskBudget = availBal * safeRiskPct;
  const unitRisk = slDist + entryPrice * 0.0015;
  const maxMarginUsdt = availBal * safeMaxMarginPct;
  const maxQtyByMargin = (maxMarginUsdt * chosenLev) / entryPrice;

  const rawQty = Math.min(Number(maxOrderQty || 100000), maxQtyByMargin, riskBudget / Math.max(1e-8, unitRisk));
  const orderQty = formatBybitQty(rawQty, qtyStep);

  if (!Number.isFinite(orderQty) || orderQty <= 0 || orderQty < Number(minOrderQty || 0.01)) {
    return { approved: false, orderQty: 0, leverage: chosenLev, errorCode: 'QTY_BELOW_MIN', reason: `NO_TRADE: Calculated qty (${orderQty}) < Bybit minOrderQty (${minOrderQty}) under ${(safeRiskPct * 100).toFixed(2)}% risk cap.` };
  }

  const notional = orderQty * entryPrice;
  if (notional < Number(minNotionalValue || 5)) {
    return { approved: false, orderQty: 0, leverage: chosenLev, errorCode: 'NOTIONAL_BELOW_MIN', reason: `NO_TRADE: Order notional ($${notional.toFixed(2)}) < Bybit minimum ($${minNotionalValue}).` };
  }

  const actualRiskUsdt = orderQty * unitRisk;
  const requiredMarginVal = notional / chosenLev;
  if (actualRiskUsdt > riskBudget * 1.02) {
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
    notional: +notional.toFixed(2),
    requiredMargin: +(notional / chosenLev).toFixed(2),
    maxMarginPct: +(safeMaxMarginPct * 100).toFixed(1),
    maxRiskUsdt: +riskBudget.toFixed(2)
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
  evaluateLiveRisk
};
