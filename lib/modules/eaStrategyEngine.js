// File: lib/modules/eaStrategyEngine.js (v12.3)
// Real Multi-Strategy & Multi-Timeframe (5M, 15M, 1H, 4H) Analysis Engine
// Uses closed candles only (no repainting, no fake signals).

function calcEMA(values, period) {
  if (!values || values.length < period) return null;
  const k = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}

function calcRSI(closes, period = 14) {
  if (!closes || closes.length <= period) return 50;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  if (losses === 0) return 100;
  const rs = (gains / period) / (losses / period);
  return 100 - (100 / (1 + rs));
}

function calcMACD(closes) {
  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);
  if (ema12 === null || ema26 === null) return { macd: 0, bullish: false };
  const macd = ema12 - ema26;
  return { macd, bullish: macd > 0 };
}

function calcATR(candles, period = 14) {
  if (!candles || candles.length <= period) return 0;
  let sum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const c = candles[i];
    const prevClose = candles[i - 1].close;
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - prevClose),
      Math.abs(c.low - prevClose)
    );
    sum += tr;
  }
  return sum / period;
}

async function fetchKlines(symbol, interval = '15', limit = 65) {
  const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Bybit kline HTTP ${resp.status}`);
  const data = await resp.json();
  const list = data?.result?.list || [];
  const closedCandles = list.slice(1).reverse();
  return closedCandles.map(c => ({
    open: Number(c[1]),
    high: Number(c[2]),
    low: Number(c[3]),
    close: Number(c[4]),
    volume: Number(c[5])
  }));
}

function analyzeTimeframe(candles) {
  if (!candles || candles.length < 30) {
    return { bias: 'NEUTRAL', score: 0, rsi: 50, atr: 0, lastPrice: 0, reasons: ['Insufficient data'] };
  }

  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const vols = candles.map(c => c.volume);

  const lastCandle = candles[candles.length - 1];
  const last = lastCandle.close;
  const ema9 = calcEMA(closes, 9);
  const ema21 = calcEMA(closes, 21);
  const ema50 = calcEMA(closes, 50) || ema21;
  const rsi = calcRSI(closes, 14);
  const macd = calcMACD(closes);
  const atr = calcATR(candles, 14);

  const avgVol = vols.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  const volSpike = avgVol > 0 && lastCandle.volume > avgVol * 1.2;

  const recentHigh = Math.max(...highs.slice(-21, -1));
  const recentLow = Math.min(...lows.slice(-21, -1));
  const breakoutUp = last > recentHigh;
  const breakoutDown = last < recentLow;

  const bullishCandle = lastCandle.close > lastCandle.open;
  const bearishCandle = lastCandle.close < lastCandle.open;

  let bullPoints = 0;
  let bearPoints = 0;
  const bullReasons = [];
  const bearReasons = [];

  if (ema9 > ema21 && last > ema50) {
    bullPoints += 25;
    bullReasons.push('EMA 9/21/50 Bullish Trend');
  } else if (ema9 < ema21 && last < ema50) {
    bearPoints += 25;
    bearReasons.push('EMA 9/21/50 Bearish Trend');
  }

  if (rsi > 50 && rsi < 70) {
    bullPoints += 20;
    bullReasons.push(`RSI Bullish Zone (${rsi.toFixed(1)})`);
  } else if (rsi < 50 && rsi > 30) {
    bearPoints += 20;
    bearReasons.push(`RSI Bearish Zone (${rsi.toFixed(1)})`);
  }

  if (macd.bullish) {
    bullPoints += 15;
    bullReasons.push('MACD Positive');
  } else {
    bearPoints += 15;
    bearReasons.push('MACD Negative');
  }

  if (breakoutUp) {
    bullPoints += 20;
    bullReasons.push('Resistance Breakout');
  } else if (breakoutDown) {
    bearPoints += 20;
    bearReasons.push('Support Breakdown');
  }

  if (bullishCandle && volSpike) {
    bullPoints += 20;
    bullReasons.push('Bullish Price Action + Volume');
  } else if (bearishCandle && volSpike) {
    bearPoints += 20;
    bearReasons.push('Bearish Price Action + Volume');
  } else if (volSpike) {
    if (bullPoints >= bearPoints) {
      bullPoints += 10;
      bullReasons.push('Volume Spike');
    } else {
      bearPoints += 10;
      bearReasons.push('Volume Spike');
    }
  }

  if (bullPoints > bearPoints && bullPoints >= 50) {
    return { bias: 'BUY', score: Math.min(100, bullPoints), rsi, atr, lastPrice: last, reasons: bullReasons };
  }
  if (bearPoints > bullPoints && bearPoints >= 50) {
    return { bias: 'SELL', score: Math.min(100, bearPoints), rsi, atr, lastPrice: last, reasons: bearReasons };
  }
  return {
    bias: 'NEUTRAL',
    score: Math.max(bullPoints, bearPoints),
    rsi,
    atr,
    lastPrice: last,
    reasons: ['Sideways / No clear confluence']
  };
}

async function runEAAnalysis(symbol = 'BTCUSDT') {
  const cleanSym = String(symbol || 'BTCUSDT').toUpperCase();
  const [c5m, c15m, c1h, c4h] = await Promise.all([
    fetchKlines(cleanSym, '5', 65),
    fetchKlines(cleanSym, '15', 65),
    fetchKlines(cleanSym, '60', 65),
    fetchKlines(cleanSym, '240', 65)
  ]);

  const tf5m = analyzeTimeframe(c5m);
  const tf15m = analyzeTimeframe(c15m);
  const tf1h = analyzeTimeframe(c1h);
  const tf4h = analyzeTimeframe(c4h);

  let finalSignal = 'HOLD';
  let mtfBonus = 0;

  if (tf15m.bias === 'BUY' && tf1h.bias === 'BUY') {
    finalSignal = 'BUY';
    if (tf4h.bias === 'BUY') mtfBonus += 10;
    if (tf5m.bias === 'BUY') mtfBonus += 5;
  } else if (tf15m.bias === 'SELL' && tf1h.bias === 'SELL') {
    finalSignal = 'SELL';
    if (tf4h.bias === 'SELL') mtfBonus += 10;
    if (tf5m.bias === 'SELL') mtfBonus += 5;
  }

  const baseScore = Math.round((tf15m.score + tf1h.score) / 2);
  const qualityScore = Math.min(100, baseScore + mtfBonus);

  const price = tf15m.lastPrice || 0;
  const atr = tf15m.atr || (price * 0.005);
  let suggestedSL = null;
  let suggestedTP = null;

  if (finalSignal === 'BUY' && price > 0) {
    suggestedSL = Number((price - atr * 1.5).toFixed(4));
    suggestedTP = Number((price + atr * 3.0).toFixed(4));
  } else if (finalSignal === 'SELL' && price > 0) {
    suggestedSL = Number((price + atr * 1.5).toFixed(4));
    suggestedTP = Number((price - atr * 3.0).toFixed(4));
  }

  return {
    symbol: cleanSym,
    price,
    signal: qualityScore >= 65 ? finalSignal : 'HOLD',
    qualityScore,
    suggestedSL,
    suggestedTP,
    recentCloses: c15m.slice(-30).map(c => c.close),
    mtf: { '5M': tf5m.bias, '15M': tf15m.bias, '1H': tf1h.bias, '4H': tf4h.bias },
    reasons: tf15m.reasons
  };
}

const DEFAULT_SCAN_COINS = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'SUIUSDT',
  'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'BNBUSDT', 'NEARUSDT', 'APTUSDT'
];

async function scanTopCoinsEA(symbols = DEFAULT_SCAN_COINS, topN = 3) {
  const results = await Promise.all(
    symbols.map(sym => runEAAnalysis(sym).catch(() => null))
  );
  return results
    .filter(Boolean)
    .sort((a, b) => b.qualityScore - a.qualityScore)
    .slice(0, topN);
}

module.exports = { runEAAnalysis, scanTopCoinsEA };
