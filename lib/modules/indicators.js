// Modules 02, 03, 09, 10: Technical Indicators, ADX Filter, RSI Guard, MTF Engine, Volume & Volatility (v6)

function calcEMA(arr, period) {
  if (!Array.isArray(arr) || !arr.length) return 0;
  const k = 2 / (period + 1);
  const seedLen = Math.min(arr.length, period);
  let ema = arr.slice(0, seedLen).reduce((a, b) => a + b, 0) / seedLen;
  for (let i = seedLen; i < arr.length; i++) {
    ema = arr[i] * k + ema * (1 - k);
  }
  return ema;
}

function calcRSI(closes, period = 14) {
  if (!Array.isArray(closes) || closes.length <= period) return 50;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? -diff : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return +(100 - 100 / (1 + rs)).toFixed(2);
}

function calcWilderATR(highs, lows, closes, period = 14) {
  if (!Array.isArray(closes) || closes.length <= period) return 0;
  const trs = [];
  for (let i = 1; i < closes.length; i++) {
    trs.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    ));
  }
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  return atr;
}

// v6 Update #2: Wilder's ADX(14) for Choppy/Sideways Market Filtering
function calcADX(highs, lows, closes, period = 14) {
  if (!Array.isArray(closes) || closes.length < period * 2 + 2) {
    return { adx: 25, plusDi: 25, minusDi: 25, isTrending: true };
  }
  const trs = [];
  const plusDms = [];
  const minusDms = [];
  for (let i = 1; i < closes.length; i++) {
    const upMove = highs[i] - highs[i - 1];
    const downMove = lows[i - 1] - lows[i];
    plusDms.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDms.push(downMove > upMove && downMove > 0 ? downMove : 0);
    trs.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    ));
  }
  let smTr = trs.slice(0, period).reduce((a, b) => a + b, 0);
  let smPlus = plusDms.slice(0, period).reduce((a, b) => a + b, 0);
  let smMinus = minusDms.slice(0, period).reduce((a, b) => a + b, 0);

  const dxs = [];
  let lastPlusDi = 0;
  let lastMinusDi = 0;

  for (let i = period; i < trs.length; i++) {
    smTr = smTr - (smTr / period) + trs[i];
    smPlus = smPlus - (smPlus / period) + plusDms[i];
    smMinus = smMinus - (smMinus / period) + minusDms[i];
    const pDi = smTr > 0 ? (smPlus / smTr) * 100 : 0;
    const mDi = smTr > 0 ? (smMinus / smTr) * 100 : 0;
    lastPlusDi = pDi;
    lastMinusDi = mDi;
    const denom = pDi + mDi;
    dxs.push(denom > 0 ? (Math.abs(pDi - mDi) / denom) * 100 : 0);
  }

  let adx = dxs.slice(0, period).reduce((a, b) => a + b, 0) / Math.max(1, Math.min(period, dxs.length));
  for (let i = period; i < dxs.length; i++) {
    adx = ((adx * (period - 1)) + dxs[i]) / period;
  }

  return {
    adx: +adx.toFixed(2),
    plusDi: +lastPlusDi.toFixed(2),
    minusDi: +lastMinusDi.toFixed(2),
    isTrending: adx >= 22
  };
}

// v6 Update #5: Overextended RSI Guard
function checkRsiGuard(rsi, direction) {
  if (direction === 'LONG' && rsi > 72) {
    return { ok: false, errorCode: 'RSI_OVERBOUGHT', reason: `NO_TRADE: RSI(${rsi}) > 72 (Overbought — avoid chasing top).` };
  }
  if (direction === 'SHORT' && rsi < 28) {
    return { ok: false, errorCode: 'RSI_OVERSOLD', reason: `NO_TRADE: RSI(${rsi}) < 28 (Oversold — avoid shorting bottom).` };
  }
  return { ok: true, errorCode: null };
}

function analyzeVolumeVolatility(candles) {
  if (!Array.isArray(candles) || candles.length < 21) {
    return { ok: false, atr: 0, atrPct: 0, volRatio: 0, adx: 0, isTrending: false, rsi: 50, ema20: 0, regime: 'UNKNOWN' };
  }
  const highs = candles.map(c => c[2]);
  const lows = candles.map(c => c[3]);
  const closes = candles.map(c => c[4]);
  const vols = candles.map(c => c[5]);
  const lastClose = closes[closes.length - 1];
  const atr = calcWilderATR(highs, lows, closes, 14);
  const atrPct = lastClose > 0 ? +((atr / lastClose) * 100).toFixed(3) : 0;
  const avgVol20 = vols.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  const lastVol = vols[vols.length - 1];
  const volRatio = avgVol20 > 0 ? +(lastVol / avgVol20).toFixed(2) : 1;
  const adxData = calcADX(highs, lows, closes, 14);
  const rsi = calcRSI(closes, 14);
  const ema20 = calcEMA(closes, 20);

  let regime = 'NORMAL';
  if (atrPct > 2.2) regime = 'EXTREME_VOLATILITY';
  else if (atrPct < 0.12) regime = 'LOW_VOL_SQUEEZE';
  else if (!adxData.isTrending) regime = 'CHOPPY_SIDEWAYS';

  return {
    ok: true,
    atr,
    atrPct,
    volRatio,
    volumeConfirmed: volRatio >= 0.85,
    adx: adxData.adx,
    plusDi: adxData.plusDi,
    minusDi: adxData.minusDi,
    isTrending: adxData.isTrending,
    rsi,
    ema20,
    regime
  };
}

function detectTrend(closes) {
  if (!Array.isArray(closes) || closes.length < 20) {
    return { bias: 'NEUTRAL', strength: 0, ema20: 0, ema50: 0, rsi: 50 };
  }
  const ema20 = calcEMA(closes, 20);
  const ema50 = calcEMA(closes, Math.min(50, closes.length));
  const last = closes[closes.length - 1];
  const rsi = calcRSI(closes, 14);
  const sepPct = ema50 > 0 ? ((ema20 - ema50) / ema50) * 100 : 0;

  let bias = 'NEUTRAL';
  if (ema20 > ema50 * 1.0012 && last > ema20) bias = 'BULL';
  else if (ema20 < ema50 * 0.9988 && last < ema20) bias = 'BEAR';

  const strength = Math.min(100, Math.round(Math.abs(sepPct) * 35 + (bias !== 'NEUTRAL' ? 25 : 0)));
  return { bias, strength, ema20, ema50, rsi };
}

function evaluateMTF({ closes1d, closes4h, closes1h, closes15m, closes5m, minConfirmations = 3 }) {
  const t1d = detectTrend(closes1d);
  const t4h = detectTrend(closes4h);
  const t1h = detectTrend(closes1h);
  const t15m = detectTrend(closes15m);
  const t5m = detectTrend(closes5m);

  const list = [t1d.bias, t4h.bias, t1h.bias, t15m.bias, t5m.bias];
  const bullCount = list.filter(x => x === 'BULL').length;
  const bearCount = list.filter(x => x === 'BEAR').length;

  const dominant = bullCount >= bearCount ? 'LONG' : 'SHORT';
  const maxDir = Math.max(bullCount, bearCount);
  const agreementPct = Math.round((maxDir / 5) * 100);
  const conflictDetected = maxDir < minConfirmations || (bullCount >= 2 && bearCount >= 2);

  return {
    ok: !conflictDetected,
    decision: conflictDetected ? 'NO_TRADE' : dominant,
    agreementPct,
    conflictDetected,
    reason: conflictDetected ? `NO_TRADE: MTF conflict (${bullCount} BULL vs ${bearCount} BEAR, need >=${minConfirmations}).` : null,
    breakdown: { '1D': t1d.bias, '4H': t4h.bias, '1H': t1h.bias, '15M': t15m.bias, '5M': t5m.bias },
    details: { t1d, t4h, t1h, t15m, t5m }
  };
}

module.exports = {
  calcEMA,
  calcRSI,
  calcWilderATR,
  calcADX,
  checkRsiGuard,
  analyzeVolumeVolatility,
  detectTrend,
  evaluateMTF
};
