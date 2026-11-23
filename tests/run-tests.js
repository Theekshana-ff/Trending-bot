// Comprehensive Automated Test Suite for Bybit V5 Live Trading Bot v3
const assert = require('assert');
const { validateCandles } = require('../lib/modules/marketData');
const { evaluateMTF, analyzeVolumeVolatility } = require('../lib/modules/indicators');
const { analyzeMarketStructure, analyzeLiquidityAndSMC, analyzeFibonacci } = require('../lib/modules/structureSmc');
const { validateSlTpLevels, computeAndValidateEntry, evaluateLiveRisk } = require('../lib/modules/riskAndValidation');
const { runBacktest, runWalkForward } = require('../lib/modules/aiBrainAndBacktest');
const { validateRequestNonce, acquireLock, releaseLock } = require('../lib/modules/securityAndState');
const handler = require('../api/futures-agent');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`PASS: ${name}`);
    passed++;
  } catch (err) {
    console.error(`FAIL: ${name} -> ${err.message}`);
    failed++;
  }
}

function makeSyntheticCandles(count = 120, startPrice = 100, step = 0.4, endOffsetMs = 0) {
  const now = Date.now() - endOffsetMs;
  const interval = 15 * 60 * 1000;
  const arr = [];
  let p = startPrice;
  for (let i = 0; i < count; i++) {
    const ts = now - (count - i) * interval;
    const o = p;
    const c = p + step;
    const h = Math.max(o, c) + Math.abs(step) * 0.5 + 0.2;
    const l = Math.min(o, c) - Math.abs(step) * 0.5 - 0.2;
    arr.push([ts, o, h, l, c, 1000 + i * 5]);
    p = c;
  }
  return arr;
}

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(j) { this.body = j; return this; }
  };
}

(async () => {
  await test('H-07: Rejects stale market candles', () => {
    const stale = makeSyntheticCandles(40, 100, 0.2, 6 * 60 * 60 * 1000);
    const res = validateCandles(stale, '15m');
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.errorCode, 'STALE_MARKET_DATA');
  });

  await test('H-07: Rejects NaN OHLCV candles', () => {
    const c = makeSyntheticCandles(30, 100, 0.2);
    c[10][4] = NaN;
    const res = validateCandles(c, '15m');
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.errorCode, 'NAN_OHLCV');
  });

  await test('H-06: Validates LONG and SHORT SL/TP bounds and rejects inverted levels', () => {
    assert.strictEqual(validateSlTpLevels({ direction: 'LONG', entry: 100, sl: 98, tp1: 103, tp: 112 }).valid, true);
    assert.strictEqual(validateSlTpLevels({ direction: 'SHORT', entry: 100, sl: 102, tp1: 97, tp: 88 }).valid, true);
    assert.strictEqual(validateSlTpLevels({ direction: 'LONG', entry: 100, sl: 102, tp1: 103, tp: 112 }).valid, false);
    assert.strictEqual(validateSlTpLevels({ direction: 'SHORT', entry: 100, sl: 98, tp1: 97, tp: 88 }).valid, false);
    assert.strictEqual(validateSlTpLevels({ direction: 'LONG', entry: 100, sl: NaN, tp1: 103, tp: 112 }).valid, false);
  });

  await test('H-08: Risk Manager rejects zero balance, max positions, and consecutive-loss cooldown', () => {
    const r0 = evaluateLiveRisk({ availBal: 0, entryPrice: 100, slPrice: 98, qtyStep: 0.1, minOrderQty: 0.1, maxOrderQty: 1000 });
    assert.strictEqual(r0.approved, false);
    const rPos = evaluateLiveRisk({ availBal: 500, entryPrice: 100, slPrice: 98, qtyStep: 0.1, minOrderQty: 0.1, maxOrderQty: 1000, openPositionsCount: 3, maxOpenPositions: 3 });
    assert.strictEqual(rPos.errorCode, 'MAX_POSITIONS_REACHED');
    const rLoss = evaluateLiveRisk({ availBal: 500, entryPrice: 100, slPrice: 98, qtyStep: 0.1, minOrderQty: 0.1, maxOrderQty: 1000, consecutiveLosses: 3 });
    assert.strictEqual(rLoss.errorCode, 'COOLDOWN_ACTIVE');
    const rOk = evaluateLiveRisk({ availBal: 500, entryPrice: 100, slPrice: 98, qtyStep: 0.1, minOrderQty: 0.1, maxOrderQty: 1000 });
    assert.strictEqual(rOk.approved, true);
    assert.ok(rOk.orderQty >= 0.1);
  });

  await test('C-04: Nonce replay protection rejects duplicate nonce', async () => {
    const nonce = 'testnonce12345';
    const ts = String(Date.now());
    const first = await validateRequestNonce(nonce, ts, true);
    const second = await validateRequestNonce(nonce, ts, true);
    assert.strictEqual(first.valid, true);
    assert.strictEqual(second.valid, false);
    assert.strictEqual(second.errorCode, 'NONCE_REPLAY');
  });

  await test('C-04: Execution lock blocks concurrent caller until released', async () => {
    const l1 = await acquireLock('test_lock_1', 5000);
    const l2 = await acquireLock('test_lock_1', 5000);
    assert.strictEqual(l1.acquired, true);
    assert.strictEqual(l2.acquired, false);
    await releaseLock('test_lock_1', l1.token);
    const l3 = await acquireLock('test_lock_1', 5000);
    assert.strictEqual(l3.acquired, true);
    await releaseLock('test_lock_1', l3.token);
  });

  await test('C-07 & M-02: API rejects unsupported actions and query-string secrets', async () => {
    process.env.AGENT_SECRET = 'unit_test_secret';
    const res1 = mockRes();
    await handler({ method: 'POST', headers: { 'x-agent-secret': 'unit_test_secret' }, body: { action: 'fake_action_xyz' } }, res1);
    assert.strictEqual(res1.statusCode, 400);
    assert.strictEqual(res1.body.errorCode, 'UNSUPPORTED_ACTION');

    const res2 = mockRes();
    await handler({ method: 'GET', headers: {}, query: { action: 'health', secret: 'leaked' } }, res2);
    assert.strictEqual(res2.statusCode, 400);
    assert.strictEqual(res2.body.errorCode, 'QUERY_SECRET_FORBIDDEN');
  });

  await test('C-01: Live scan_and_trade rejects missing ALLOW_LIVE_TRADING and missing liveConfirmed', async () => {
    process.env.AGENT_SECRET = 'unit_test_secret';
    process.env.ALLOW_LIVE_TRADING = 'false';
    const res = mockRes();
    await handler({
      method: 'POST',
      headers: { 'x-agent-secret': 'unit_test_secret', 'x-request-nonce': 'nonce_abc_1111', 'x-request-ts': String(Date.now()) },
      body: { action: 'scan_and_trade', liveConfirmed: true }
    }, res);
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.body.errorCode, 'LIVE_GATE_LOCKED');
  });

  await test('Modules 02-19: MTF, Structure, SMC, Fib, Backtest & Walk-Forward run cleanly', () => {
    const c = makeSyntheticCandles(160, 100, 0.3);
    const closes = c.map(x => x[4]);
    const mtf = evaluateMTF({ closes1d: closes, closes4h: closes, closes1h: closes, closes15m: closes, closes5m: closes });
    assert.strictEqual(mtf.decision, 'LONG');
    const st = analyzeMarketStructure(c);
    assert.strictEqual(st.ok, true);
    const smc = analyzeLiquidityAndSMC(c, st);
    assert.strictEqual(smc.ok, true);
    const fib = analyzeFibonacci(c);
    assert.strictEqual(fib.ok, true);
    const vol = analyzeVolumeVolatility(c);
    assert.strictEqual(vol.ok, true);
    const entry = computeAndValidateEntry({ closedCandles: c, livePrice: closes[closes.length - 1], direction: 'LONG', tickSize: 0.01, atr: vol.atr, spreadPct: 0.02 });
    assert.strictEqual(entry.valid, true);
    const bt = runBacktest(c);
    assert.strictEqual(bt.ok, true);
    const wf = runWalkForward(c);
    assert.strictEqual(wf.ok, true);
  });

  console.log(`\nSUMMARY: ${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);

  await test('v6: ADX, RSI Guard, S/R Proximity, OI Squeeze & Pullback Limit Entry', () => {
    const { calcADX, checkRsiGuard } = require('../lib/modules/indicators');
    const { checkSrProximity, detectChartPatterns, analyzeMarketStructure } = require('../lib/modules/structureSmc');
    const { checkOiFundingSqueeze } = require('../lib/modules/riskAndValidation');

    const c = makeSyntheticCandles(60, 100, 0.5);
    const adx = calcADX(c.map(x => x[2]), c.map(x => x[3]), c.map(x => x[4]), 14);
    assert.ok(Number.isFinite(adx.adx));
    assert.strictEqual(checkRsiGuard(78, 'LONG').ok, false);
    assert.strictEqual(checkRsiGuard(22, 'SHORT').ok, false);
    assert.strictEqual(checkRsiGuard(55, 'LONG').ok, true);
    assert.strictEqual(checkSrProximity(100, 'LONG', [95], [100.2]).ok, false);
    assert.strictEqual(checkOiFundingSqueeze({ direction: 'LONG', fundingRate: 0.0008, oiChangePct: 5 }).ok, false);
    const st = analyzeMarketStructure(c);
    const pat = detectChartPatterns(c, st);
    assert.ok(typeof pat.pattern === 'string');
  });

  await test('v6: Daily Max Loss & Profit Lock', async () => {
    const { checkDailyGuard } = require('../lib/modules/securityAndState');
    const g1 = await checkDailyGuard(1000, { maxDailyLossPct: 5, dailyProfitTargetPct: 10 });
    assert.strictEqual(g1.locked, false);
    const gLoss = await checkDailyGuard(940, { maxDailyLossPct: 5, dailyProfitTargetPct: 10 });
    assert.strictEqual(gLoss.locked, true);
    assert.strictEqual(gLoss.errorCode, 'DAILY_LOSS_LOCK');
    const gProfit = await checkDailyGuard(1120, { maxDailyLossPct: 5, dailyProfitTargetPct: 10 });
    assert.strictEqual(gProfit.locked, true);
    assert.strictEqual(gProfit.errorCode, 'DAILY_PROFIT_LOCK');
  });

  await test('v8.2: Coin-Specific Live News FUD/Hack Auto-VETO Guard', () => {
    const { extractBaseCoin, detectCriticalNewsFud } = require('../lib/modules/aiAgent');
    assert.strictEqual(extractBaseCoin('SOLUSDT'), 'SOL');
    assert.strictEqual(extractBaseCoin('1000PEPEUSDT'), 'PEPE');

    const badNews = detectCriticalNewsFud({
      symbol: 'SOLUSDT',
      headlines: [{ title: 'Breaking: Major SOL protocol hit by $50M exploit and drained', scope: 'COIN' }]
    });
    assert.strictEqual(badNews.veto, true);

    const safeNews = detectCriticalNewsFud({
      symbol: 'SOLUSDT',
      headlines: [{ title: 'Solana DeFi TVL climbs 12% amid strong network activity', scope: 'COIN' }]
    });
    assert.strictEqual(safeNews.veto, false);
  });

  await test('v8.3: Daily Risk Guard fails closed when equity unavailable in strict mode', async () => {
    const { checkDailyGuard, sanitizeErrorForClient } = require('../lib/modules/securityAndState');
    const gStrict = await checkDailyGuard(0, { maxDailyLossPct: 5, dailyProfitTargetPct: 10, strict: true });
    assert.strictEqual(gStrict.locked, true);
    assert.strictEqual(gStrict.errorCode, 'DAILY_GUARD_EQUITY_UNAVAILABLE');
    const cleaned = sanitizeErrorForClient(new Error('Failed with key gsk_1234567890abcdef'));
    assert.ok(!cleaned.includes('gsk_1234567890abcdef'));
  });

  await test('v8.3: Duplicate Exposure & Open Orders API failure blocks new order', () => {
    const { checkDuplicateExposure } = require('../lib/modules/bybitLiveClient');
    const unverified = checkDuplicateExposure('SOLUSDT', { openOrdersVerified: false, openOrdersError: 'timeout', positions: [], openOrders: [] });
    assert.strictEqual(unverified.blocked, true);
    assert.strictEqual(unverified.errorCode, 'OPEN_ORDERS_UNVERIFIED');

    const dupPos = checkDuplicateExposure('SOLUSDT', { openOrdersVerified: true, positions: [{ symbol: 'SOLUSDT', size: '1' }], openOrders: [] });
    assert.strictEqual(dupPos.blocked, true);
    assert.strictEqual(dupPos.errorCode, 'DUPLICATE_POSITION');

    const dupOrd = checkDuplicateExposure('SOLUSDT', { openOrdersVerified: true, positions: [], openOrders: [{ symbol: 'SOLUSDT' }] });
    assert.strictEqual(dupOrd.blocked, true);
    assert.strictEqual(dupOrd.errorCode, 'DUPLICATE_ORDER');
  });

  await test('v8.3: False Breakout Trap Detection & Zero-Leakage Walk-Forward', () => {
    const { detectFalseBreakout } = require('../lib/modules/structureSmc');
    const trapCandles = [[1, 100, 101, 99, 100, 100], [2, 100, 101, 99, 100, 100], [3, 100, 101, 99, 100, 100], [4, 100, 101, 99, 100, 100], [5, 100, 102.5, 99.5, 100.5, 200]];
    const bullTrap = detectFalseBreakout(trapCandles, { resistance: 101, support: 95 }, 'LONG');
    assert.strictEqual(bullTrap.isTrap, true);

    const wf = runWalkForward(makeSyntheticCandles(160, 100, 0.3));
    assert.strictEqual(wf.ok, true);
    assert.strictEqual(wf.leakageFree, true);
  });

  await test('v8.3.1: Manual & Auto Leverage respects the lowered caps (auto 3x-10x, hard cap 8x)', () => {
    const { computeAutoLeverage } = require('../lib/modules/riskAndValidation');
    assert.strictEqual(computeAutoLeverage({ atrPct: 2.0, signalQualityScore: 70, maxLeverage: 20 }), 3);
    assert.strictEqual(computeAutoLeverage({ atrPct: 0.3, signalQualityScore: 85, maxLeverage: 20 }), 10);
    const rMan = evaluateLiveRisk({ availBal: 500, entryPrice: 100, slPrice: 98, qtyStep: 0.1, minOrderQty: 0.1, maxOrderQty: 1000, autoLeverage: false, leverage: 15 });
    assert.strictEqual(rMan.approved, true);
    assert.strictEqual(rMan.leverage, 8); // manual 15x is now capped by MAX_LEVERAGE_CAP (default 8)
  });

  await test('v8.3.2: Auto Wallet % Mode (10%-100%) sizes margin with Auto-Leverage', async () => {
    const { setAutoWalletAlloc, getAutoWalletAlloc } = require('../lib/modules/securityAndState');
    const saved = await setAutoWalletAlloc({ enabled: true, pct: 50 });
    assert.strictEqual(saved.enabled, true);
    assert.strictEqual(saved.pct, 50);
    const loaded = await getAutoWalletAlloc();
    assert.strictEqual(loaded.enabled, true);
    assert.strictEqual(loaded.pct, 50);

    const r50 = evaluateLiveRisk({
      availBal: 100, entryPrice: 100, slPrice: 98, qtyStep: 0.1, minOrderQty: 0.1, maxOrderQty: 1000,
      autoLeverage: true, atrPct: 0.8, signalQualityScore: 80, walletAllocEnabled: true, walletAllocPct: 0.50
    });
    assert.strictEqual(r50.approved, true);
    assert.strictEqual(r50.walletAllocUsed, true);
    assert.strictEqual(r50.walletAllocPct, 50);
    assert.ok(r50.requiredMargin > 0 && r50.requiredMargin <= 51);
    assert.ok(r50.maxRiskUsdt <= 2.05, 'Wallet % mode must still respect the 2% risk budget');
  });

  await test('v9.0: Session, Liquidation, Correlation, Funding Countdown & Coin Analytics', async () => {
    const { checkTradingSession, checkLiquidationSafety, checkCorrelationGuard, checkFundingCountdownGuard, computeCoinAnalytics } = require('../lib/modules/advancedGuards');
    const { setBotFilters, getBotFilters } = require('../lib/modules/securityAndState');

    // Weekend check (2026-11-21 is Saturday UTC)
    const sat = Date.UTC(2026, 10, 21, 12, 0, 0);
    assert.strictEqual(checkTradingSession({ nowMs: sat, blockWeekend: true }).ok, false);

    // Liquidation check: 20x leverage (~4.5% liq), 6% SL must fail
    assert.strictEqual(checkLiquidationSafety({ entryPrice: 100, slPrice: 94, leverage: 20, direction: 'LONG' }).ok, false);
    assert.strictEqual(checkLiquidationSafety({ entryPrice: 100, slPrice: 98, leverage: 10, direction: 'LONG' }).ok, true);

    // Correlation guard
    const corr = checkCorrelationGuard({
      symbol: 'AVAXUSDT', direction: 'LONG',
      openPositions: [{ symbol: 'SOLUSDT', side: 'Buy' }, { symbol: 'SUIUSDT', side: 'Buy' }]
    });
    assert.strictEqual(corr.ok, false);

    // Funding countdown (07:50 UTC -> 10m before 08:00 UTC)
    const preFund = Date.UTC(2026, 10, 20, 7, 50, 0);
    assert.strictEqual(checkFundingCountdownGuard({ direction: 'LONG', fundingRate: 0.0005, nowMs: preFund }).ok, false);

    // Coin Analytics & Filters
    const ca = computeCoinAnalytics([{ symbol: 'SOLUSDT', closedPnl: 5 }, { symbol: 'SOLUSDT', closedPnl: -1 }]);
    assert.strictEqual(ca[0].symbol, 'SOLUSDT');
    assert.strictEqual(ca[0].winRate, 50);

    const fSaved = await setBotFilters({ whitelist: 'SOL,BTC', blacklist: 'DOGE', blockWeekend: true, sessionOnly: true });
    assert.deepStrictEqual(fSaved.whitelist, ['SOL', 'BTC']);
    const fLoaded = await getBotFilters();
    assert.strictEqual(fLoaded.blockWeekend, true);
  });

  await test('v10.0: VWAP, Divergence, OBI, Squeeze, Flash Crash, Self-Learning, Macro & Regime', async () => {
    const {
      calcVWAP, checkVwapFilter, detectDivergence, evaluateOrderBookImbalance,
      checkBtcDominanceFilter, calcChandelierTrail, detectVolatilitySqueeze,
      detectFlashCrash, evaluateSelfLearningCoin, checkMacroCalendarGuard, selectStrategyRegime
    } = require('../lib/modules/profitEngine');
    const { recordSlippage, getSlippageStats, tripCircuitBreaker, getCircuitBreaker } = require('../lib/modules/securityAndState');

    const c = makeSyntheticCandles(60, 100, 0.4);
    const vwap = calcVWAP(c, 48);
    assert.ok(vwap > 0);
    assert.strictEqual(checkVwapFilter(vwap * 0.98, vwap, 'LONG').ok, false);
    assert.strictEqual(checkVwapFilter(vwap * 1.02, vwap, 'LONG').ok, true);

    const div = detectDivergence(c);
    assert.ok(typeof div.type === 'string');

    assert.strictEqual(evaluateOrderBookImbalance({ ok: true, obi: -0.6 }, 'LONG').ok, false);
    assert.strictEqual(evaluateOrderBookImbalance({ ok: true, obi: 0.3 }, 'LONG').scoreBonus, 6);

    assert.strictEqual(checkBtcDominanceFilter({ coin: 'SOL', direction: 'LONG', btcDom: { ok: true, dominance: 63, delta: 0.4 }, btcTrend: 'BEAR' }).ok, false);

    const trail = calcChandelierTrail({ atr: 1.5, entryPrice: 100, multiplier: 2.0 });
    assert.strictEqual(trail, 3.0);

    const sq = detectVolatilitySqueeze(c, 20);
    assert.ok(typeof sq.inSqueeze === 'boolean');

    const crash = detectFlashCrash([[1, 100, 100, 96.5, 97, 500], [2, 100, 100, 96.5, 97, 500]], 2.5);
    assert.strictEqual(crash.triggered, true);

    await tripCircuitBreaker('Test crash', 5);
    assert.strictEqual((await getCircuitBreaker()).active, true);

    const slBlock = evaluateSelfLearningCoin('BADUSDT', [
      { symbol: 'BADUSDT', closedPnl: -2 }, { symbol: 'BADUSDT', closedPnl: -3 },
      { symbol: 'BADUSDT', closedPnl: -1 }, { symbol: 'BADUSDT', closedPnl: 0.5 }
    ]);
    assert.strictEqual(slBlock.ok, false);

    const now = Date.UTC(2026, 10, 21, 14, 0, 0);
    assert.strictEqual(checkMacroCalendarGuard({ nowMs: now, windowMinutes: 30, rawWindows: 'CPI|2026-11-21T14:15:00Z' }).ok, false);

    const reg = selectStrategyRegime({ adx: 16, rsi: 30, price: 100, supportLevels: [99.5], resistanceLevels: [110] });
    assert.strictEqual(reg.regime, 'MEAN_REVERSION');
    assert.strictEqual(reg.mrDirection, 'LONG');

    await recordSlippage('SOLUSDT', 100, 100.1);
    const slip = await getSlippageStats('SOLUSDT');
    assert.strictEqual(slip.count, 1);
  });

  console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
