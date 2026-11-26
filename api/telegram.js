// api/telegram.js — Drop-in Telegram Webhook Matching Original "My Bybit AI Trader" Menu + v18.1 FAST/SAFE Engine
import { BybitClient } from '../lib/bybitClient.js';
import { StateStore, loadRuntimeConfig } from '../lib/securityAndState.js';
import { previewMarginLeverageMath } from '../lib/strategyV18.js';
import { syncExchangeClosedPnl, checkRiskShields } from '../lib/riskGuardian.js';
import { sendTelegram, answerCallback, buildMainMenuKeyboard, getTelegramChatId } from '../lib/telegram.js';
import { fetchAccountSnapshot, scanMarket, closePositionMarket, executeGuardianCycle } from './futures-agent.js';

const PRESETS = [
  { name: 'FAST ($2 / 12x)', tradeMode: 'FAST', marginUsdt: 2.0, leverage: 12, targetNetUsdt: 0.10, maxLossPerTradeUsdt: 0.14 },
  { name: 'TURBO ($2 / 15x)', tradeMode: 'FAST', marginUsdt: 2.0, leverage: 15, targetNetUsdt: 0.10, maxLossPerTradeUsdt: 0.14 },
  { name: 'SAFE ($2 / 5x)', tradeMode: 'SAFE', marginUsdt: 2.0, leverage: 5, targetNetUsdt: 0.10, maxLossPerTradeUsdt: 0.14 },
];

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).json({ ok: true, bot: 'Bybit SV Ultra Pro v18.1 Telegram Webhook' });
  }

  const update = req.body || {};
  const store = new StateStore();
  let config = await loadRuntimeConfig(store);

  const allowedChat = getTelegramChatId();
  const incomingChat = String(
    update.message?.chat?.id ||
    update.callback_query?.message?.chat?.id ||
    ''
  );

  // Protect bot so only owner chat can execute trades
  if (allowedChat && incomingChat && incomingChat !== allowedChat) {
    return res.status(200).json({ ok: true, ignored: 'unauthorized_chat' });
  }

  const bybit = new BybitClient({
    apiKey: process.env.BYBIT_API_KEY,
    apiSecret: process.env.BYBIT_API_SECRET,
    testnet: config.testnet,
  });

  try {
    // 1. Handle Inline Callback Buttons (Move SL to BE, Quick Cut, Emergency Stop)
    if (update.callback_query) {
      const cb = update.callback_query;
      const [cmd, sym] = String(cb.data || '').split(':');
      const snap = await fetchAccountSnapshot(bybit);

      if (cmd === 'v18_stop_all') {
        await store.set('v18:paused', '1');
        await store.set('v18:sv_mode', '0');
        for (const pos of snap.openPositions) await closePositionMarket(bybit, pos);
        config = await loadRuntimeConfig(store);
        await answerCallback(cb.id, 'Emergency Stop Activated');
        await sendTelegram(
          '🚨 <b>Emergency Stop Activated!</b> All positions closed & SV Mode OFF.',
          buildMainMenuKeyboard(config),
          incomingChat
        );
        return res.status(200).json({ ok: true });
      }

      const pos = snap.openPositions.find((p) => p.symbol === sym);
      if (pos && cmd === 'v18_cut') {
        await closePositionMarket(bybit, pos);
        await answerCallback(cb.id, `Closed ${sym}`);
        await sendTelegram(`💰 <b>${sym}</b> closed immediately at Market!`, buildMainMenuKeyboard(config), incomingChat);
      } else if (pos && cmd === 'v18_be') {
        const be = pos.side === 'Buy' ? pos.avgPrice * 1.0014 : pos.avgPrice * 0.9986;
        await bybit.setTradingStop({ symbol: sym, stopLoss: Number(be.toFixed(4)) });
        await answerCallback(cb.id, `SL moved to BE`);
        await sendTelegram(`🔒 <b>${sym}</b> Stop Loss moved to Breakeven ($${be.toFixed(4)}).`, buildMainMenuKeyboard(config), incomingChat);
      } else {
        await answerCallback(cb.id, 'No active position');
      }
      return res.status(200).json({ ok: true });
    }

    // 2. Handle Reply Keyboard & Slash Commands
    const text = String(update.message?.text || '').trim();
    if (!text) return res.status(200).json({ ok: true });

    const kb = () => buildMainMenuKeyboard(config);

    if (text === '/start' || text === '/menu') {
      await sendTelegram(
        `⚡ <b>Bybit SV Ultra Pro v18.1 Ready!</b>
Mode: <b>${config.tradeMode}</b> ($${config.marginUsdt} × ${config.leverage}x)
Network: ${config.testnet ? '🧪 TESTNET' : '🔴 LIVE'}`,
        kb(),
        incomingChat
      );
      return res.status(200).json({ ok: true });
    }

    if (text.includes('Daily PnL') || text === '/pnl') {
      const [acct, stats] = await Promise.all([
        fetchAccountSnapshot(bybit),
        syncExchangeClosedPnl(bybit, store),
      ]);
      const msg =
        `📈 <b>DAILY PnL</b>
` +
        `Equity: $${acct.equity.toFixed(2)}
` +
        `Unrealized: $${acct.totalUnrealized.toFixed(3)}
` +
        `Today Realized: ${stats.netPnl >= 0 ? '+' : ''}$${stats.netPnl.toFixed(3)}
` +
        `Trades: ${stats.trades} (WR ${stats.winRate.toFixed(1)}%)`;
      await sendTelegram(msg, kb(), incomingChat);
      return res.status(200).json({ ok: true });
    }

    if (text.includes('History') || text === '/history') {
      const resPnl = await bybit.getClosedPnL(6);
      const list = resPnl?.result?.list || [];
      if (!list.length) {
        await sendTelegram('📜 No recent closed trades found.', kb(), incomingChat);
      } else {
        const lines = list.map((it) => {
          const p = Number(it.closedPnl || 0);
          const icon = p >= 0 ? '🟢' : '🔴';
          return `${icon} <b>${it.symbol.replace('USDT', '')}</b> ${it.side} | ${p >= 0 ? '+' : ''}$${p.toFixed(3)}`;
        });
        await sendTelegram(`📜 <b>RECENT TRADES</b>
${lines.join('
')}`, kb(), incomingChat);
      }
      return res.status(200).json({ ok: true });
    }

    if (text.includes('Wallet & Positions') || text === '/wallet') {
      const acct = await fetchAccountSnapshot(bybit);
      let posTxt = 'No open positions.';
      if (acct.openPositions.length) {
        posTxt = acct.openPositions
          .map(
            (p) =>
              `• <b>${p.symbol}</b> ${p.side} ${p.leverage}x
  Entry: $${p.avgPrice} | PnL: ${p.unrealisedPnl >= 0 ? '+' : ''}$${p.unrealisedPnl.toFixed(3)}
  TP: $${p.takeProfit} | SL: $${p.stopLoss}`
          )
          .join('
');
      }
      await sendTelegram(
        `📊 <b>WALLET & POSITIONS</b>
Available: $${acct.available.toFixed(2)}
Equity: $${acct.equity.toFixed(2)}

${posTxt}`,
        kb(),
        incomingChat
      );
      return res.status(200).json({ ok: true });
    }

    if (text.includes('Coin Heatmap') || text === '/heatmap') {
      const { btcRegime, heatmap, entryInterval } = await scanMarket(bybit, config);
      const rows = heatmap.map(
        (c) =>
          `• <b>${c.symbol.replace('USDT', '')}</b>: ${c.direction} (${c.score}/100) · ${c.status}`
      );
      await sendTelegram(
        `🔥 <b>COIN HEATMAP (${entryInterval}m/15m)</b>
BTC 15m: <b>${btcRegime.regime}</b> (${btcRegime.change15mPct}%)

${rows.join('
')}`,
        kb(),
        incomingChat
      );
      return res.status(200).json({ ok: true });
    }

    if (text.includes('SV Status') || text === '/sv_status') {
      const stats = await syncExchangeClosedPnl(bybit, store);
      const shield = checkRiskShields(stats, config);
      const math = previewMarginLeverageMath({
        mode: config.tradeMode,
        marginUsdt: config.marginUsdt,
        leverage: config.leverage,
        targetNetUsdt: config.targetNetUsdt,
        maxLossPerTradeUsdt: config.maxLossPerTradeUsdt,
      });
      await sendTelegram(
        `⚡ <b>SV ULTRA PRO v18.1 STATUS</b>
` +
        `SV Mode: <b>${config.svModeOn ? 'ON 🟢' : 'OFF 🔴'}</b>
` +
        `Engine: <b>${config.tradeMode}</b> ($${config.marginUsdt} × ${config.leverage}x = $${math.notional})
` +
        `Auto TP: +${math.requiredTpPct}% (+$${math.netTpUsdt} net)
` +
        `Auto SL: -${math.requiredSlPct}% (-$${math.netSlUsdt} net)
` +
        `Shield: <b>${shield.allowed ? 'OK ✅' : shield.reason}</b>
` +
        `Daily Max Loss: -$${config.maxDailyLossUsdt} | Blacklist: ${stats.blacklist.length ? stats.blacklist.join(', ') : 'None'}`,
        kb(),
        incomingChat
      );
      return res.status(200).json({ ok: true });
    }

    if (text.includes('Run SV Now') || text === '/run') {
      const out = await executeGuardianCycle(bybit, store, config);
      await sendTelegram(
        `▶ <b>SV SCAN RESULT</b>
Status: <b>${out.status}</b>${out.reason ? `
Reason: ${out.reason}` : ''}`,
        kb(),
        incomingChat
      );
      return res.status(200).json({ ok: true });
    }

    if (text.includes('SV Mode:')) {
      const nextVal = config.svModeOn ? '0' : '1';
      await store.set('v18:sv_mode', nextVal);
      if (nextVal === '1') await store.del('v18:paused');
      config = await loadRuntimeConfig(store);
      await sendTelegram(
        `⚡ SV Mode turned <b>${config.svModeOn ? 'ON 🟢' : 'OFF 🔴'}</b>.`,
        kb(),
        incomingChat
      );
      return res.status(200).json({ ok: true });
    }

    if (text.includes('FAST (') || text.includes('SAFE (') || text.includes('Pro (')) {
      const curIdx = PRESETS.findIndex(
        (p) => p.tradeMode === config.tradeMode && p.leverage === config.leverage
      );
      const next = PRESETS[(curIdx + 1) % PRESETS.length];
      const saved = (await store.getJson('v18:settings')) || {};
      await store.setJson('v18:settings', { ...saved, ...next });
      config = await loadRuntimeConfig(store);
      const math = previewMarginLeverageMath({
        mode: config.tradeMode,
        marginUsdt: config.marginUsdt,
        leverage: config.leverage,
        targetNetUsdt: config.targetNetUsdt,
        maxLossPerTradeUsdt: config.maxLossPerTradeUsdt,
      });
      await sendTelegram(
        `🎚️ Switched Preset to <b>${next.name}</b>
Auto TP: +${math.requiredTpPct}% (+$${math.netTpUsdt} net) | SL: -${math.requiredSlPct}% (-$${math.netSlUsdt} net)
Speed: ${math.speedLabel}`,
        kb(),
        incomingChat
      );
      return res.status(200).json({ ok: true });
    }

    if (text.includes('Resume') || text === '/resume') {
      await store.del('v18:paused');
      await store.set('v18:sv_mode', '1');
      config = await loadRuntimeConfig(store);
      await sendTelegram('✅ <b>Bot Resumed!</b> SV Mode is ON 🟢.', kb(), incomingChat);
      return res.status(200).json({ ok: true });
    }

    if (text.includes('Emergency Stop') || text === '/stop') {
      await store.set('v18:paused', '1');
      await store.set('v18:sv_mode', '0');
      const snap = await fetchAccountSnapshot(bybit);
      for (const pos of snap.openPositions) await closePositionMarket(bybit, pos);
      config = await loadRuntimeConfig(store);
      await sendTelegram(
        `🚨 <b>EMERGENCY STOP EXECUTED</b>
Closed Positions: ${snap.openPositions.length}
SV Mode: OFF 🔴`,
        kb(),
        incomingChat
      );
      return res.status(200).json({ ok: true });
    }

    await sendTelegram('Use the menu buttons below 👇', kb(), incomingChat);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[Telegram Webhook Error]', err);
    await sendTelegram(`⚠️ Error: ${err.message}`, buildMainMenuKeyboard(config), incomingChat);
    return res.status(200).json({ ok: false, error: err.message });
  }
}
