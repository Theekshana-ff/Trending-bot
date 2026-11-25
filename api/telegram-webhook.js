// File: api/telegram-webhook.js (v16.0 — SV ULTRA PRO Control Panel + Power Presets)
const {
  getTradingHalted, setTradingHalted, appendJournalEntry,
  getBotFilters, setBotFilters, safeCompareSecret
} = require('../lib/modules/securityAndState');
const bybitClient = require('../lib/modules/bybitLiveClient');
const bybitEaHelpers = require('../lib/modules/bybitEaHelpers');
const { sendTelegramAlert } = require('../lib/modules/telegramAlerts');
const svEngine = require('../lib/modules/svScalpEngine');

function buildMainMenu(svEnabled = true, presetKey = 'pro') {
  const svLabel = svEnabled ? '⚡ SV Mode: ON 🟢' : '⚪ SV Mode: OFF';
  const p = svEngine.SV_PRESETS[presetKey] || svEngine.SV_PRESETS.pro;
  return {
    inline_keyboard: [
      [
        { text: '⚡ SV Status', callback_data: 'cmd_sv_status' },
        { text: '▶️ Run SV Now', callback_data: 'cmd_next_trade' }
      ],
      [
        { text: svLabel, callback_data: 'cmd_toggle_sv' },
        { text: `🎚️ ${p.label}`, callback_data: 'cmd_preset_menu' }
      ],
      [
        { text: '📊 Wallet & Positions', callback_data: 'cmd_status' },
        { text: '🔥 Coin Heatmap', callback_data: 'cmd_heatmap' }
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

function buildPresetMenu(currentKey = 'pro') {
  const mark = k => (k === currentKey ? ' ✅' : '');
  return {
    inline_keyboard: [
      [{ text: `🐢 Safe ($1.5 / 10x)${mark('safe')}`, callback_data: 'cmd_preset_safe' }],
      [{ text: `⚡ Pro ($2 / 18x)${mark('pro')}`, callback_data: 'cmd_preset_pro' }],
      [{ text: `🔥 Turbo ($3 / 20x)${mark('turbo')}`, callback_data: 'cmd_preset_turbo' }],
      [{ text: '⬅️ Back to Menu', callback_data: 'cmd_menu' }]
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
  return `💰 *${cleanSym} LIVE PRICE*\nPrice: *$${item.lastPrice}*\n24h Change: *${chg}%*\nFunding: *${funding}%*`;
}

async function handleCommand(cmd, parts, req) {
  const currentFilters = (await getBotFilters().catch(() => ({}))) || {};
  let svEnabled = svEngine.isSvModeActive(currentFilters);
  let presetKey = svEngine.getSvPresetConfig(currentFilters).key;

  if (cmd === '/start' || cmd === '/menu' || cmd === '/help' || cmd === 'cmd_menu') {
    const p = svEngine.SV_PRESETS[presetKey];
    return {
      text:
        `⚡ *Bybit SV ULTRA PRO Control Panel (v16.0)*\n` +
        `SV Engine: *${svEnabled ? 'ON 🟢' : 'OFF ⚪'}* | Preset: *${p.label}*\n\n` +
        `Commands:\n` +
        `• \`/sv_status\` — Gross / Fees / Net Stats\n` +
        `• \`/sv_preset\` — Switch Safe / Pro / Turbo\n` +
        `• \`/nexttrade\` — Run SV Scan & Trade Now\n` +
        `• \`/price SOLUSDT\` | \`/close SOLUSDT\``,
      markup: buildMainMenu(svEnabled, presetKey)
    };
  }

  // Ultra Pro #3: Power Presets Menu & Selection
  if (cmd === 'cmd_preset_menu' || cmd === '/sv_preset') {
    return {
      text:
        `🎚️ *SELECT SV ULTRA PRO POWER PRESET*\n\n` +
        `• *🐢 Safe:* $1.5 Margin · 6x–10x · $0.10 Net Cut\n` +
        `• *⚡ Pro:* $2.0 Margin · 12x–18x · $0.10 Net Cut _(Default)_\n` +
        `• *🔥 Turbo:* $3.0 Margin · 14x–20x · $0.12 Net Cut\n\n` +
        `_Recovery 10x & Anti-Wick Liquidation Shield active on all presets._`,
      markup: buildPresetMenu(presetKey)
    };
  }

  if (cmd === 'cmd_preset_safe' || cmd === 'cmd_preset_pro' || cmd === 'cmd_preset_turbo') {
    presetKey = cmd.replace('cmd_preset_', '');
    await setBotFilters({ ...currentFilters, svPreset: presetKey });
    await appendJournalEntry({ type: 'TG_SV_PRESET_CHANGE', svPreset: presetKey });
    const p = svEngine.SV_PRESETS[presetKey];
    return {
      text: `✅ *SV PRESET UPDATED:* ${p.label}\nBase Margin: *$${p.baseMarginUsdt}* | Leverage: *${p.minLev}x–${p.maxLev}x* | Target: *$${p.targetUsdt.toFixed(2)} net*`,
      markup: buildMainMenu(svEnabled, presetKey)
    };
  }

  if (cmd === 'cmd_heatmap' || cmd === '/heatmap') {
    const hm = await svEngine.getSvHeatmap().catch(() => ({ btc1mMovePct: 0, rows: [] }));
    const lines = (hm.rows || []).map(r =>
      `• *${r.coin}* (${r.direction}) — Score *${r.score}* | Spr ${r.spreadPct}% | _${r.status}_`
    ).join('\n') || 'No coins loaded.';
    return {
      text: `🔥 *LIVE SV 1m COIN HEATMAP*\nBTC 1m Pulse: *${hm.btc1mMovePct}%*\n\n${lines}`,
      markup: buildMainMenu(svEnabled, presetKey)
    };
  }

  if (cmd === 'cmd_toggle_sv' || cmd === '/sv_on' || cmd === '/sv_off') {
    const envLock = String(process.env.SV_MODE || '').trim().toLowerCase();
    if (envLock === 'true' || envLock === 'false') {
      return {
        text: `⚠️ *SV_MODE* Vercel Env එකෙන් *${envLock.toUpperCase()}* විදියට lock කරලා තියෙනවා.`,
        markup: buildMainMenu(svEnabled, presetKey)
      };
    }
    svEnabled = cmd === '/sv_on' ? true : cmd === '/sv_off' ? false : !svEnabled;
    await setBotFilters({ ...currentFilters, svMode: svEnabled });
    await appendJournalEntry({ type: 'TG_SV_MODE_TOGGLE', svMode: svEnabled });
    return {
      text: svEnabled ? `⚡ *SV ULTRA PRO: ON 🟢*` : `⚪ *SV ULTRA PRO: OFF*`,
      markup: buildMainMenu(svEnabled, presetKey)
    };
  }

  if (cmd === 'cmd_sv_status' || cmd === '/sv_status') {
    return { text: await svEngine.getSvStatusSummary(), markup: buildMainMenu(svEnabled, presetKey) };
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
        `📊 *BYBIT SV WALLET*\n` +
        `Avail: *$${acct.wallet.availableBalance.toFixed(2)}* | Equity: *$${acct.wallet.totalEquity.toFixed(2)}*\n` +
        `Halted: *${halted.halted ? 'YES' : 'NO'}*\n\n*Open Positions:*\n${posLines}`,
      markup: buildMainMenu(svEnabled, presetKey)
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
          triggerNote = `Opened *${sv.openedTrade.direction} ${sv.openedTrade.symbol}* (${sv.openedTrade.leverage}x · $${sv.openedTrade.margin})!`;
        } else if (sv?.entrySkippedReason) {
          triggerNote = `Scanned: _${sv.entrySkippedReason}_`;
        } else {
          triggerNote = resp.ok ? 'SV Ultra Pro cycle completed.' : `Agent status ${resp.status}`;
        }
      } catch (e) {
        triggerNote = `Trigger sent (${e.message})`;
      }
    }
    return { text: `▶️ *RUN SV ULTRA PRO*\n${triggerNote}`, markup: buildMainMenu(svEnabled, presetKey) };
  }

  if (cmd === '/stop' || cmd === 'cmd_stop') {
    await setTradingHalted(true);
    const stopRes = await bybitClient.executeLiveEmergencyStop();
    await appendJournalEntry({ type: 'TG_EMERGENCY_STOP', ...stopRes });
    return { text: `🚨 *EMERGENCY STOP*\nClosed ${stopRes.closedCount} positions. Trading HALTED.`, markup: buildMainMenu(svEnabled, presetKey) };
  }

  if (cmd === '/resume' || cmd === 'cmd_resume') {
    await setTradingHalted(false);
    await appendJournalEntry({ type: 'TG_RESUME_TRADING' });
    return { text: `✅ *TRADING RESUMED* via Telegram.`, markup: buildMainMenu(svEnabled, presetKey) };
  }

  if (cmd === '/price' && parts[1]) {
    return { text: await fetchLivePrice(parts[1]), markup: buildMainMenu(svEnabled, presetKey) };
  }

  if (cmd === '/close' && parts[1]) {
    const closeRes = await bybitClient.closeVerifiedLivePosition(parts[1].toUpperCase());
    return {
      text: closeRes.closed ? `🔒 *CLOSED ${closeRes.symbol}* | Qty: ${closeRes.qty}` : `⚠️ ${closeRes.reason}`,
      markup: buildMainMenu(svEnabled, presetKey)
    };
  }

  if (cmd === '/history' || cmd === 'cmd_history') {
    const list = await bybitEaHelpers.fetchClosedPnlHistory(5).catch(() => []);
    const lines = list.map(t => `${Number(t.closedPnl) >= 0 ? '✅' : '🔻'} *${t.symbol}* (${t.side}): *$${Number(t.closedPnl).toFixed(3)}*`).join('\n') || 'No recent closed trades.';
    return { text: `📜 *LAST 5 CLOSED TRADES*\n${lines}`, markup: buildMainMenu(svEnabled, presetKey) };
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
      text: `📈 *DAILY PnL*\nEquity: *$${acct.wallet.totalEquity.toFixed(2)}*\nUnrealized: *$${uPnl.toFixed(3)}*\nToday Realized: *$${realizedToday.toFixed(3)}*\nTrades: *${todayTrades.length}* (WR *${winRate}%*)`,
      markup: buildMainMenu(svEnabled, presetKey)
    };
  }

  return { text: `❓ Unknown command. Type \`/menu\`.`, markup: buildMainMenu(svEnabled, presetKey) };
}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') return res.status(200).send('OK');
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

    if (!allowedChatId || chatId !== allowedChatId) return res.status(200).send('OK');
    const reply = await handleCommand(cmd, parts, req);
    await sendTelegramAlert(reply.text, reply.markup || null);
    return res.status(200).send('OK');
  } catch (err) {
    console.error('[TG_WEBHOOK_ERR]', err.message);
    await sendTelegramAlert(`🚨 *Webhook Error:* \`${err.message}\``);
    return res.status(200).send('OK');
  }
};
