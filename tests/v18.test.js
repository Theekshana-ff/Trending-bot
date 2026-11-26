import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSafeOrderPlan, previewMarginLeverageMath, calcRSI, calcEMA } from '../lib/strategyV18.js';
import { checkRiskShields } from '../lib/riskGuardian.js';

test('FAST mode scales TP% and caps SL% dynamically from Margin x Leverage', () => {
  const plan = buildSafeOrderPlan({
    mode: 'FAST',
    direction: 'LONG',
    price: 100,
    marginUsdt: 2.0,
    leverage: 12,
    targetNetUsdt: 0.10,
    maxLossPerTradeUsdt: 0.14,
    atrPct: 0.18,
    minOrderQty: 0.01,
    qtyStep: 0.01,
    tickSize: 0.01,
    minNotional: 5.0,
  });

  assert.equal(plan.ok, true);
  assert.ok(plan.params.netTpUsdt >= 0.095);
  assert.ok(plan.params.effectiveTpPct < 0.60);
  assert.ok(plan.params.netSlUsdt <= 0.16);
});

test('SAFE mode enforces positive Net Risk:Reward after fees', () => {
  const plan = buildSafeOrderPlan({
    mode: 'SAFE',
    direction: 'SHORT',
    price: 100,
    marginUsdt: 2.0,
    leverage: 5,
    stopLossPct: 0.65,
    takeProfitPct: 1.25,
    atrPct: 0.25,
    minOrderQty: 0.01,
    qtyStep: 0.01,
    tickSize: 0.01,
    minNotional: 5.0,
    minNetRR: 1.5,
  });

  assert.equal(plan.ok, true);
  assert.ok(plan.params.netRR >= 1.5);
});

test('previewMarginLeverageMath calculates speed accurately', () => {
  const slow = previewMarginLeverageMath({ mode: 'FAST', marginUsdt: 2, leverage: 5, targetNetUsdt: 0.10 });
  const fast = previewMarginLeverageMath({ mode: 'FAST', marginUsdt: 2, leverage: 12, targetNetUsdt: 0.10 });
  assert.ok(slow.requiredTpPct > 1.0);
  assert.ok(fast.requiredTpPct < 0.6);
});

test('checkRiskShields blocks trading after daily loss or 2 consecutive losses', () => {
  const cfg = { maxDailyLossUsdt: 0.5, maxConsecutiveLosses: 2 };
  assert.equal(checkRiskShields({ netPnl: -0.52, consecLosses: 1 }, cfg).allowed, false);
  assert.equal(checkRiskShields({ netPnl: -0.20, consecLosses: 2 }, cfg).allowed, false);
  assert.equal(checkRiskShields({ netPnl: 0.15, consecLosses: 0 }, cfg).allowed, true);
});

test('EMA and RSI return valid outputs', () => {
  const series = Array.from({ length: 30 }, (_, i) => 100 + i * 0.5);
  assert.equal(calcEMA(series, 9).length, 30);
  assert.ok(calcRSI(series, 14) > 80);
});
