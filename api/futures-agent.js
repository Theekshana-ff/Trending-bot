// api/futures-agent.js — Drop-in v18.1 Core Engine (Compatible with Old autopilot.yml & Dashboard)
import { BybitClient } from '../lib/bybitClient.js';
import { StateStore, isAuthorizedRequest, loadRuntimeConfig, clamp } from '../lib/securityAndState.js';
import {
  parseCandles,
  getBtcRegime,
  evaluateCoinSetup,
  buildSafeOrderPlan,
  previewMarginLeverageMath,
} from '../lib/strategyV18.js';
import {
  syncExchangeClosedPnl,
  checkRiskShields,
  isCoinBlocked,
  setCoinCooldown,
  protectOpenPosition,
  recordEquityPoint,
  getEquityCurve,
} from '../lib/riskGuardian.js';
import { sendTelegram, buildPositionButtons } from '../lib/telegram.js';

export async function fetchAccountSnapshot(bybit) {
  const [walletRes, posRes] = await Promise.all([
    bybit.getWalletBalance(),
    bybit.getPositions(),
  ]);

  const acct = walletRes?.result?.list?.[0] || {};
  const usdtCoin = (acct.coin || []).find((c) => c.coin === 'USDT') || {};
  const equity = Number(acct.totalEquity || usdtCoin.equity || 0);
  const available = Number(acct.totalAvailableBalance || usdtCoin.availableToWithdraw || 0);

  const openPositions = (posRes?.result?.list || [])
    .filter((p) => Number(p.size) > 0)
    .map((p) => ({
      symbol: p.symbol,
      side: p.side,
      size: Number(p.size),
      leverage: p.leverage,
      avgPrice: Number(p.avgPrice),
      markPrice: Number(p.markPrice),
      unrealisedPnl: Number(p.unrealisedPnl || 0),
      takeProfit: Number(p.takeProfit || 0),
      stopLoss: Number(p.stopLoss || 0),
    }));

  const totalUnrealized = openPositions.reduce((s, p) => s + p.unrealisedPnl, 0);
  return { equity, available, openPositions, totalUnrealized };
}

export async function scanMarket(bybit, config) {
  const btc15Res = await bybit.getKlines('BTCUSDT', '15', 60);
  const btcRegime = getBtcRegime(parseCandles(btc15Res?.result?.list || []));
  const entryInterval = config.tradeMode === 'FAST' ? '3' : '5';

  const results = await Promise.all(
    config.coins.map(async (symbol) => {
      try {
        const [k15, kFast, ob] = await Promise.all([
          bybit.getKlines(symbol, '15', 70),
          bybit.getKlines(symbol, entryInterval, 50),
          bybit.getOrderbook(symbol, 1),
        ]);
        const bestBid = Number(ob?.result?.b?.[0]?.[0] || 0);
        const bestAsk = Number(ob?.result?.a?.[0]?.[0] || 0);
        const spreadPct = bestBid > 0 ? ((bestAsk - bestBid) / bestBid) * 100 : 99;

        return evaluateCoinSetup({
          symbol,
          mode: config.tradeMode,
          candles15m: parseCandles(k15?.result?.list || []),
          candlesFast: parseCandles(kFast?.result?.list || []),
          spreadPct,
          btcRegime,
          maxSpreadPct: config.maxSpreadPct,
        });
      } catch (err) {
        return { symbol, direction: 'WAIT', score: 0, status: 'ERR', error: err.message, price: 0, spreadPct: 0 };
      }
    })
  );

  results.sort((a, b) => b.score - a.score);
  return { btcRegime, heatmap: results, entryInterval };
}

export async function closePositionMarket(bybit, pos) {
  const closeSide = pos.side === 'Buy' ? 'Sell' : 'Buy';
  await bybit.cancelAllOrders(pos.symbol).catch(() => {});
  return bybit.submitOrder({
    symbol: pos.symbol,
    side: closeSide,
    orderType: 'Market',
    qty: pos.size,
    reduceOnly: true,
  });
}

export async function executeGuardianCycle(bybit, store, config) {
  const account = await fetchAccountSnapshot(bybit);
  const stats = await syncExchangeClosedPnl(bybit, store);
  await recordEquityPoint(store, account.equity);

  if (account.openPositions.length > 0) {
    const active = account.openPositions[0];
    const protectRes = await protectOpenPosition(bybit, store, active);
    if (protectRes.action === 'MOVED_SL_TO_BE') {
      await sendTelegram(
        `🔒 <b>Auto Breakeven Activated</b>
${active.symbol} SL moved to $${protectRes.bePrice} (${protectRes.progressPct}% to TP)`
      );
    }
    return {
      ok: true,
      status: 'MANAGING_OPEN_POSITION',
      tradeMode: config.tradeMode,
      position: active,
      protectRes,
      stats,
    };
  }

  if (config.paused) {
    return { ok: true, status: 'PAUSED_OR_SV_OFF', stats };
  }

  const shield = checkRiskShields(stats, config);
  if (!shield.allowed) {
    return { ok: true, status: 'SHIELD_BLOCKED', reason: shield.reason, stats };
  }

  if (account.available < config.marginUsdt) {
    return {
      ok: true,
      status: 'INSUFFICIENT_BALANCE',
      available: account.available,
      required: config.marginUsdt,
    };
  }

  const { btcRegime, heatmap } = await scanMarket(bybit, config);
  const readyCoins = heatmap.filter((c) => c.status === 'READY');

  const skippedReasons = [];
  for (const candidate of readyCoins) {
    const block = await isCoinBlocked(store, candidate.symbol);
    if (block.blocked) {
      skippedReasons.push(`${candidate.symbol}: ${block.reason}`);
      continue;
    }

    const instRes = await bybit.getInstrumentInfo(candidate.symbol);
    const inst = instRes?.result?.list?.[0];
    if (!inst) continue;

    const plan = buildSafeOrderPlan({
      mode: config.tradeMode,
      direction: candidate.direction,
      price: candidate.price,
      marginUsdt: config.marginUsdt,
      leverage: config.leverage,
      targetNetUsdt: config.targetNetUsdt,
      maxLossPerTradeUsdt: config.maxLossPerTradeUsdt,
      stopLossPct: config.stopLossPct,
      takeProfitPct: config.takeProfitPct,
      atrPct: candidate.atrPct,
      minOrderQty: Number(inst.lotSizeFilter?.minOrderQty || 0.1),
      qtyStep: Number(inst.lotSizeFilter?.qtyStep || 0.1),
      tickSize: Number(inst.priceFilter?.tickSize || 0.0001),
      minNotional: Number(inst.lotSizeFilter?.minNotionalValue || 5.0),
      minNetRR: config.minNetRR,
    });

    if (!plan.ok) {
      skippedReasons.push(`${candidate.symbol}: ${plan.reason}`);
      continue;
    }

    await bybit.setLeverage(candidate.symbol, config.leverage);
    const orderRes = await bybit.submitOrder({
      symbol: candidate.symbol,
      side: plan.params.side,
      orderType: 'Market',
      qty: plan.params.qty,
      takeProfit: plan.params.takeProfit,
      stopLoss: plan.params.stopLoss,
    });

    await setCoinCooldown(store, candidate.symbol, config.cooldownMinutes);

    const envTag = config.testnet ? '🧪 TESTNET' : '🔴 LIVE';
    const modeIcon = config.tradeMode === 'FAST' ? '⚡ FAST' : '🛡️ SAFE';
    await sendTelegram(
      `${envTag} | ${modeIcon} <b>${candidate.direction} OPENED</b>
` +
      `Coin: <b>${candidate.symbol}</b> ($${config.marginUsdt} × ${config.leverage}x = $${plan.params.notional})
` +
      `Entry: $${plan.params.entryPrice} | Qty: ${plan.params.qty}
` +
      `🎯 TP: $${plan.params.takeProfit} (+${plan.params.effectiveTpPct}% | <b>+$${plan.params.netTpUsdt} net</b>)
` +
      `🛡️ SL: $${plan.params.stopLoss} (-${plan.params.effectiveSlPct}% | -$${plan.params.netSlUsdt} net)
` +
      `💸 Est Fees: $${plan.params.estFeesUsdt} (${plan.params.feeRatioPct}%) | Score: ${candidate.score}/100`,
      buildPositionButtons(candidate.symbol)
    );

    return {
      ok: true,
      status: 'TRADE_OPENED',
      tradeMode: config.tradeMode,
      candidate,
      plan: plan.params,
      orderId: orderRes?.result?.orderId,
      btcRegime,
    };
  }

  return {
    ok: true,
    status: 'NO_VALID_SETUP',
    tradeMode: config.tradeMode,
    btcRegime,
    skippedReasons,
    topCandidate: heatmap[0] || null,
    stats,
  };
}

export default async function handler(req, res) {
  const store = new StateStore();
  const config = await loadRuntimeConfig(store);
  const body = req.body || {};
  const action = req.query?.action || body?.action || 'status';

  if (action === 'health') {
    return res.status(200).json({
      ok: true,
      version: 'v18.1-dropin',
      tradeMode: config.tradeMode,
      svModeOn: config.svModeOn,
      mode: config.testnet ? 'TESTNET_DEMO' : 'MAINNET_LIVE',
      timestamp: new Date().toISOString(),
    });
  }

  if (!isAuthorizedRequest(req, body)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  const bybit = new BybitClient({
    apiKey: process.env.BYBIT_API_KEY,
    apiSecret: process.env.BYBIT_API_SECRET,
    testnet: config.testnet,
  });

  try {
    if (action === 'update_settings') {
      const prev = (await store.getJson('v18:settings')) || {};
      const nextMode =
        String(body.tradeMode || prev.tradeMode || config.tradeMode).toUpperCase() === 'SAFE'
          ? 'SAFE'
          : 'FAST';
      const maxLev = nextMode === 'FAST' ? 18 : 10;

      const updated = {
        tradeMode: nextMode,
        marginUsdt: clamp(Number(body.marginUsdt ?? config.marginUsdt), 1.0, 500),
        leverage: clamp(Math.round(Number(body.leverage ?? config.leverage)), 2, maxLev),
        targetNetUsdt: clamp(Number(body.targetNetUsdt ?? config.targetNetUsdt), 0.05, 50),
        maxLossPerTradeUsdt: clamp(Number(body.maxLossPerTradeUsdt ?? config.maxLossPerTradeUsdt), 0.06, 50),
        maxDailyLossUsdt: clamp(Number(body.maxDailyLossUsdt ?? config.maxDailyLossUsdt), 0.15, 100),
      };
      await store.setJson('v18:settings', updated);
      return res.status(200).json({
        ok: true,
        message: `Saved ${updated.tradeMode} ($${updated.marginUsdt} × ${updated.leverage}x)`,
        settings: updated,
      });
    }

    if (action === 'status' || action === 'sv_status') {
      const [account, stats, market, equityCurve] = await Promise.all([
        fetchAccountSnapshot(bybit),
        syncExchangeClosedPnl(bybit, store),
        scanMarket(bybit, config),
        getEquityCurve(store),
      ]);
      const shield = checkRiskShields(stats, config);
      const mathPreview = previewMarginLeverageMath({
        mode: config.tradeMode,
        marginUsdt: config.marginUsdt,
        leverage: config.leverage,
        targetNetUsdt: config.targetNetUsdt,
        maxLossPerTradeUsdt: config.maxLossPerTradeUsdt,
        safeStopLossPct: config.stopLossPct,
        safeTakeProfitPct: config.takeProfitPct,
      });

      return res.status(200).json({
        ok: true,
        version: 'v18.1-dropin',
        mode: config.testnet ? 'TESTNET' : 'LIVE',
        tradeMode: config.tradeMode,
        svModeOn: config.svModeOn,
        entryTimeframe: `${market.entryInterval}m`,
        paused: config.paused,
        config: {
          tradeMode: config.tradeMode,
          marginUsdt: config.marginUsdt,
          leverage: config.leverage,
          targetNetUsdt: config.targetNetUsdt,
          maxLossPerTradeUsdt: config.maxLossPerTradeUsdt,
          maxDailyLossUsdt: config.maxDailyLossUsdt,
          maxConsecutiveLosses: config.maxConsecutiveLosses,
        },
        mathPreview,
        account,
        stats,
        shield,
        btcRegime: market.btcRegime,
        heatmap: market.heatmap,
        equityCurve,
      });
    }

    if (action === 'pause') {
      await store.set('v18:paused', '1');
      await store.set('v18:sv_mode', '0');
      return res.status(200).json({ ok: true, paused: true, message: 'Bot paused safely.' });
    }

    if (action === 'resume') {
      await store.del('v18:paused');
      await store.set('v18:sv_mode', '1');
      return res.status(200).json({ ok: true, paused: false, message: 'Bot resumed.' });
    }

    if (action === 'stop_all' || action === 'emergency_stop') {
      await store.set('v18:paused', '1');
      await store.set('v18:sv_mode', '0');
      const snap = await fetchAccountSnapshot(bybit);
      for (const pos of snap.openPositions) await closePositionMarket(bybit, pos);
      await sendTelegram('🚨 <b>Emergency Stop:</b> All positions closed & SV Mode turned OFF.');
      return res.status(200).json({ ok: true, closed: snap.openPositions.length, paused: true });
    }

    if (action === 'close_position' && body.symbol) {
      const snap = await fetchAccountSnapshot(bybit);
      const pos = snap.openPositions.find((p) => p.symbol === body.symbol);
      if (!pos) return res.status(404).json({ ok: false, error: 'Position not found' });
      await closePositionMarket(bybit, pos);
      return res.status(200).json({ ok: true, message: `Closed ${pos.symbol}` });
    }

    if (action === 'cron_tick' || action === 'run_now' || action === 'run_sv') {
      const result = await executeGuardianCycle(bybit, store, config);
      return res.status(200).json(result);
    }

    return res.status(400).json({ ok: false, error: `Unknown action: ${action}` });
  } catch (err) {
    console.error('[v18.1 Drop-in Error]', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
