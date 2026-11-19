// Modules 04, 05, 06, 07, 08: Market Structure, Liquidity, SMC/ICT, Fibonacci, Elliott Wave

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

function analyzeMarketStructure(candles) {
  if (!Array.isArray(candles) || candles.length < 20) {
    return { ok: false, structure: 'UNKNOWN', bos: 'NONE', support: null, resistance: null };
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

  return { ok: true, structure, bos, support: lastSL, resistance: lastSH, swingHighs, swingLows };
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

  // Fair Value Gap (3-candle imbalance)
  let fvg = 'NONE';
  for (let i = recent.length - 1; i >= 2; i--) {
    if (recent[i][3] > recent[i - 2][2]) { fvg = 'BULLISH_FVG'; break; }
    if (recent[i][2] < recent[i - 2][3]) { fvg = 'BEARISH_FVG'; break; }
  }

  // Nearest Order Block (last opposite candle before impulse)
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
  if (totalSwings < 5) return { ok: true, phase: 'INSUFFICIENT_SWINGS', impulseScore: 0 };
  const lastTwoHighsRising = swingHighs.length >= 2 && swingHighs[swingHighs.length - 1].price > swingHighs[swingHighs.length - 2].price;
  const lastTwoLowsRising = swingLows.length >= 2 && swingLows[swingLows.length - 1].price > swingLows[swingLows.length - 2].price;
  const lastTwoHighsFalling = swingHighs.length >= 2 && swingHighs[swingHighs.length - 1].price < swingHighs[swingHighs.length - 2].price;
  const lastTwoLowsFalling = swingLows.length >= 2 && swingLows[swingLows.length - 1].price < swingLows[swingLows.length - 2].price;

  if (lastTwoHighsRising && lastTwoLowsRising) return { ok: true, phase: 'BULLISH_IMPULSE', impulseScore: 75 };
  if (lastTwoHighsFalling && lastTwoLowsFalling) return { ok: true, phase: 'BEARISH_IMPULSE', impulseScore: 75 };
  return { ok: true, phase: 'CORRECTIVE_ABC', impulseScore: 30 };
}

module.exports = {
  findSwings,
  analyzeMarketStructure,
  analyzeLiquidityAndSMC,
  analyzeFibonacci,
  analyzeElliottWave
};
