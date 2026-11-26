// lib/strategyV18.js — v18.1 Dual-Mode Strategy Engine (FAST Margin/Leverage Dynamic + SAFE Trend)

export function parseCandles(bybitList = []) {
  return [...bybitList].reverse().map((c) => ({
    ts: Number(c[0]),
    open: Number(c[1]),
    high: Number(c[2]),
    low: Number(c[3]),
    close: Number(c[4]),
    volume: Number(c[5]),
  }));
}

export function calcEMA(values, period) {
  if (!values.length) return [];
  const k = 2 / (period + 1);
  const ema = [values[0]];
  for (let i = 1; i < values.length; i++) {
    ema.push(values[i] * k + ema[i - 1] * (1 - k));
  }
  return ema;
}

export function calcRSI(closes, period = 14) {
  if (closes.length <= period) return 50;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }
  if (losses === 0) return 100;
  const rs = (gains / period) / (losses / period);
  return 100 - 100 / (1 + rs);
}

export function calcATR(candles, period = 14) {
  if (candles.length <= period) return 0;
  let sum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const cur = candles[i];
    const prev = candles[i - 1];
    const tr = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low - prev.close)
    );
    sum += tr;
  }
  return sum / period;
}

export function getBtcRegime(btc15mCandles) {
  if (!btc15mCandles || btc15mCandles.length < 30) {
    return { regime: 'NEUTRAL', change15mPct: 0, crashAlert: false };
  }
  const closes = btc15mCandles.map((c) => c.close);
  const ema9 = calcEMA(closes, 9);
  const ema21 = calcEMA(closes, 21);
  const last = btc15mCandles[btc15mCandles.length - 1];
  const prev = btc15mCandles[btc15mCandles.length - 2];

  const change15mPct = ((last.close - prev.close) / prev.close) * 100;
  const candleRangePct = ((last.high - last.low) / last.open) * 100;
  const crashAlert = Math.abs(change15mPct) >= 1.0 || candleRangePct >= 1.5;

  const lastEma9 = ema9[ema9.length - 1];
  const lastEma21 = ema21[ema21.length - 1];
  let regime = 'NEUTRAL';
  if (lastEma9 > lastEma21 * 1.0005 && last.close > lastEma9) regime = 'BULL';
  else if (lastEma9 < lastEma21 * 0.9995 && last.close < lastEma9) regime = 'BEAR';

  return {
    regime,
    change15mPct: Number(change15mPct.toFixed(3)),
    candleRangePct: Number(candleRangePct.toFixed(3)),
    crashAlert,
  };
}

export function previewMarginLeverageMath({
  mode = 'FAST',
  marginUsdt = 2.0,
  leverage = 12,
  targetNetUsdt = 0.10,
  maxLossPerTradeUsdt = 0.14,
  safeStopLossPct = 0.65,
  safeTakeProfitPct = 1.25,
  takerFeeRate = 0.00055,
}) {
  const notional = marginUsdt * leverage;
  const estFeesUsdt = notional * takerFeeRate * 2;

  if (mode === 'FAST') {
    const grossTpNeeded = targetNetUsdt + estFeesUsdt;
    const requiredTpPct = notional > 0 ? (grossTpNeeded / notional) * 100 : 0;

    const grossSlBudget = Math.max(0.015, maxLossPerTradeUsdt - estFeesUsdt);
    let requiredSlPct = notional > 0 ? (grossSlBudget / notional) * 100 : 0;
    if (requiredSlPct < 0.22) requiredSlPct = 0.22;

    const actualNetSlUsdt = notional * (requiredSlPct / 100) + estFeesUsdt;
    const feeRatioPct = grossTpNeeded > 0 ? (estFeesUsdt / grossTpNeeded) * 100 : 100;
    const netRR = actualNetSlUsdt > 0 ? targetNetUsdt / actualNetSlUsdt : 0;

    let speedLabel = 'FAST (5–25 min)';
    if (requiredTpPct > 0.85) speedLabel = 'SLOW (1–3 hrs — increase Leverage or Margin)';
    else if (requiredTpPct > 0.58) speedLabel = 'MEDIUM (20–60 min)';

    return {
      mode: 'FAST',
      notional: Number(notional.toFixed(2)),
      estFeesUsdt: Number(estFeesUsdt.toFixed(4)),
      requiredTpPct: Number(requiredTpPct.toFixed(3)),
      requiredSlPct: Number(requiredSlPct.toFixed(3)),
      netTpUsdt: Number(targetNetUsdt.toFixed(4)),
      netSlUsdt: Number(actualNetSlUsdt.toFixed(4)),
      feeRatioPct: Number(feeRatioPct.toFixed(1)),
      netRR: Number(netRR.toFixed(2)),
      speedLabel,
    };
  }

  const grossTpUsdt = notional * (safeTakeProfitPct / 100);
  const grossSlUsdt = notional * (safeStopLossPct / 100);
  const netTpUsdt = grossTpUsdt - estFeesUsdt;
  const netSlUsdt = grossSlUsdt + estFeesUsdt;
  const feeRatioPct = grossTpUsdt > 0 ? (estFeesUsdt / grossTpUsdt) * 100 : 100;
  const netRR = netSlUsdt > 0 ? netTpUsdt / netSlUsdt : 0;

  return {
    mode: 'SAFE',
    notional: Number(notional.toFixed(2)),
    estFeesUsdt: Number(estFeesUsdt.toFixed(4)),
    requiredTpPct: Number(safeTakeProfitPct.toFixed(3)),
    requiredSlPct: Number(safeStopLossPct.toFixed(3)),
    netTpUsdt: Number(netTpUsdt.toFixed(4)),
    netSlUsdt: Number(netSlUsdt.toFixed(4)),
    feeRatioPct: Number(feeRatioPct.toFixed(1)),
    netRR: Number(netRR.toFixed(2)),
    speedLabel: 'CALM SWING (45–180 min)',
  };
}

export function evaluateCoinSetup({
  symbol,
  mode = 'FAST',
  candles15m,
  candlesFast,
  spreadPct = 0,
  btcRegime = { regime: 'NEUTRAL', crashAlert: false },
  maxSpreadPct = 0.05,
}) {
  if (!candles15m || candles15m.length < 55 || !candlesFast || candlesFast.length < 30) {
    return { symbol, direction: 'WAIT', score: 0, status: 'NO_DATA', price: 0, spreadPct };
  }

  const c15 = candles15m.map((c) => c.close);
  const cf = candlesFast.map((c) => c.close);
  const last = candlesFast[candlesFast.length - 1];
  const prev = candlesFast[candlesFast.length - 2];
  const price = last.close;

  if (btcRegime.crashAlert) {
    return { symbol, direction: 'WAIT', score: 0, status: 'BTC_SPIKE_GUARD', price, spreadPct };
  }
  if (spreadPct > maxSpreadPct) {
    return { symbol, direction: 'WAIT', score: 0, status: 'WIDE_SPREAD', price, spreadPct };
  }

  const ema20_15m = calcEMA(c15, 20);
  const ema50_15m = calcEMA(c15, 50);
  const trendUp15m = ema20_15m[ema20_15m.length - 1] > ema50_15m[ema50_15m.length - 1];
  const trendDown15m = ema20_15m[ema20_15m.length - 1] < ema50_15m[ema50_15m.length - 1];

  const ema9 = calcEMA(cf, 9);
  const ema21 = calcEMA(cf, 21);
  const e9 = ema9[ema9.length - 1];
  const e21 = ema21[ema21.length - 1];
  const rsi = calcRSI(cf, 14);
  const atr = calcATR(candlesFast, 14);
  const atrPct = (atr / price) * 100;

  const avgVol =
    candlesFast.slice(-12, -2).reduce((acc, c) => acc + c.volume, 0) / 10 || 1;
  const volRatio = last.volume / avgVol;

  const minAtr = mode === 'FAST' ? 0.08 : 0.12;
  if (atrPct < minAtr) {
    return { symbol, direction: 'WAIT', score: 15, status: 'DEAD_MKT', price, spreadPct, rsi: Number(rsi.toFixed(1)), atrPct: Number(atrPct.toFixed(3)) };
  }

  const bodyPct = (Math.abs(last.close - last.open) / last.open) * 100;
  const maxBody = mode === 'FAST' ? 0.95 : 1.2;
  if (bodyPct > maxBody) {
    return { symbol, direction: 'WAIT', score: 25, status: 'CHASE_GUARD', price, spreadPct, rsi: Number(rsi.toFixed(1)), atrPct: Number(atrPct.toFixed(3)) };
  }

  let direction = 'WAIT';
  let score = 0;

  if (mode === 'FAST') {
    if (e9 > e21 && btcRegime.regime !== 'BEAR') {
      direction = 'LONG';
      score += 30;
      if (trendUp15m) score += 20;
      if (rsi >= 45 && rsi <= 68) score += 20;
      if (last.close > last.open && last.close > prev.close) score += 15;
      if (volRatio >= 1.1) score += 15;
    } else if (e9 < e21 && btcRegime.regime !== 'BULL') {
      direction = 'SHORT';
      score += 30;
      if (trendDown15m) score += 20;
      if (rsi >= 32 && rsi <= 55) score += 20;
      if (last.close < last.open && last.close < prev.close) score += 15;
      if (volRatio >= 1.1) score += 15;
    }
  } else {
    if (trendUp15m && e9 > e21 && btcRegime.regime !== 'BEAR') {
      direction = 'LONG';
      score += 35;
      if (rsi >= 42 && rsi <= 64) score += 25;
      if (last.close > last.open && last.close > prev.close) score += 15;
      if (volRatio >= 1.15) score += 15;
      if (btcRegime.regime === 'BULL') score += 10;
    } else if (trendDown15m && e9 < e21 && btcRegime.regime !== 'BULL') {
      direction = 'SHORT';
      score += 35;
      if (rsi >= 36 && rsi <= 58) score += 25;
      if (last.close < last.open && last.close < prev.close) score += 15;
      if (volRatio >= 1.15) score += 15;
      if (btcRegime.regime === 'BEAR') score += 10;
    }
  }

  const readyThreshold = mode === 'FAST' ? 75 : 80;
  const status = score >= readyThreshold ? 'READY' : direction === 'WAIT' ? 'NEUTRAL' : 'WAIT_CONFIRM';

  return {
    symbol,
    direction,
    score,
    status,
    price,
    spreadPct: Number(spreadPct.toFixed(4)),
    rsi: Number(rsi.toFixed(1)),
    atrPct: Number(atrPct.toFixed(3)),
    volRatio: Number(volRatio.toFixed(2)),
  };
}

export function buildSafeOrderPlan({
  mode = 'FAST',
  direction,
  price,
  marginUsdt = 2.0,
  leverage = 12,
  targetNetUsdt = 0.10,
  maxLossPerTradeUsdt = 0.14,
  stopLossPct = 0.65,
  takeProfitPct = 1.25,
  atrPct = 0.20,
  minOrderQty = 0.1,
  qtyStep = 0.1,
  tickSize = 0.0001,
  minNotional = 5.0,
  takerFeeRate = 0.00055,
  minNetRR = 1.5,
}) {
  const notional = marginUsdt * leverage;
  if (notional < minNotional) {
    return {
      ok: false,
      reason: `Notional $${notional.toFixed(2)} < Bybit min $${minNotional}. Increase Margin or Leverage.`,
    };
  }

  const rawQty = notional / price;
  const stepDecimals = countDecimals(qtyStep);
  const qty = Number((Math.floor(rawQty / qtyStep) * qtyStep).toFixed(stepDecimals));

  if (qty < minOrderQty || qty <= 0) {
    return { ok: false, reason: `qty (${qty}) < minOrderQty (${minOrderQty})` };
  }

  const actualNotional = qty * price;
  if (actualNotional < minNotional) {
    return { ok: false, reason: `Order value $${actualNotional.toFixed(2)} < minNotional $${minNotional}` };
  }

  const estFeesUsdt = actualNotional * takerFeeRate * 2;
  let effectiveTpPct = 0;
  let effectiveSlPct = 0;

  if (mode === 'FAST') {
    const grossTpNeeded = targetNetUsdt + estFeesUsdt;
    effectiveTpPct = (grossTpNeeded / actualNotional) * 100;

    const grossSlBudget = Math.max(0.015, maxLossPerTradeUsdt - estFeesUsdt);
    const budgetSlPct = (grossSlBudget / actualNotional) * 100;
    const noiseFloorSlPct = Math.max(0.22, Math.min(atrPct * 1.2, 0.45));
    effectiveSlPct = Math.max(budgetSlPct, noiseFloorSlPct);
    effectiveSlPct = Math.min(effectiveSlPct, effectiveTpPct * 1.45);
  } else {
    effectiveSlPct = Math.max(stopLossPct, Math.min(atrPct * 1.8, 1.2));
    effectiveTpPct = Math.max(takeProfitPct, effectiveSlPct * 1.9);
  }

  const grossTpUsdt = actualNotional * (effectiveTpPct / 100);
  const grossSlUsdt = actualNotional * (effectiveSlPct / 100);
  const netTpUsdt = grossTpUsdt - estFeesUsdt;
  const netSlUsdt = grossSlUsdt + estFeesUsdt;

  if (netTpUsdt <= 0) {
    return { ok: false, reason: 'Net TP after fees is <= 0' };
  }

  const feeRatio = estFeesUsdt / grossTpUsdt;
  const maxAllowedFeeRatio = mode === 'FAST' ? 0.35 : 0.25;
  if (feeRatio > maxAllowedFeeRatio) {
    return {
      ok: false,
      reason: `Fees too high (${(feeRatio * 100).toFixed(1)}% > ${maxAllowedFeeRatio * 100}%).`,
    };
  }

  const netRR = netTpUsdt / netSlUsdt;
  const minAllowedRR = mode === 'FAST' ? 0.65 : minNetRR;
  if (netRR < minAllowedRR) {
    return {
      ok: false,
      reason: `Net R:R (${netRR.toFixed(2)}) < minimum (${minAllowedRR})`,
    };
  }

  const priceDecimals = countDecimals(tickSize);
  const roundPrice = (p) => Number((Math.round(p / tickSize) * tickSize).toFixed(priceDecimals));

  const isLong = direction === 'LONG';
  const stopLoss = roundPrice(isLong ? price * (1 - effectiveSlPct / 100) : price * (1 + effectiveSlPct / 100));
  const takeProfit = roundPrice(isLong ? price * (1 + effectiveTpPct / 100) : price * (1 - effectiveTpPct / 100));

  return {
    ok: true,
    params: {
      mode,
      side: isLong ? 'Buy' : 'Sell',
      qty,
      entryPrice: price,
      stopLoss,
      takeProfit,
      notional: Number(actualNotional.toFixed(2)),
      effectiveSlPct: Number(effectiveSlPct.toFixed(3)),
      effectiveTpPct: Number(effectiveTpPct.toFixed(3)),
      estFeesUsdt: Number(estFeesUsdt.toFixed(4)),
      netTpUsdt: Number(netTpUsdt.toFixed(4)),
      netSlUsdt: Number(netSlUsdt.toFixed(4)),
      feeRatioPct: Number((feeRatio * 100).toFixed(1)),
      netRR: Number(netRR.toFixed(2)),
    },
  };
}

function countDecimals(num) {
  const s = String(num);
  if (s.includes('e-')) return Number(s.split('e-')[1]);
  const parts = s.split('.');
  return parts.length > 1 ? parts[1].length : 0;
}
