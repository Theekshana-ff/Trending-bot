// Modules 11, 12, 13: Entry Signal Validation, No-Trade Decision Engine, Live Risk Manager (H-06, H-08)

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

// H-06: Strict SL/TP Validation for LONG & SHORT
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

function computeAndValidateEntry({ closedCandles, livePrice, direction, tickSize, atr, spreadPct, fundingRate = 0 }) {
  if (!Array.isArray(closedCandles) || closedCandles.length < 20) {
    return { valid: false, errorCode: 'INSUFFICIENT_CANDLES', reason: 'NO_TRADE: Insufficient 15M closed candles.' };
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
    return { valid: false, errorCode: 'NO_CANDLE_CONFIRMATION', reason: `NO_TRADE: Latest 15M closed candle did not confirm ${direction} momentum.` };
  }

  const entry = formatBybitPrice(livePrice, tickSize);
  const sign = isLong ? 1 : -1;
  const recentLows = closedCandles.slice(-12).map(c => c[3]);
  const recentHighs = closedCandles.slice(-12).map(c => c[2]);
  const swingInv = isLong ? Math.min(...recentLows) - atr * 0.25 : Math.max(...recentHighs) + atr * 0.25;

  // Include taker fee (0.055% x 2 = 0.11%) + spread + estimated funding impact
  const fundingPenaltyPct = Math.abs(Number(fundingRate || 0)) * 100;
  const cost = entry * ((0.11 + Number(spreadPct || 0.02) + fundingPenaltyPct) / 100);
  const riskDist = Math.max(atr * 1.25, Math.abs(entry - swingInv)) + cost;

  const sl = formatBybitPrice(entry - sign * riskDist, tickSize);
  const tp1 = formatBybitPrice(entry + sign * (riskDist * 1.5 + cost), tickSize);
  const tp2 = formatBybitPrice(entry + sign * (riskDist * 3.0 + cost), tickSize);
  const tp3 = formatBybitPrice(entry + sign * (riskDist * 5.0 + cost), tickSize);
  const tp4 = formatBybitPrice(entry + sign * (riskDist * 8.0 + cost), tickSize);

  const slTpCheck = validateSlTpLevels({ direction, entry, sl, tp1, tp: tp4 });
  if (!slTpCheck.valid) return { valid: false, errorCode: slTpCheck.errorCode, reason: `NO_TRADE: ${slTpCheck.reason}` };

  const rrRatio = +((Math.abs(tp2 - entry) - cost) / Math.max(1e-8, riskDist)).toFixed(2);
  return { valid: true, entry, sl, tp1, tp2, tp3, tp4, tp: tp4, rrRatio, estimatedCost: +cost.toFixed(6) };
}

// H-08: Live Risk Manager with exposure, position count, leverage & fee/slippage guards
function evaluateLiveRisk({
  availBal,
  entryPrice,
  slPrice,
  qtyStep,
  minOrderQty,
  maxOrderQty,
  minNotionalValue = 5,
  riskPerTradePct = 0.03,
  leverage = 5,
  maxLeverage = 20,
  openPositionsCount = 0,
  maxOpenPositions = 3,
  consecutiveLosses = 0,
  maxConsecutiveLosses = 3
}) {
  if (consecutiveLosses >= maxConsecutiveLosses) {
    return { approved: false, orderQty: 0, errorCode: 'COOLDOWN_ACTIVE', reason: `NO_TRADE: Consecutive loss cooldown (${consecutiveLosses}/${maxConsecutiveLosses}).` };
  }
  if (openPositionsCount >= maxOpenPositions) {
    return { approved: false, orderQty: 0, errorCode: 'MAX_POSITIONS_REACHED', reason: `NO_TRADE: Max open positions reached (${openPositionsCount}/${maxOpenPositions}).` };
  }
  const safeLev = Math.min(Number(maxLeverage || 20), Math.max(1, Number(leverage || 5)));
  const safeRiskPct = Math.min(0.10, Math.max(0.0025, Number(riskPerTradePct || 0.03)));
  const slDist = Math.abs(Number(entryPrice) - Number(slPrice));

  if (!Number.isFinite(availBal) || availBal <= 0 || !Number.isFinite(slDist) || slDist <= 0) {
    return { approved: false, orderQty: 0, errorCode: 'INSUFFICIENT_BALANCE', reason: 'NO_TRADE: Available Bybit USDT balance is 0 or SL distance invalid.' };
  }

  const riskBudget = availBal * safeRiskPct;
  const unitRisk = slDist + entryPrice * 0.0015; // includes 0.15% round-trip fee + slippage buffer
  const maxNotionalByMargin = availBal * safeLev * 0.85; // keep 15% margin safety buffer
  const maxQtyByMargin = maxNotionalByMargin / entryPrice;

  const rawQty = Math.min(Number(maxOrderQty || 100000), maxQtyByMargin, riskBudget / Math.max(1e-8, unitRisk));
  const orderQty = formatBybitQty(rawQty, qtyStep);

  if (!Number.isFinite(orderQty) || orderQty <= 0 || orderQty < Number(minOrderQty || 0.01)) {
    return { approved: false, orderQty: 0, errorCode: 'QTY_BELOW_MIN', reason: `NO_TRADE: Calculated qty (${orderQty}) < Bybit minOrderQty (${minOrderQty}).` };
  }

  const notional = orderQty * entryPrice;
  if (notional < Number(minNotionalValue || 5)) {
    return { approved: false, orderQty: 0, errorCode: 'NOTIONAL_BELOW_MIN', reason: `NO_TRADE: Order notional ($${notional.toFixed(2)}) < Bybit minimum ($${minNotionalValue}).` };
  }

  return {
    approved: true,
    errorCode: null,
    orderQty,
    leverage: safeLev,
    notional: +notional.toFixed(2),
    requiredMargin: +(notional / safeLev).toFixed(2),
    maxRiskUsdt: +riskBudget.toFixed(2)
  };
}

module.exports = {
  getDecimalsFromStep,
  formatBybitPrice,
  formatBybitQty,
  validateSlTpLevels,
  computeAndValidateEntry,
  evaluateLiveRisk
};
