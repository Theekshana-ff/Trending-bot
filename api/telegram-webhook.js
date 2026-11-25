// File: api/telegram-webhook.js (v15.0 — SV MODE ONLY Control Panel)
const {
  getTradingHalted, setTradingHalted, appendJournalEntry,
  getBotFilters, setBotFilters, safeCompareSecret
} = require('../lib/modules/securityAndState');
const bybitClient = require('../lib/modules/bybitLiveClient');
const bybitEaHelpers = require('../lib/modules/bybitEaHelpers');
const { sendTelegramAlert } = require('../lib/modules/telegramAlerts');
const svEngine = require('../lib/modules/svScalpEngine');

function buildMainMenu(svEnabled = true) {
  const svLabel = svEnabled ? '⚡ SV Mode: ON 🟢' : '⚪ SV Mode: OFF';
  return {
    inline_keyboard: [
      [
        { text: '⚡ SV Status', callback_data: 'cmd_sv_status' },
        { text: '▶️ Run SV Now', callback_data: 'cmd_next_trade' }
      ],
      [
        { text: svLabel, callback_data: 'cmd_toggle_sv' },
        { text: '📊 Wallet & Positions', callback_data: 'cmd_status' }
      ],
      [
        { text: '📜 History', callback_data: 'cmd_history' },
        { text: '📈 Daily PnL', callback_data: 'cmd_pnl' }
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
  const cleanSym = String(symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20);
  if (!cleanSym) return '⚠️ Invalid symbol';
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
  const currentFilters = (await getBotFilters().catch(() => ({}))) || {};
  let svEnabled = svEngine.isSvModeActive(currentFilters);

  if (cmd === '/start' || cmd === '/menu' || cmd === '/help') {
    return {
      text:
        `⚡ *Bybit SV MODE ONLY Control Panel (v15.0)*\n` +
        `SV Engine: *${svEnabled ? 'ON 🟢 (100% Auto Lev/Margin)' : 'OFF ⚪'}*\n\n` +
        `පහළ buttons tap කරන්න හෝ මේ commands යවන්න:\n` +
        `• \`/sv_status\` — SV Engine Today Stats\n` +
        `• \`/sv_on\` | \`/sv_off\` — SV Mode ON / OFF\n` +
        `• \`/nexttrade\` — Run SV Scan & Trade Now\n` +
        `• \`/price BTCUSDT\` — Live Price & Funding\n` +
        `• \`/close SOLUSDT\` | \`/tp50 SOLUSDT\` | \`/be SOLUSDT\``,
      markup: buildMainMenu(svEnabled)
    };
  }

  if (cmd === 'cmd_toggle_sv' || cmd === '/sv_on' || cmd === '/sv_off') {
    const envLock = String(process.env.SV_MODE || '').trim().toLowerCase();
    if (envLock === 'true' || envLock === 'false') {
      return {
        text: `⚠️ *SV_MODE* දැනට Vercel Environment Variable එකෙන් *${envLock.toUpperCase()}* විදියට lock කරලා තියෙනවා.\nTelegram එකෙන් toggle කරන්න නම් Vercel \`SV_MODE\` key එක අයින් කරන්න, නැත්නම් Vercel එකෙන්ම \`true\` / \`false\` මාරු කරන්න.`,
        markup: buildMainMenu(svEnabled)
      };
    }
    svEnabled = cmd === '/sv_on' ? true : cmd === '/sv_off' ? false : !svEnabled;
    await setBotFilters({ ...currentFilters, svMode: svEnabled });
    await appendJournalEntry({ type: 'TG_SV_MODE_TOGGLE', svMode: svEnabled });
    return {
      text: svEnabled
        ? `⚡ *SV MODE: ON 🟢*\n100% Auto Leverage & Margin SV Micro-Scalping Engine එක දැන් active!`
        : `⚪ *SV MODE: OFF*\nSV Engine එක තාවකාලිකව pause කළා.`,
      markup: buildMainMenu(svEnabled)
    };
  }

  if (cmd === 'cmd_sv_status' || cmd === '/sv_status') {
    const summary = await svEngine.getSvStatusSummary();
    return { text: summary, markup: buildMainMenu(svEnabled) };
  }

  if (cmd === '/status' || cmd === 'cmd_status') {
    const [acct, halted] = await Promise.all([
      bybitClient.fetchBybitWalletAndPositions(),
      getTradingHalted()
    ]);
    const posLines = (acct.positions || [])
      .map(p => `• *${p.symbol}* ${p.side} (${p.leverage}x) | uPnL: *$${Number(p.unrealisedPnl).toFixed(3)}*`)
      .join('\n') || 'None';
    return {
      text:
        `📊 *BYBIT SV BOT WALLET*\n` +
        `SV Mode: *${svEnabled ? 'ON 🟢' : 'OFF ⚪'}* | Halted: *${halted.halted ? 'YES' : 'NO'}*\n` +
        `Avail: *$${acct.wallet.availableBalance.toFixed(2)}* | Equity: *$${acct.wallet.totalEquity.toFixed(2)}*\n\n` +
        `*Open Positions:*\n${posLines}`,
      markup: buildMainMenu(svEnabled)
    };
  }

  if (cmd === '/nexttrade' || cmd === 'cmd_next_trade') {
    await setTradingHalted(false);
    const host = req.headers.host;
    const cronSecret = (process.env.CRON_SECRET || '').trim();
    let triggerNote = 'SV Engine enabled for next cron cycle.';
    if (host && cronSecret) {
      try {
        const resp = await fetch(`https://${host}/api/futures-agent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-cron-secret': cronSecret },
          body: JSON.stringify({ action: 'cron_tick' })
        });
        const data = await resp.json().catch(() => ({}));
        const sv = data?.svEngine;
        if (sv?.openedTrade) {
          triggerNote = `Opened *${sv.openedTrade.direction} ${sv.openedTrade.symbol}* (${sv.openedTrade.leverage}x)!`;
        } else if (sv?.entrySkippedReason) {
          triggerNote = `Scanned: _${sv.entrySkippedReason}_`;
        } else {
          triggerNote = resp.ok ? 'SV Engine cycle completed.' : `Agent status ${resp.status}`;
        }
      } catch (e) {
        triggerNote = `Trigger sent (${e.message})`;
      }
    }
    await appendJournalEntry({ type: 'TG_RUN_SV_NOW', note: triggerNote });
    return { text: `▶️ *RUN SV ENGINE*\n${triggerNote}`, markup: buildMainMenu(svEnabled) };
  }

  if (cmd === '/stop' || cmd === 'cmd_stop') {
    await setTradingHalted(true);
    const stopRes = await bybitClient.executeLiveEmergencyStop();
    await appendJournalEntry({ type: 'TG_EMERGENCY_STOP', ...stopRes });
    return {
      text: `🚨 *EMERGENCY STOP*\nClosed ${stopRes.closedCount} positions. Trading HALTED.`,
      markup: buildMainMenu(svEnabled)
    };
  }

  if (cmd === '/resume' || cmd === 'cmd_resume') {
    await setTradingHalted(false);
    await appendJournalEntry({ type: 'TG_RESUME_TRADING' });
    return { text: `✅ *TRADING RESUMED* via Telegram.`, markup: buildMainMenu(svEnabled) };
  }

  if (cmd === '/price' && parts[1]) {
    return { text: await fetchLivePrice(parts[1]), markup: buildMainMenu(svEnabled) };
  }

  if (cmd === '/close' && parts[1]) {
    const closeRes = await bybitClient.closeVerifiedLivePosition(parts[1].toUpperCase());
    return {
      text: closeRes.closed
        ? `🔒 *CLOSED ${closeRes.symbol}* | Qty: ${closeRes.qty}`
        : `⚠️ Could not close ${parts[1]}: ${closeRes.reason}`,
      markup: buildMainMenu(svEnabled)
    };
  }

  if (cmd === '/tp50' && parts[1]) {
    const res50 = await bybitEaHelpers.closePartialPosition(parts[1].toUpperCase(), 0.5);
    return {
      text: res50.ok ? `✂️ *50% Partial Close (${parts[1].toUpperCase()}):* ${res50.message}` : `⚠️ ${res50.message}`,
      markup: buildMainMenu(svEnabled)
    };
  }

  if (cmd === '/be' && parts[1]) {
    const resBe = await bybitEaHelpers.moveStopLossToBreakeven(parts[1].toUpperCase());
    return {
      text: resBe.ok ? `🛡️ *Breakeven SL (${parts[1].toUpperCase()}):* ${resBe.message}` : `⚠️ ${resBe.message}`,
      markup: buildMainMenu(svEnabled)
    };
  }

  if (cmd === '/history' || cmd === 'cmd_history') {
    const list = await bybitEaHelpers.fetchClosedPnlHistory(5).catch(() => []);
    const lines = list
      .map(t => `${Number(t.closedPnl) >= 0 ? '✅' : '🔻'} *${t.symbol}* (${t.side}): *$${Number(t.closedPnl).toFixed(3)}*`)
      .join('\n') || 'No recent closed trades.';
    return { text: `📜 *LAST 5 CLOSED TRADES*\n${lines}`, markup: buildMainMenu(svEnabled) };
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
        `Unrealized PnL: *$${uPnl.toFixed(3)}*\n` +
        `Today Realized PnL: *$${realizedToday.toFixed(3)}*\n` +
        `Today Trades: *${todayTrades.length}* (Win Rate: *${winRate}%*)`,
      markup: buildMainMenu(svEnabled)
    };
  }

  return { text: `❓ Unknown command. Type \`/menu\` to see SV Mode options.`, markup: buildMainMenu(svEnabled) };
}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') return res.status(200).send('OK');

    // Fail-closed Telegram webhook secret verification
    const expectedSecret = (process.env.TELEGRAM_WEBHOOK_SECRET || '').trim();
    const providedSecret = String(req.headers?.['x-telegram-bot-api-secret-token'] || '').trim();
    if (!expectedSecret || !safeCompareSecret(providedSecret, expectedSecret)) {
      console.error('[TG_SECRET_REJECTED]');
      return res.status(401).send('Unauthorized');
    }

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
