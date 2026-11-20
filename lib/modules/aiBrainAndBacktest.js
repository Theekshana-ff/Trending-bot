// Modules 16, 17, 18, 19: Historical Backtesting, Walk-Forward Testing, AI Explanation Engine, Strategy Performance Analyzer (H-01, H-02, H-04)
const { calcEMA, calcWilderATR, calcADX, calcRSI, checkRsiGuard } = require('./indicators');

function buildDeterministicExplanation({
  symbol, direction, decision, mtf, structure, smc, fib, elliott, volVol, levels, risk,
  patternData = null, btcContext = null, oiData = null, noTradeReason
}) {
  const qualityPoints = [];
  let score = 0;

  if (mtf.ok) { score += 25; qualityPoints.push(`MTF ${mtf.agreementPct}%`); }
  else { qualityPoints.push(`MTF conflict (${mtf.agreementPct}%)`); }

  if ((direction === 'LONG' && structure.structure === 'BULLISH_HH_HL') || (direction === 'SHORT' && structure.structure === 'BEARISH_LH_LL')) {
    score += 18; qualityPoints.push(structure.structure);
  }
  if (volVol.isTrending) { score += 12; qualityPoints.push(`ADX ${volVol.adx} (Trending)`); }
  if (smc.sweep !== 'NONE') { score += 12; qualityPoints.push(smc.sweep); }
  if (smc.fvg !== 'NONE') { score += 8; qualityPoints.push(smc.fvg); }
  if (fib.inGoldenPocket) { score += 8; qualityPoints.push(`Fib Golden Pocket (${fib.retracement})`); }
  if (volVol.volumeConfirmed && volVol.regime !== 'EXTREME_VOLATILITY') { score += 10; qualityPoints.push(`Vol ${volVol.volRatio}x`); }
  if (patternData && patternData.pattern !== 'NONE' && patternData.bias === direction) {
    score += patternData.scoreBonus || 10;
    qualityPoints.push(`Pattern: ${patternData.pattern}`);
  }
  if (btcContext && btcContext.aligned) { score += 5; qualityPoints.push(`BTC ${btcContext.trend}`); }
  if (oiData && oiData.ok) { qualityPoints.push(`OI ${oiData.oiChangePct >= 0 ? '+' : ''}${oiData.oiChangePct}%`); }

  return {
    symbol,
    decision,
    signalQualityScore: Math.min(100, score),
    marketContext: `${structure.structure} | ADX ${volVol.adx} | RSI ${volVol.rsi} | ${patternData?.pattern || 'NONE'}`,
    reasons: qualityPoints,
    rejectionReason: decision === 'NO_TRADE' ? (noTradeReason || 'Deterministic safety gate rejected setup.') : null,
    summary: decision === 'NO_TRADE'
      ? `REJECTED (${Math.min(100, score)}/100): ${noTradeReason}`
      : `APPROVED ${direction} ${levels.orderType || 'Market'} (${Math.min(100, score)}/100): ${qualityPoints.join(' · ')} · R:R 1:${levels.rrRatio} · Margin $${risk.requiredMargin}`
  };
}

// v8.3: Historical Backtesting aligned with Live Sniper Strategy (EMA20/50 + ADX + RSI Guard + Fees/Slippage)
// Supports startIndex & endIndex so Walk-Forward warms up indicators with ZERO data leakage.
function runBacktest(candles, { feeSlippagePct = 0.0015, atrMultSl = 1.3, rrTarget = 2.0, startIndex = 52, endIndex = null, useLiveFilters = true } = {}) {
  if (!Array.isArray(candles) || candles.length < 60) {
    return { ok: false, errorCode: 'INSUFFICIENT_HISTORY', sampleCount: 0, enabled: false };
  }
  const trades = [];
  let equity = 100;
  let peak = 100;
  let maxDrawdownPct = 0;

  const firstIdx = Math.max(52, Number(startIndex || 52));
  const lastIdx = Math.min(candles.length - 5, endIndex !== null ? Number(endIndex) : candles.length - 5);

  for (let i = firstIdx; i < lastIdx; i++) {
    const slice = candles.slice(0, i + 1);
    const closes = slice.map(c => c[4]);
    const highs = slice.map(c => c[2]);
    const lows = slice.map(c => c[3]);
    const ema20 = calcEMA(closes, 20);
    const ema50 = calcEMA(closes, 50);
    const atr = calcWilderATR(highs, lows, closes, 14);
    const last = slice[slice.length - 1];
    const prev = slice[slice.length - 2];

    let dir = null;
    if (ema20 > ema50 * 1.0012 && last[4] > ema20 && last[4] > last[1] && last[4] >= prev[4]) dir = 'LONG';
    else if (ema20 < ema50 * 0.9988 && last[4] < ema20 && last[4] < last[1] && last[4] <= prev[4]) dir = 'SHORT';
    if (!dir || atr <= 0) continue;

    if (useLiveFilters) {
      const adxData = calcADX(highs, lows, closes, 14);
      const rsi = calcRSI(closes, 14);
      if (!adxData.isTrending) continue;
      if (!checkRsiGuard(rsi, dir).ok) continue;
    }

    const entry = last[4];
    const slDist = atr * atrMultSl;
    const sl = dir === 'LONG' ? entry - slDist : entry + slDist;
    const tp = dir === 'LONG' ? entry + slDist * rrTarget : entry - slDist * rrTarget;

    let outcomeR = 0;
    for (let j = i + 1; j < Math.min(candles.length, i + 25); j++) {
      const c = candles[j];
      if (dir === 'LONG') {
        if (c[3] <= sl) { outcomeR = -1; i = j; break; }
        if (c[2] >= tp) { outcomeR = rrTarget; i = j; break; }
      } else {
        if (c[2] >= sl) { outcomeR = -1; i = j; break; }
        if (c[3] <= tp) { outcomeR = rrTarget; i = j; break; }
      }
    }
    if (outcomeR === 0) continue;
    const feeR = (entry * feeSlippagePct) / Math.max(1e-8, slDist);
    const netR = outcomeR - feeR;
    trades.push(netR);
    equity *= (1 + netR * 0.02);
    if (equity > peak) peak = equity;
    const dd = ((peak - equity) / peak) * 100;
    if (dd > maxDrawdownPct) maxDrawdownPct = dd;
  }

  const sampleCount = trades.length;
  const wins = trades.filter(x => x > 0);
  const losses = trades.filter(x => x <= 0);
  const winRate = sampleCount ? +((wins.length / sampleCount) * 100).toFixed(2) : 0;
  const grossProfit = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  const profitFactor = grossLoss > 0 ? +(grossProfit / grossLoss).toFixed(2) : (grossProfit > 0 ? 99 : 0);
  const expectancyR = sampleCount ? +(trades.reduce((a, b) => a + b, 0) / sampleCount).toFixed(3) : 0;

  return {
    ok: true,
    sampleCount,
    winRate,
    expectancyR,
    profitFactor,
    maxDrawdownPct: +maxDrawdownPct.toFixed(2),
    feeSlippagePct: +(feeSlippagePct * 100).toFixed(3),
    enabled: sampleCount >= 10 && expectancyR > 0.1 && profitFactor >= 1.25
  };
}

// v8.3: Zero-Leakage Walk-Forward Validation (70% In-Sample / 30% Out-of-Sample)
// Out-of-sample warms up indicators on prior bars but ONLY evaluates trades strictly at index >= split.
function runWalkForward(candles, opts = {}) {
  if (!Array.isArray(candles) || candles.length < 100) {
    return { ok: false, errorCode: 'INSUFFICIENT_WF_DATA', enabled: false };
  }
  const split = Math.floor(candles.length * 0.7);
  const inSample = runBacktest(candles.slice(0, split), { ...opts, startIndex: 52 });
  const outOfSample = runBacktest(candles, { ...opts, startIndex: split });
  const enabled = Boolean(inSample.enabled && outOfSample.ok && outOfSample.sampleCount >= 5 && outOfSample.expectancyR > 0);
  return { ok: true, splitIndex: split, leakageFree: true, inSample, outOfSample, enabled };
}

module.exports = {
  buildDeterministicExplanation,
  runBacktest,
  runWalkForward
};
