// Modules 04, 05, 06, 07, 08: Market Structure, S/R Zones, Chart Patterns, Liquidity, SMC/ICT, Fibonacci, Elliott Wave (v6)

function findSwings(candles, lookback = 2) {
  const swingHighs = [];
  const swingLows = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const h = candles[i][2];
    const l = candles[i][3];
    let isHigh = true;
    let isLow = true;
    for (let j = 1; j <= lookback; j++) {
      if (candles[i - j][2] >= h || candles[i + j][2] > h) isHigh = false;
      if (candles[i - j][3] <= l || candles[i + j][3] < l) isLow = false;
    }
    if (isHigh) swingHighs.push({ idx: i, price: h, ts: candles[i][0] });
    if (isLow) swingLows.push({ idx: i, price: l, ts: candles[i][0] });
  }
  return { swingHighs, swingLows };
}

function clusterLevels(prices, tolerancePct = 0.004) {
  const sorted = [...prices].filter(p => Number.isFinite(p) && p > 0).sort((a, b) => a - b);
  const clusters = [];
  for (const p of sorted) {
    const existing = clusters.find(c => Math.abs(c.avg - p) / c.avg <= tolerancePct);
    if (existing) {
      existing.count++;
      existing.avg = (existing.avg * (existing.count - 1) + p) / existing.count;
    } else {
      clusters.push({ avg: p, count: 1 });
    }
  }
  return clusters.sort((a, b) => b.count - a.count).map(c => +c.avg.toPrecision(6));
}

function analyzeMarketStructure(candles) {
  if (!Array.isArray(candles) || candles.length < 20) {
    return { ok: false, structure: 'UNKNOWN', bos: 'NONE', support: null, resistance: null, supportLevels: [], resistanceLevels: [] };
  }
  const { swingHighs, swingLows } = findSwings(candles, 2);
  const lastClose = candles[candles.length - 1][4];
  const lastSH = swingHighs[swingHighs.length - 1]?.price || Math.max(...candles.slice(-20).map(c => c[2]));
  const prevSH = swingHighs[swingHighs.length - 2]?.price || lastSH;
  const lastSL = swingLows[swingLows.length - 1]?.price || Math.min(...candles.slice(-20).map(c => c[3]));
  const prevSL = swingLows[swingLows.length - 2]?.price || lastSL;

  let structure = 'RANGING';
  if (lastSH > prevSH && lastSL > prevSL) structure = 'BULLISH_HH_HL';
  else if (lastSH < prevSH && lastSL < prevSL) structure = 'BEARISH_LH_LL';

  let bos = 'NONE';
  if (lastClose > lastSH) bos = 'BULLISH_BOS';
  else if (lastClose < lastSL) bos = 'BEARISH_BOS';

  // v6 Update #7: Multi-level Support & Resistance zones for chart & guard
  const supportLevels = clusterLevels(swingLows.map(s => s.price).filter(p => p < lastClose)).slice(0, 2);
  const resistanceLevels = clusterLevels(swingHighs.map(s => s.price).filter(p => p > lastClose)).slice(0, 2);
  if (!supportLevels.length && lastSL < lastClose) supportLevels.push(+lastSL.toPrecision(6));
  if (!resistanceLevels.length && lastSH > lastClose) resistanceLevels.push(+lastSH.toPrecision(6));

  return {
    ok: true,
    structure,
    bos,
    support: supportLevels[0] || lastSL,
    resistance: resistanceLevels[0] || lastSH,
    supportLevels,
    resistanceLevels,
    swingHighs,
    swingLows
  };
}

// v6 Update #7: S/R Zone Guard (blocks LONG right into Resistance, SHORT right into Support)
function checkSrProximity(price, direction, supportLevels = [], resistanceLevels = [], bufferPct = 0.004) {
  if (!Number.isFinite(price) || price <= 0) return { ok: true };
  if (direction === 'LONG') {
    const nearRes = resistanceLevels.find(r => r > price && ((r - price) / price) <= bufferPct);
    if (nearRes) {
      return { ok: false, errorCode: 'NEAR_RESISTANCE', reason: `NO_TRADE: Price (${price}) is within ${(bufferPct * 100).toFixed(1)}% of major Resistance (${nearRes}).` };
    }
  } else if (direction === 'SHORT') {
    const nearSup = supportLevels.find(s => s < price && ((price - s) / price) <= bufferPct);
    if (nearSup) {
      return { ok: false, errorCode: 'NEAR_SUPPORT', reason: `NO_TRADE: Price (${price}) is within ${(bufferPct * 100).toFixed(1)}% of major Support (${nearSup}).` };
    }
  }
  return { ok: true, errorCode: null };
}

// v6 Update #8: Chart & Candlestick Pattern Engine
function detectChartPatterns(candles, structure) {
  if (!Array.isArray(candles) || candles.length < 15) {
    return { pattern: 'NONE', bias: 'NEUTRAL', scoreBonus: 0, note: 'No pattern detected' };
  }
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const [ , o, h, l, c ] = last;
  const [ , po, , , pc ] = prev;
  const body = Math.abs(c - o);
  const fullRange = Math.max(1e-8, h - l);
  const upperWick = h - Math.max(o, c);
  const lowerWick = Math.min(o, c) - l;

  const sh = structure?.swingHighs || [];
  const sl = structure?.swingLows || [];

  // 1. Double Top / Double Bottom
  if (sh.length >= 2) {
    const a = sh[sh.length - 1].price;
    const b = sh[sh.length - 2].price;
    if (Math.abs(a - b) / a <= 0.004 && c < a * 0.996) {
      return { pattern: 'DOUBLE_TOP', bias: 'SHORT', scoreBonus: 12, note: `Double Top near ${a.toPrecision(5)}` };
    }
  }
  if (sl.length >= 2) {
    const a = sl[sl.length - 1].price;
    const b = sl[sl.length - 2].price;
    if (Math.abs(a - b) / a <= 0.004 && c > a * 1.004) {
      return { pattern: 'DOUBLE_BOTTOM', bias: 'LONG', scoreBonus: 12, note: `Double Bottom near ${a.toPrecision(5)}` };
    }
  }

  // 2. Breakout & Retest
  if (structure?.bos === 'BULLISH_BOS' && structure?.resistance && Math.abs(l - structure.resistance) / structure.resistance <= 0.005 && c > structure.resistance) {
    return { pattern: 'BREAKOUT_RETEST_BULL', bias: 'LONG', scoreBonus: 12, note: 'Bullish Breakout & Retest confirmed' };
  }
  if (structure?.bos === 'BEARISH_BOS' && structure?.support && Math.abs(h - structure.support) / structure.support <= 0.005 && c < structure.support) {
    return { pattern: 'BREAKOUT_RETEST_BEAR', bias: 'SHORT', scoreBonus: 12, note: 'Bearish Breakout & Retest confirmed' };
  }

  // 3. Bullish / Bearish Engulfing
  if (pc < po && c > o && c >= po && o <= pc && body > fullRange * 0.5) {
    return { pattern: 'BULLISH_ENGULFING', bias: 'LONG', scoreBonus: 10, note: 'Bullish Engulfing candle' };
  }
  if (pc > po && c < o && c <= po && o >= pc && body > fullRange * 0.5) {
    return { pattern: 'BEARISH_ENGULFING', bias: 'SHORT', scoreBonus: 10, note: 'Bearish Engulfing candle' };
  }

  // 4. Pinbar (Hammer / Shooting Star)
  if (lowerWick >= body * 2.2 && upperWick <= fullRange * 0.2 && c >= o) {
    return { pattern: 'BULLISH_PINBAR', bias: 'LONG', scoreBonus: 8, note: 'Bullish Pinbar rejection wick' };
  }
  if (upperWick >= body * 2.2 && lowerWick <= fullRange * 0.2 && c <= o) {
    return { pattern: 'BEARISH_PINBAR', bias: 'SHORT', scoreBonus: 8, note: 'Bearish Pinbar rejection wick' };
  }

  return { pattern: 'NONE', bias: 'NEUTRAL', scoreBonus: 0, note: 'No dominant chart pattern' };
}

function analyzeLiquidityAndSMC(candles, structure) {
  if (!Array.isArray(candles) || candles.length < 15) {
    return { ok: false, sweep: 'NONE', fvg: 'NONE', orderBlock: null };
  }
  const recent = candles.slice(-15);
  const last = recent[recent.length - 1];
  const prevHigh = Math.max(...recent.slice(0, -1).map(c => c[2]));
  const prevLow = Math.min(...recent.slice(0, -1).map(c => c[3]));

  let sweep = 'NONE';
  if (last[3] < prevLow && last[4] > prevLow) sweep = 'BULLISH_LIQ_SWEEP';
  else if (last[2] > prevHigh && last[4] < prevHigh) sweep = 'BEARISH_LIQ_SWEEP';

  let fvg = 'NONE';
  for (let i = recent.length - 1; i >= 2; i--) {
    if (recent[i][3] > recent[i - 2][2]) { fvg = 'BULLISH_FVG'; break; }
    if (recent[i][2] < recent[i - 2][3]) { fvg = 'BEARISH_FVG'; break; }
  }

  let orderBlock = null;
  for (let i = recent.length - 2; i >= 1; i--) {
    const c = recent[i];
    const next = recent[i + 1];
    if (c[4] < c[1] && next[4] > c[2]) { orderBlock = { type: 'BULL_OB', low: c[3], high: c[2] }; break; }
    if (c[4] > c[1] && next[4] < c[3]) { orderBlock = { type: 'BEAR_OB', low: c[3], high: c[2] }; break; }
  }

  return {
    ok: true,
    sweep,
    fvg,
    orderBlock,
    supportZone: structure.support,
    resistanceZone: structure.resistance
  };
}

function analyzeFibonacci(candles) {
  const slice = candles.slice(-40);
  const high = Math.max(...slice.map(c => c[2]));
  const low = Math.min(...slice.map(c => c[3]));
  const diff = high - low;
  const lastClose = slice[slice.length - 1][4];
  const retracement = diff > 0 ? +((high - lastClose) / diff).toFixed(3) : 0.5;
  const inGoldenPocket = retracement >= 0.5 && retracement <= 0.65;

  return {
    ok: diff > 0,
    swingHigh: high,
    swingLow: low,
    fib382: +(high - diff * 0.382).toFixed(6),
    fib500: +(high - diff * 0.5).toFixed(6),
    fib618: +(high - diff * 0.618).toFixed(6),
    retracement,
    inGoldenPocket
  };
}

function analyzeElliottWave(swingHighs = [], swingLows = []) {
  const totalSwings = swingHighs.length + swingLows.length;
  if (totalSwings < 5) return { phase: 'DEVELOPING', confidence: 'LOW' };
  const lastH = swingHighs[swingHighs.length - 1]?.price || 0;
  const prevH = swingHighs[swingHighs.length - 2]?.price || 0;
  const lastL = swingLows[swingLows.length - 1]?.price || 0;
  const prevL = swingLows[swingLows.length - 2]?.price || 0;
  if (lastH > prevH && lastL > prevL) return { phase: 'IMPULSE_WAVE_3_OR_5', confidence: 'MEDIUM' };
  if (lastH < prevH && lastL < prevL) return { phase: 'CORRECTIVE_ABC_OR_DOWN_IMPULSE', confidence: 'MEDIUM' };
  return { phase: 'CONSOLIDATION_WAVE_4', confidence: 'LOW' };
}

module.exports = {
  findSwings,
  analyzeMarketStructure,
  checkSrProximity,
  detectChartPatterns,
  analyzeLiquidityAndSMC,
  analyzeFibonacci,
  analyzeElliottWave
};
