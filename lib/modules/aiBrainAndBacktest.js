// Modules 16, 17, 18, 19: Historical Backtesting, Walk-Forward Testing, AI Explanation Engine, Strategy Performance Analyzer (H-01, H-02, H-04)
const { calcEMA, calcWilderATR } = require('./indicators');

function buildDeterministicExplanation({
  symbol, direction, decision, mtf, structure, smc, fib, elliott, volVol, levels, risk, noTradeReason
}) {
  const qualityPoints = [];
  let score = 0;

  if (mtf.ok) { score += 30; qualityPoints.push(`MTF aligned ${mtf.agreementPct}%`); }
  else { qualityPoints.push(`MTF conflict (${mtf.agreementPct}%)`); }

  if ((direction === 'LONG' && structure.structure === 'BULLISH_HH_HL') || (direction === 'SHORT' && structure.structure === 'BEARISH_LH_LL')) {
    score += 20; qualityPoints.push(`Structure confirms ${structure.structure}`);
  }
  if (smc.sweep !== 'NONE') { score += 15; qualityPoints.push(`Liquidity event: ${smc.sweep}`); }
  if (smc.fvg !== 'NONE') { score += 10; qualityPoints.push(`Imbalance: ${smc.fvg}`); }
  if (fib.inGoldenPocket) { score += 10; qualityPoints.push(`Price in Fib Golden Pocket (${fib.retracement})`); }
  if (volVol.volumeConfirmed && volVol.regime !== 'EXTREME_VOLATILITY') { score += 15; qualityPoints.push(`Volume ratio ${volVol.volRatio}x (${volVol.regime})`); }

  return {
    symbol,
    decision,
    signalQualityScore: Math.min(100, score),
    marketContext: `${structure.structure} | ${elliott.phase} | Vol: ${volVol.regime}`,
    reasons: qualityPoints,
    rejectionReason: decision === 'NO_TRADE' ? (noTradeReason || 'Deterministic safety gate rejected setup.') : null,
    summary: decision === 'NO_TRADE'
      ? `REJECTED (${score}/100): ${noTradeReason}`
      : `APPROVED ${direction} (${score}/100): ${qualityPoints.join(' · ')} · R:R 1:${levels.rrRatio} · Margin $${risk.requiredMargin}`
  };
}

// Historical Backtesting with fees (0.11% round-trip) + slippage (0.04%)
function runBacktest(candles, { feeSlippagePct = 0.0015, atrMultSl = 1.3, rrTarget = 2.0 } = {}) {
  if (!Array.isArray(candles) || candles.length < 60) {
    return { ok: false, errorCode: 'INSUFFICIENT_HISTORY', sampleCount: 0, enabled: false };
  }
  const trades = [];
  let equity = 100;
  let peak = 100;
  let maxDrawdownPct = 0;

  for (let i = 52; i < candles.length - 5; i++) {
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

// Walk-Forward Validation (70% In-Sample / 30% Out-of-Sample)
function runWalkForward(candles, opts = {}) {
  if (!Array.isArray(candles) || candles.length < 100) {
    return { ok: false, errorCode: 'INSUFFICIENT_WF_DATA', enabled: false };
  }
  const split = Math.floor(candles.length * 0.7);
  const inSample = runBacktest(candles.slice(0, split), opts);
  const outOfSample = runBacktest(candles.slice(split - 55), opts);
  const enabled = Boolean(inSample.enabled && outOfSample.ok && outOfSample.expectancyR > 0);
  return { ok: true, inSample, outOfSample, enabled };
}

module.exports = {
  buildDeterministicExplanation,
  runBacktest,
  runWalkForward
};
