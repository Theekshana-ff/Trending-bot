// File: tests/run-tests.js (v16.0 — SV ULTRA PRO Automated Tests)
const assert = require('assert');
const svEngine = require('../lib/modules/svScalpEngine');
const { calcEMA, calcRSI, calcWilderATR } = require('../lib/modules/indicators');
const { formatBybitPrice, formatBybitQty, validateSlTpLevels } = require('../lib/modules/riskAndValidation');
const { safeCompareSecret, isAuthBlocked, recordAuthFailure, clearAuthFailures } = require('../lib/modules/securityAndState');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`✅ PASS: ${name}`);
  } catch (err) {
    failed++;
    console.error(`❌ FAIL: ${name} -> ${err.message}`);
  }
}

(async () => {
  await test('v16.0 Default Pro Preset uses $2 margin & 18x leverage for $0.10 net cut', () => {
    const preset = svEngine.getSvPresetConfig({});
    assert.strictEqual(preset.key, 'pro');
    const sz = svEngine.computeSvAutoSizing({
      availBal: 10,
      entryPrice: 150,
      atrPct: 0.12,
      spec: { maxLeverage: 25, minNotionalValue: 5, qtyStep: 0.01, minOrderQty: 0.01 },
      targetUsdt: 0.10,
      preset,
      inRecoveryMode: false
    });
    assert.strictEqual(sz.ok, true);
    assert.strictEqual(sz.leverage, 18);
    assert.ok(sz.notional >= 34 && sz.notional <= 37, `Expected ~$36 notional, got ${sz.notional}`);
  });

  await test('v16.0 Smart Recovery Leverage drops to 10x after a loss', () => {
    const preset = svEngine.SV_PRESETS.pro;
    const sz = svEngine.computeSvAutoSizing({
      availBal: 10,
      entryPrice: 150,
      atrPct: 0.12,
      spec: { maxLeverage: 25, minNotionalValue: 5, qtyStep: 0.01, minOrderQty: 0.01 },
      targetUsdt: 0.10,
      preset,
      inRecoveryMode: true
    });
    assert.strictEqual(sz.ok, true);
    assert.strictEqual(sz.leverage, 10);
  });

  await test('SV Mode defaults ON and respects SV_MODE env overrides', () => {
    delete process.env.SV_MODE;
    assert.strictEqual(svEngine.isSvModeActive({}), true);
    process.env.SV_MODE = 'false';
    assert.strictEqual(svEngine.isSvModeActive({ svMode: true }), false);
    delete process.env.SV_MODE;
  });

  await test('Indicators & Risk formatting work accurately', () => {
    const closes = Array.from({ length: 40 }, (_, i) => 100 + i * 0.5);
    const highs = closes.map(c => c + 0.8);
    const lows = closes.map(c => c - 0.8);
    assert.ok(calcEMA(closes, 9) > calcEMA(closes, 21));
    assert.ok(calcRSI(closes, 7) > 50);
    assert.ok(calcWilderATR(highs, lows, closes, 14) > 0);
    assert.strictEqual(formatBybitPrice(100.12345, 0.01), 100.12);
    assert.strictEqual(formatBybitQty(1.239, 0.01), 1.23);
    assert.strictEqual(validateSlTpLevels({ direction: 'LONG', entry: 100, sl: 99, tp1: 101, tp: 102 }).valid, true);
  });

  await test('Security: safeCompareSecret, isAuthBlocked & clearAuthFailures work', () => {
    assert.strictEqual(safeCompareSecret('abc123', 'abc123'), true);
    assert.strictEqual(safeCompareSecret('abc123', 'wrong'), false);
    const ip = '10.0.0.99';
    clearAuthFailures(ip);
    for (let i = 0; i < 8; i++) recordAuthFailure(ip);
    assert.strictEqual(isAuthBlocked(ip), true);
    clearAuthFailures(ip);
    assert.strictEqual(isAuthBlocked(ip), false);
  });

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
