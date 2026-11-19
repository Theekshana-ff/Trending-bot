// Modules 02, 03, 09, 10: Technical Indicators, MTF Engine, Volume & Volatility, Trend Detection

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

function analyzeVolumeVolatility(candles) {
  if (!Array.isArray(candles) || candles.length < 21) {
    return { ok: false, atr: 0, atrPct: 0, volRatio: 0, regime: 'UNKNOWN' };
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

  let regime = 'NORMAL';
  if (atrPct > 2.2) regime = 'EXTREME_VOLATILITY';
  else if (atrPct < 0.12) regime = 'LOW_VOL_SQUEEZE';

  return {
    ok: true,
    atr,
    atrPct,
    volRatio,
    volumeConfirmed: volRatio >= 0.85,
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
  const neutralCount = list.filter(x => x === 'NEUTRAL').length;

  const dominant = bullCount >= bearCount ? 'LONG' : 'SHORT';
  const maxDir = Math.max(bullCount, bearCount);
  const agreementPct = Math.round((maxDir / 5) * 100);
  const htfConflict = (t4h.bias === 'BULL' && t15m.bias === 'BEAR') || (t4h.bias === 'BEAR' && t15m.bias === 'BULL');
  const conflictDetected = maxDir < minConfirmations || agreementPct < 60 || htfConflict;

  return {
    ok: !conflictDetected,
    decision: conflictDetected ? 'NO_TRADE' : dominant,
    conflictDetected,
    htfConflict,
    agreementPct,
    bullCount,
    bearCount,
    neutralCount,
    trendStrength: Math.round((t4h.strength + t1h.strength + t15m.strength) / 3),
    rsi15m: t15m.rsi,
    breakdown: { '1D': t1d.bias, '4H': t4h.bias, '1H': t1h.bias, '15M': t15m.bias, '5M': t5m.bias },
    reason: conflictDetected
      ? `NO_TRADE: MTF conflict/weakness (1D=${t1d.bias}, 4H=${t4h.bias}, 1H=${t1h.bias}, 15M=${t15m.bias}, 5M=${t5m.bias} · ${agreementPct}%)`
      : `MTF Aligned ${dominant} (${agreementPct}%)`
  };
}

module.exports = {
  calcEMA,
  calcRSI,
  calcWilderATR,
  analyzeVolumeVolatility,
  detectTrend,
  evaluateMTF
};
