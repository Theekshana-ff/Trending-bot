// File: api/telegram-webhook.js (v12.3 — Full 10 Updates + Start Next Trade + EA Mode ON/OFF)
const {
  getTradingHalted, setTradingHalted, appendJournalEntry,
  getBotFilters, setBotFilters
} = require('../lib/modules/securityAndState');
const bybitClient = require('../lib/modules/bybitLiveClient');
const bybitEaHelpers = require('../lib/modules/bybitEaHelpers');
const { sendTelegramAlert } = require('../lib/modules/telegramAlerts');
const { runEAAnalysis } = require('../lib/modules/eaStrategyEngine');

function buildMainMenu(eaEnabled = false) {
  const eaLabel = eaEnabled ? '🧠 EA Mode: ON 🟢' : '⚪ EA Mode: OFF';
  return {
    inline_keyboard: [
      [
        { text: '📊 Status', callback_data: 'cmd_status' },
        { text: '▶️ Start Next Trade', callback_data: 'cmd_next_trade' }
      ],
      [
        { text: eaLabel, callback_data: 'cmd_toggle_ea' },
        { text: '🔍 EA Scan (BTC)', callback_data: 'cmd_ea_scan' }
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
}

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
  const currentFilters = (await getBotFilters()) || {};
  let eaEnabled = Boolean(currentFilters.eaMode);

  if (cmd === '/start' || cmd === '/menu' || cmd === '/help') {
    return {
      text:
        `🤖 *Bybit Trading Bot Control Panel (v12.3)*\n` +
        `EA Mode: *${eaEnabled ? 'ON 🟢 (EA Engine Active)' : 'OFF ⚪ (Normal Bot Run)'}*\n\n` +
        `පහළ buttons tap කරන්න හෝ මේ commands යවන්න:\n` +
        `• \`/ea SOLUSDT\` — Run EA MTF Analysis\n` +
        `• \`/ea_toggle\` — EA Mode ON / OFF\n` +
        `• \`/price BTCUSDT\` — Live Price & Funding\n` +
        `• \`/close SOLUSDT\` — Close Position\n` +
        `• \`/tp50 SOLUSDT\` — Partial Close 50%\n` +
        `• \`/be SOLUSDT\` — Move SL to Breakeven\n` +
        `• \`/risk 2\` — Set Risk % per trade\n` +
        `• \`/lev 10\` — Set Leverage`,
      markup: buildMainMenu(eaEnabled)
    };
  }

  if (cmd === 'cmd_toggle_ea' || cmd === '/ea_toggle') {
    eaEnabled = !eaEnabled;
    await setBotFilters({ ...currentFilters, eaMode: eaEnabled });
    await appendJournalEntry({ type: 'TG_EA_MODE_TOGGLE', eaMode: eaEnabled });
    return {
      text: eaEnabled
        ? `🧠 *EA STRATEGY MODE: ON 🟢*\nදැන් bot එකේ trades ඔක්කොම EA Multi-Strategy + MTF (5M/15M/1H/4H) engine එක හරහා filter වෙලා run වෙනවා.`
        : `⚪ *EA STRATEGY MODE: OFF*\nEA Mode off කළා. දැන් bot එක සාමාන්‍ය (Normal) විදියට run වෙනවා.`,
      markup: buildMainMenu(eaEnabled)
    };
  }

  if (cmd === 'cmd_ea_scan' || (cmd === '/ea' && parts[1])) {
    const sym = (parts[1] || 'BTCUSDT').toUpperCase();
    const ea = await runEAAnalysis(sym);
    const slTpLine = ea.suggestedSL
      ? `\nSL: *$${ea.suggestedSL}* | TP: *$${ea.suggestedTP}*`
      : '';
    return {
      text:
        `🧠 *EA ANALYSIS: ${ea.symbol}*\n` +
        `Price: *$${ea.price}*\n` +
        `Signal: *${ea.signal}* | Quality Score: *${ea.qualityScore}/100*${slTpLine}\n` +
        `MTF: 5M *${ea.mtf['5M']}* | 15M *${ea.mtf['15M']}* | 1H *${ea.mtf['1H']}* | 4H *${ea.mtf['4H']}*\n` +
        `Reasons:\n• ${ea.reasons.join('\n• ')}`,
      markup: buildMainMenu(eaEnabled)
    };
  }

  if (cmd === '/status' || cmd === 'cmd_status') {
    const [acct, halted] = await Promise.all([
      bybitClient.fetchBybitWalletAndPositions(),
      getTradingHalted()
    ]);
    const posLines = (acct.positions || [])
      .map(p => `• *${p.symbol}* ${p.side} (${p.leverage}x) | uPnL: *$${Number(p.unrealisedPnl).toFixed(2)}*`)
      .join('\n') || 'None';
    return {
      text:
        `📊 *BYBIT BOT STATUS*\n` +
        `Halted: *${halted.halted ? 'YES' : 'NO'}*\n` +
        `EA Mode: *${eaEnabled ? 'ON 🟢' : 'OFF ⚪ (Normal)'}*\n` +
        `Mode: *${String(currentFilters.strategyMode || 'strict').toUpperCase()}*\n` +
        `Risk: *${currentFilters.riskPct || 'Default'}%* | Lev: *${currentFilters.leverage || 'Default'}x*\n` +
        `Avail: *$${acct.wallet.availableBalance.toFixed(2)}* | Equity: *$${acct.wallet.totalEquity.toFixed(2)}*\n\n` +
        `*Open Positions:*\n${posLines}`,
      markup: buildMainMenu(eaEnabled)
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
          ? `Futures Agent triggered (${eaEnabled ? 'EA Mode ON' : 'Normal Mode'})!`
          : `Agent responded with status ${resp.status}.`;
      } catch (e) {
        triggerNote = `Trigger sent (${e.message})`;
      }
    }
    await appendJournalEntry({ type: 'TG_START_NEXT_TRADE', eaMode: eaEnabled, note: triggerNote });
    return {
      text: `▶️ *START NEXT TRADE*\nTrading is active. ${triggerNote}`,
      markup: buildMainMenu(eaEnabled)
    };
  }

  if (cmd === '/stop' || cmd === 'cmd_stop') {
    await setTradingHalted(true);
    const stopRes = await bybitClient.executeLiveEmergencyStop();
    await appendJournalEntry({ type: 'TG_EMERGENCY_STOP', ...stopRes });
    return {
      text: `🚨 *EMERGENCY STOP*\nClosed ${stopRes.closedCount} positions. Trading HALTED.`,
      markup: buildMainMenu(eaEnabled)
    };
  }

  if (cmd === '/resume' || cmd === 'cmd_resume') {
    await setTradingHalted(false);
    await appendJournalEntry({ type: 'TG_RESUME_TRADING' });
    return { text: `✅ *TRADING RESUMED* via Telegram.`, markup: buildMainMenu(eaEnabled) };
  }

  if (cmd === 'cmd_mode_strict' || cmd === 'cmd_mode_balanced' || (cmd === '/mode' && parts[1])) {
    const targetMode = (cmd === 'cmd_mode_balanced' || parts[1]?.toLowerCase() === 'balanced')
      ? 'balanced'
      : 'strict';
    await setBotFilters({ ...currentFilters, strategyMode: targetMode });
    return { text: `⚙️ Strategy Mode switched to *${targetMode.toUpperCase()}*.`, markup: buildMainMenu(eaEnabled) };
  }

  if (cmd === '/price' && parts[1]) {
    return { text: await fetchLivePrice(parts[1]), markup: buildMainMenu(eaEnabled) };
  }

  if (cmd === '/risk' && parts[1]) {
    const riskPct = Number(parts[1]);
    if (isNaN(riskPct) || riskPct <= 0 || riskPct > 20) {
      return { text: `⚠️ Valid risk % එකක් දෙන්න (උදා: \`/risk 2\`)`, markup: buildMainMenu(eaEnabled) };
    }
    await setBotFilters({ ...currentFilters, riskPct });
    return { text: `🎯 Risk per trade updated to *${riskPct}%*.`, markup: buildMainMenu(eaEnabled) };
  }

  if (cmd === '/lev' && parts[1]) {
    const leverage = Number(parts[1]);
    if (isNaN(leverage) || leverage < 1 || leverage > 50) {
      return { text: `⚠️ Valid leverage එකක් දෙන්න (උදා: \`/lev 10\`)`, markup: buildMainMenu(eaEnabled) };
    }
    await setBotFilters({ ...currentFilters, leverage });
    return { text: `⚡ Leverage updated to *${leverage}x*.`, markup: buildMainMenu(eaEnabled) };
  }

  if (cmd === '/close' && parts[1]) {
    const closeRes = await bybitClient.closeVerifiedLivePosition(parts[1].toUpperCase());
    return {
      text: closeRes.closed
        ? `🔒 *CLOSED ${closeRes.symbol}* | Qty: ${closeRes.qty}`
        : `⚠️ Could not close ${parts[1]}: ${closeRes.reason}`,
      markup: buildMainMenu(eaEnabled)
    };
  }

  if (cmd === '/tp50' && parts[1]) {
    const fn = typeof bybitClient.closePartialPosition === 'function'
      ? bybitClient.closePartialPosition
      : bybitEaHelpers.closePartialPosition;
    const res50 = await fn(parts[1].toUpperCase(), 0.5);
    return {
      text: res50.ok
        ? `✂️ *50% Partial Close (${parts[1].toUpperCase()}):* ${res50.message}`
        : `⚠️ ${res50.message}`,
      markup: buildMainMenu(eaEnabled)
    };
  }

  if (cmd === '/be' && parts[1]) {
    const fn = typeof bybitClient.moveStopLossToBreakeven === 'function'
      ? bybitClient.moveStopLossToBreakeven
      : bybitEaHelpers.moveStopLossToBreakeven;
    const resBe = await fn(parts[1].toUpperCase());
    return {
      text: resBe.ok
        ? `🛡️ *Breakeven SL (${parts[1].toUpperCase()}):* ${resBe.message}`
        : `⚠️ ${resBe.message}`,
      markup: buildMainMenu(eaEnabled)
    };
  }

  if (cmd === '/history' || cmd === 'cmd_history') {
    const fn = typeof bybitClient.fetchClosedPnlHistory === 'function'
      ? bybitClient.fetchClosedPnlHistory
      : bybitEaHelpers.fetchClosedPnlHistory;
    const list = await fn(5);
    const lines = list
      .map(t => {
        const icon = Number(t.closedPnl) >= 0 ? '✅' : '🔻';
        return `${icon} *${t.symbol}* (${t.side}): *$${Number(t.closedPnl).toFixed(2)}*`;
      })
      .join('\n') || 'No recent closed trades.';
    return { text: `📜 *LAST 5 CLOSED TRADES*\n${lines}`, markup: buildMainMenu(eaEnabled) };
  }

  if (cmd === '/pnl' || cmd === 'cmd_pnl') {
    const [acct, history] = await Promise.all([
      bybitClient.fetchBybitWalletAndPositions(),
      bybitEaHelpers.fetchClosedPnlHistory(20).catch(() => [])
    ]);
    const uPnl = (acct.positions || []).reduce((sum, p) => sum + Number(p.unrealisedPnl || 0), 0);
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);
    const todayTrades = history.filter(t => Number(t.createdTime || 0) >= startOfDay.getTime());
    const realizedToday = todayTrades.reduce((sum, t) => sum + Number(t.closedPnl || 0), 0);
    const wins = todayTrades.filter(t => Number(t.closedPnl) > 0).length;
    const winRate = todayTrades.length ? ((wins / todayTrades.length) * 100).toFixed(1) : '0.0';

    return {
      text:
        `📈 *DAILY PnL SUMMARY*\n` +
        `Total Equity: *$${acct.wallet.totalEquity.toFixed(2)}*\n` +
        `Unrealized PnL: *$${uPnl.toFixed(2)}*\n` +
        `Today Realized PnL: *$${realizedToday.toFixed(2)}*\n` +
        `Today Trades: *${todayTrades.length}* (Win Rate: *${winRate}%*)`,
      markup: buildMainMenu(eaEnabled)
    };
  }

  return { text: `❓ Unknown command. Type \`/menu\` to see all options.`, markup: buildMainMenu(eaEnabled) };
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
