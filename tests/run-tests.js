// File: tests/run-tests.js (v15.0 — SV MODE ONLY Automated Tests)
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
  await test('SV Mode defaults to ON when SV_MODE env is unset', () => {
    delete process.env.SV_MODE;
    assert.strictEqual(svEngine.isSvModeActive({}), true);
  });

  await test('SV Mode respects Vercel SV_MODE=false and SV_MODE=true overrides', () => {
    process.env.SV_MODE = 'false';
    assert.strictEqual(svEngine.isSvModeActive({ svMode: true }), false);
    process.env.SV_MODE = 'true';
    assert.strictEqual(svEngine.isSvModeActive({ svMode: false }), true);
    delete process.env.SV_MODE;
  });

  await test('SV Mode respects Telegram toggle when SV_MODE env is unset', () => {
    delete process.env.SV_MODE;
    assert.strictEqual(svEngine.isSvModeActive({ svMode: false }), false);
    assert.strictEqual(svEngine.isSvModeActive({ svMode: true }), true);
  });

  await test('Indicators: EMA, RSI, and ATR compute valid numbers', () => {
    const closes = Array.from({ length: 40 }, (_, i) => 100 + i * 0.5);
    const highs = closes.map(c => c + 0.8);
    const lows = closes.map(c => c - 0.8);
    assert.ok(calcEMA(closes, 9) > calcEMA(closes, 21));
    assert.ok(calcRSI(closes, 7) > 50);
    assert.ok(calcWilderATR(highs, lows, closes, 14) > 0);
  });

  await test('Risk formatting: price & qty conform to Bybit tickSize and qtyStep', () => {
    assert.strictEqual(formatBybitPrice(100.12345, 0.01), 100.12);
    assert.strictEqual(formatBybitQty(1.239, 0.01), 1.23);
    const chk = validateSlTpLevels({ direction: 'LONG', entry: 100, sl: 99, tp1: 101, tp: 102 });
    assert.strictEqual(chk.valid, true);
  });

  await test('Security: safeCompareSecret & IP brute-force throttling work', () => {
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
