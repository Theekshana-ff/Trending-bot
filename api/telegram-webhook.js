// File: api/telegram-webhook.js (v12.0 — Full 10 Updates + Start Next Trade Button)
const {
  getTradingHalted, setTradingHalted, appendJournalEntry,
  getBotFilters, setBotFilters
} = require('../lib/modules/securityAndState');
const bybitClient = require('../lib/modules/bybitLiveClient');
const { sendTelegramAlert } = require('../lib/modules/telegramAlerts');

const MAIN_MENU = {
  inline_keyboard: [
    [
      { text: '📊 Status', callback_data: 'cmd_status' },
      { text: '▶️ Start Next Trade', callback_data: 'cmd_next_trade' }
    ],
    [
      { text: '📜 History', callback_data: 'cmd_history' },
      { text: '📈 Daily PnL', callback_data: 'cmd_pnl' }
    ],
    [
      { text: '⚙️ Strict Mode', callback_data: 'cmd_mode_strict' },
      { text: '⚖️ Balanced Mode', callback_data: 'cmd_mode_balanced' }
    ],
    [
      { text: '✅ Resume', callback_data: 'cmd_resume' },
      { text: '🚨 Emergency Stop', callback_data: 'cmd_stop' }
    ]
  ]
};

async function answerCallback(callbackQueryId) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !callbackQueryId) return;
  await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId })
  }).catch(() => {});
}

async function fetchLivePrice(symbol) {
  const cleanSym = symbol.toUpperCase();
  const r = await fetch(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${cleanSym}`);
  const data = await r.json();
  const item = data?.result?.list?.[0];
  if (!item) return `⚠️ Could not find price for *${cleanSym}*`;
  const chg = (Number(item.price24hPcnt) * 100).toFixed(2);
  const funding = (Number(item.fundingRate) * 100).toFixed(4);
  return (
    `💰 *${cleanSym} LIVE PRICE*\n` +
    `Price: *$${item.lastPrice}*\n` +
    `24h Change: *${chg}%*\n` +
    `Funding Rate: *${funding}%*`
  );
}

async function handleCommand(cmd, parts, req) {
  if (cmd === '/start' || cmd === '/menu' || cmd === '/help') {
    return {
      text:
        `🤖 *Bybit Trading Bot Control Panel*\n\n` +
        `පහළ buttons tap කරන්න හෝ මේ commands යවන්න:\n` +
        `• \`/price BTCUSDT\` — Live Price & Funding\n` +
        `• \`/close SOLUSDT\` — Close Position\n` +
        `• \`/tp50 SOLUSDT\` — Partial Close 50%\n` +
        `• \`/be SOLUSDT\` — Move SL to Breakeven\n` +
        `• \`/risk 2\` — Set Risk % per trade\n` +
        `• \`/lev 10\` — Set Leverage`,
      markup: MAIN_MENU
    };
  }

  if (cmd === '/status' || cmd === 'cmd_status') {
    const [acct, halted, filters] = await Promise.all([
      bybitClient.fetchBybitWalletAndPositions(),
      getTradingHalted(),
      getBotFilters()
    ]);
    const posLines = (acct.positions || [])
      .map(p => `• *${p.symbol}* ${p.side} (${p.leverage}x) | uPnL: *$${Number(p.unrealisedPnl).toFixed(2)}*`)
      .join('\n') || 'None';
    return {
      text:
        `📊 *BYBIT BOT STATUS*\n` +
        `Halted: *${halted.halted ? 'YES' : 'NO'}*\n` +
        `Mode: *${String(filters?.strategyMode || 'strict').toUpperCase()}*\n` +
        `Risk: *${filters?.riskPct || 'Default'}%* | Lev: *${filters?.leverage || 'Default'}x*\n` +
        `Avail: *$${acct.wallet.availableBalance.toFixed(2)}* | Equity: *$${acct.wallet.totalEquity.toFixed(2)}*\n\n` +
        `*Open Positions:*\n${posLines}`,
      markup: MAIN_MENU
    };
  }

  if (cmd === '/nexttrade' || cmd === 'cmd_next_trade') {
    await setTradingHalted(false);
    const host = req.headers.host;
    let triggerNote = 'Trading enabled for next cycle.';
    if (host) {
      try {
        const resp = await fetch(`https://${host}/api/futures-agent`, { method: 'POST' });
        triggerNote = resp.ok
          ? 'Futures Agent triggered immediately!'
          : `Agent responded with status ${resp.status}.`;
      } catch (e) {
        triggerNote = `Trigger sent (${e.message})`;
      }
    }
    await appendJournalEntry({ type: 'TG_START_NEXT_TRADE', note: triggerNote });
    return {
      text: `▶️ *START NEXT TRADE*\nTrading is active. ${triggerNote}`,
      markup: MAIN_MENU
    };
  }

  if (cmd === '/stop' || cmd === 'cmd_stop') {
    await setTradingHalted(true);
    const stopRes = await bybitClient.executeLiveEmergencyStop();
    await appendJournalEntry({ type: 'TG_EMERGENCY_STOP', ...stopRes });
    return {
      text: `🚨 *EMERGENCY STOP*\nClosed ${stopRes.closedCount} positions. Trading HALTED.`,
      markup: MAIN_MENU
    };
  }

  if (cmd === '/resume' || cmd === 'cmd_resume') {
    await setTradingHalted(false);
    await appendJournalEntry({ type: 'TG_RESUME_TRADING' });
    return { text: `✅ *TRADING RESUMED* via Telegram.`, markup: MAIN_MENU };
  }

  if (cmd === 'cmd_mode_strict' || cmd === 'cmd_mode_balanced' || (cmd === '/mode' && parts[1])) {
    const targetMode = (cmd === 'cmd_mode_balanced' || parts[1]?.toLowerCase() === 'balanced')
      ? 'balanced'
      : 'strict';
    const cur = await getBotFilters();
    await setBotFilters({ ...cur, strategyMode: targetMode });
    return { text: `⚙️ Strategy Mode switched to *${targetMode.toUpperCase()}*.`, markup: MAIN_MENU };
  }

  if (cmd === '/price' && parts[1]) {
    return { text: await fetchLivePrice(parts[1]), markup: MAIN_MENU };
  }

  if (cmd === '/risk' && parts[1]) {
    const riskPct = Number(parts[1]);
    if (isNaN(riskPct) || riskPct <= 0 || riskPct > 20) {
      return { text: `⚠️ Valid risk % එකක් දෙන්න (උදා: \`/risk 2\`)` };
    }
    const cur = await getBotFilters();
    await setBotFilters({ ...cur, riskPct });
    return { text: `🎯 Risk per trade updated to *${riskPct}%*.`, markup: MAIN_MENU };
  }

  if (cmd === '/lev' && parts[1]) {
    const leverage = Number(parts[1]);
    if (isNaN(leverage) || leverage < 1 || leverage > 50) {
      return { text: `⚠️ Valid leverage එකක් දෙන්න (උදා: \`/lev 10\`)` };
    }
    const cur = await getBotFilters();
    await setBotFilters({ ...cur, leverage });
    return { text: `⚡ Leverage updated to *${leverage}x*.`, markup: MAIN_MENU };
  }

  if (cmd === '/close' && parts[1]) {
    const closeRes = await bybitClient.closeVerifiedLivePosition(parts[1].toUpperCase());
    return {
      text: closeRes.closed
        ? `🔒 *CLOSED ${closeRes.symbol}* | Qty: ${closeRes.qty}`
        : `⚠️ Could not close ${parts[1]}: ${closeRes.reason}`,
      markup: MAIN_MENU
    };
  }

  if (cmd === '/tp50' && parts[1]) {
    if (typeof bybitClient.closePartialPosition === 'function') {
      const res50 = await bybitClient.closePartialPosition(parts[1].toUpperCase(), 0.5);
      return { text: `✂️ *50% Partial Close (${parts[1].toUpperCase()}):* ${res50.message || 'Done'}`, markup: MAIN_MENU };
    }
    return { text: `ℹ️ \`/tp50\` වැඩ කරන්න \`bybitLiveClient.js\` එකට \`closePartialPosition\` function එක එකතු කරන්න ඕනේ.`, markup: MAIN_MENU };
  }

  if (cmd === '/be' && parts[1]) {
    if (typeof bybitClient.moveStopLossToBreakeven === 'function') {
      const resBe = await bybitClient.moveStopLossToBreakeven(parts[1].toUpperCase());
      return { text: `🛡️ *Breakeven SL (${parts[1].toUpperCase()}):* ${resBe.message || 'Done'}`, markup: MAIN_MENU };
    }
    return { text: `ℹ️ \`/be\` වැඩ කරන්න \`bybitLiveClient.js\` එකට \`moveStopLossToBreakeven\` function එක එකතු කරන්න ඕනේ.`, markup: MAIN_MENU };
  }

  if (cmd === '/history' || cmd === 'cmd_history') {
    if (typeof bybitClient.fetchClosedPnlHistory === 'function') {
      const list = await bybitClient.fetchClosedPnlHistory(5);
      const lines = list.map(t => `• ${t.symbol} (${t.side}): *$${Number(t.closedPnl).toFixed(2)}*`).join('\n') || 'No recent trades.';
      return { text: `📜 *LAST 5 CLOSED TRADES*\n${lines}`, markup: MAIN_MENU };
    }
    return { text: `📜 Recent trade history බලන්න \`bybitLiveClient.js\` එකට \`fetchClosedPnlHistory\` එකතු කරන්න ඕනේ.`, markup: MAIN_MENU };
  }

  if (cmd === '/pnl' || cmd === 'cmd_pnl') {
    const acct = await bybitClient.fetchBybitWalletAndPositions();
    const uPnl = (acct.positions || []).reduce((sum, p) => sum + Number(p.unrealisedPnl || 0), 0);
    return {
      text:
        `📈 *CURRENT PnL SUMMARY*\n` +
        `Total Equity: *$${acct.wallet.totalEquity.toFixed(2)}*\n` +
        `Unrealized PnL: *$${uPnl.toFixed(2)}*\n` +
        `Open Positions: *${(acct.positions || []).length}*`,
      markup: MAIN_MENU
    };
  }

  return { text: `❓ Unknown command. Type \`/menu\` to see all options.`, markup: MAIN_MENU };
}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') return res.status(200).send('OK');
    const update = req.body || {};
    const allowedChatId = String(process.env.TELEGRAM_CHAT_ID || '');

    let chatId = '';
    let cmd = '';
    let parts = [];

    if (update.callback_query) {
      chatId = String(update.callback_query.message?.chat?.id || '');
      cmd = String(update.callback_query.data || '');
      await answerCallback(update.callback_query.id);
    } else if (update.message?.text) {
      chatId = String(update.message.chat?.id || '');
      parts = update.message.text.trim().split(/\s+/);
      cmd = parts[0].toLowerCase();
    } else {
      return res.status(200).send('OK');
    }

    if (!allowedChatId || chatId !== allowedChatId) {
      console.error('[TG_UNAUTHORIZED]', { chatId });
      return res.status(200).send('OK');
    }

    const reply = await handleCommand(cmd, parts, req);
    await sendTelegramAlert(reply.text, reply.markup || null);
    return res.status(200).send('OK');
  } catch (err) {
    console.error('[TG_WEBHOOK_ERR]', err.message);
    await sendTelegramAlert(`🚨 *Webhook Error:* \`${err.message}\``);
    return res.status(200).send('OK');
  }
};
