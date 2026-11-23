// File: api/telegram-webhook.js (v12.6 — Updates #2 Top-3 EA Scanner, #9 Chart Snapshot, #10 Weekly Report)
const {
  getTradingHalted, setTradingHalted, appendJournalEntry, getJournalEntries,
  getBotFilters, setBotFilters
} = require('../lib/modules/securityAndState');
const bybitClient = require('../lib/modules/bybitLiveClient');
const bybitEaHelpers = require('../lib/modules/bybitEaHelpers');
const {
  sendTelegramAlert,
  sendTelegramPhoto,
  buildQuickChartUrl
} = require('../lib/modules/telegramAlerts');
const { runEAAnalysis, scanTopCoinsEA } = require('../lib/modules/eaStrategyEngine');
const ultraPro = require('../lib/modules/ultraProEngine');
const svEngine = require('../lib/modules/svScalpEngine');
const { safeCompareSecret } = require('../lib/modules/securityAndState');

function buildMainMenu(eaEnabled = false, svEnabled = false) {
  const eaLabel = eaEnabled ? '🧠 EA Mode: ON 🟢' : '⚪ EA Mode: OFF';
  const svLabel = svEnabled ? '⚡ SV Mode: ON 🟢' : '⚪ SV Mode: OFF';
  return {
    inline_keyboard: [
      [
        { text: '📊 Status', callback_data: 'cmd_status' },
        { text: '▶️ Start Next Trade', callback_data: 'cmd_next_trade' }
      ],
      [
        { text: svLabel, callback_data: 'cmd_toggle_sv' },
        { text: '⚡ SV Status', callback_data: 'cmd_sv_status' }
      ],
      [
        { text: eaLabel, callback_data: 'cmd_toggle_ea' },
        { text: '🔎 EA Top-3 Scan', callback_data: 'cmd_ea_scan_all' }
      ],
      [
        { text: '🔍 EA Chart (BTC)', callback_data: 'cmd_ea_scan' },
        { text: '🔥 Funding Squeeze', callback_data: 'cmd_squeeze' }
      ],
      [
        { text: '🌍 Sessions (SL Time)', callback_data: 'cmd_sessions' },
        { text: '📅 Weekly Report', callback_data: 'cmd_weekly' }
      ],
      [
        { text: '📜 History', callback_data: 'cmd_history' },
        { text: '📈 Daily PnL', callback_data: 'cmd_pnl' }
      ],
      [
        { text: '⚖️ EA vs Normal', callback_data: 'cmd_compare' },
        { text: '⚙️ Strict Mode', callback_data: 'cmd_mode_strict' }
      ],
      [
        { text: '⚖️ Balanced Mode', callback_data: 'cmd_mode_balanced' },
        { text: '✅ Resume', callback_data: 'cmd_resume' }
      ],
      [
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

async function buildWeeklyReportText() {
  const history = await bybitEaHelpers.fetchClosedPnlHistory(50).catch(() => []);
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const weekTrades = history.filter(t => Number(t.createdTime || 0) >= weekAgo);

  if (!weekTrades.length) {
    return `📅 *WEEKLY PERFORMANCE REPORT (7D)*\nNo closed trades recorded in the last 7 days.`;
  }

  let totalPnl = 0;
  let wins = 0;
  const byCoin = {};

  for (const t of weekTrades) {
    const pnl = Number(t.closedPnl || 0);
    totalPnl += pnl;
    if (pnl > 0) wins++;
    byCoin[t.symbol] = (byCoin[t.symbol] || 0) + pnl;
  }

  const winRate = ((wins / weekTrades.length) * 100).toFixed(1);
  const sortedCoins = Object.entries(byCoin).sort((a, b) => b[1] - a[1]);
  const bestCoin = sortedCoins[0];
  const worstCoin = sortedCoins[sortedCoins.length - 1];
  const icon = totalPnl >= 0 ? '🟢' : '🔴';

  return (
    `📅 *WEEKLY PERFORMANCE REPORT (7D)*\n` +
    `${icon} Net PnL: *$${totalPnl.toFixed(2)}*\n` +
    `Trades: *${weekTrades.length}* (${wins}W / ${weekTrades.length - wins}L)\n` +
    `Win Rate: *${winRate}%*\n` +
    `🏆 Best Coin: *${bestCoin[0]}* ($${bestCoin[1].toFixed(2)})\n` +
    `⚠️ Worst Coin: *${worstCoin[0]}* ($${worstCoin[1].toFixed(2)})`
  );
}

async function handleCommand(cmd, parts, req) {
  const currentFilters = (await getBotFilters()) || {};
  let eaEnabled = Boolean(currentFilters.eaMode);
  let svEnabled = svEngine.isSvModeActive(currentFilters);

  if (cmd === '/start' || cmd === '/menu' || cmd === '/help') {
    return {
      text:
        `🤖 *Bybit v6 Sniper + EA Control Panel*\n` +
        `EA Mode: *${eaEnabled ? 'ON 🟢 (EA Engine Active)' : 'OFF ⚪ (Normal v6 Sniper)'}*\n\n` +
        `පහළ buttons tap කරන්න හෝ මේ commands යවන්න:\n` +
        `• \`/eascan_all\` — Top-3 Multi-Coin EA Scanner\n` +
        `• \`/ea SOLUSDT\` — EA MTF Analysis + Chart Image\n` +
        `• \`/weekly\` — 7-Day Weekly Performance Report\n` +
        `• \`/ea_toggle\` — EA Mode ON / OFF\n` +
        `• \`/price BTCUSDT\` — Live Price & Funding\n` +
        `• \`/close SOLUSDT\` | \`/tp50 SOLUSDT\` | \`/be SOLUSDT\`\n` +
        `• \`/risk 2\` | \`/lev 10\``,
      markup: buildMainMenu(eaEnabled, svEnabled)
    };
  }

  if (cmd === 'cmd_toggle_ea' || cmd === '/ea_toggle') {
    eaEnabled = !eaEnabled;
    await setBotFilters({ ...currentFilters, eaMode: eaEnabled });
    await appendJournalEntry({ type: 'TG_EA_MODE_TOGGLE', eaMode: eaEnabled });
    return {
      text: eaEnabled
        ? `🧠 *EA STRATEGY MODE: ON 🟢*\nදැන් trades ඔක්කොම v6 Sniper + EA Multi-Strategy MTF (5M/15M/1H/4H) confirmation එක්ක run වෙනවා.`
        : `⚪ *EA STRATEGY MODE: OFF*\nEA Mode off කළා. දැන් ඔයාගේ Normal v6 Sniper bot එක සාමාන්‍ය විදියටම run වෙනවා.`,
      markup: buildMainMenu(eaEnabled, svEnabled)
    };
  }

  // #40 One-Tap Telegram SV Mode Toggle (/sv_on, /sv_off, button)
  if (cmd === 'cmd_toggle_sv' || cmd === '/sv_on' || cmd === '/sv_off') {
    const envLock = String(process.env.SV_MODE || '').trim().toLowerCase();
    if (envLock === 'true' || envLock === 'false') {
      return {
        text: `⚠️ *SV_MODE* දැනට Vercel Environment Variable එකෙන් *${envLock.toUpperCase()}* විදියට lock කරලා තියෙනවා.\nTelegram එකෙන් toggle කරන්න නම් Vercel \`SV_MODE\` key එක අයින් කරන්න, නැත්නම් Vercel එකෙන්ම \`true\` / \`false\` මාරු කරන්න.`,
        markup: buildMainMenu(eaEnabled, svEnabled)
      };
    }
    svEnabled = cmd === '/sv_on' ? true : cmd === '/sv_off' ? false : !svEnabled;
    await setBotFilters({ ...currentFilters, svMode: svEnabled });
    await appendJournalEntry({ type: 'TG_SV_MODE_TOGGLE', svMode: svEnabled });
    return {
      text: svEnabled
        ? `⚡ *SV STANDALONE ENGINE: ON 🟢*\nදැන් Normal v6 & EA Mode සම්පූර්ණයෙන්ම නැවතිලා, 100% Auto Leverage/Margin SV Micro-Scalping Engine එක විතරක් run වෙනවා!`
        : `⚪ *SV STANDALONE ENGINE: OFF*\nSV Mode off කළා. දැන් ඔයාගේ Normal v6 / EA bot එක ආපහු run වෙනවා.`,
      markup: buildMainMenu(eaEnabled, svEnabled)
    };
  }

  // #20 Dedicated SV Telegram Mini-Summary
  if (cmd === 'cmd_sv_status' || cmd === '/sv_status') {
    const summary = await svEngine.getSvStatusSummary();
    return { text: summary, markup: buildMainMenu(eaEnabled, svEnabled) };
  }

  // Update #2: Multi-Coin EA Top-3 Scanner
  if (cmd === 'cmd_ea_scan_all' || cmd === '/eascan_all') {
    const top3 = await scanTopCoinsEA(undefined, 3);
    if (!top3.length) {
      return { text: `⚠️ Could not scan coins right now.`, markup: buildMainMenu(eaEnabled, svEnabled) };
    }
    const lines = top3.map((ea, idx) => {
      const slTp = ea.suggestedSL ? ` | SL $${ea.suggestedSL} / TP $${ea.suggestedTP}` : '';
      return (
        `*${idx + 1}. ${ea.symbol}* — *${ea.signal}* (Score: *${ea.qualityScore}/100*)\n` +
        `   Price: $${ea.price}${slTp}\n` +
        `   MTF: 15M ${ea.mtf['15M']} | 1H ${ea.mtf['1H']} | 4H ${ea.mtf['4H']}`
      );
    }).join('\n\n');

    return {
      text: `🔎 *TOP-3 MULTI-COIN EA SCANNER*\n\n${lines}\n\n_Chart බලන්න \`/ea COINUSDT\` යවන්න._`,
      markup: buildMainMenu(eaEnabled, svEnabled)
    };
  }

  // Update #9: EA Analysis + Chart Snapshot Image
  if (cmd === 'cmd_ea_scan' || (cmd === '/ea' && parts[1])) {
    const sym = (parts[1] || 'BTCUSDT').toUpperCase();
    const ea = await runEAAnalysis(sym);
    const slTpLine = ea.suggestedSL ? `\nSL: *$${ea.suggestedSL}* | TP: *$${ea.suggestedTP}*` : '';
    const caption =
      `🧠 *EA ANALYSIS: ${ea.symbol}*\n` +
      `Price: *$${ea.price}*\n` +
      `Signal: *${ea.signal}* | Quality Score: *${ea.qualityScore}/100*${slTpLine}\n` +
      `MTF: 5M *${ea.mtf['5M']}* | 15M *${ea.mtf['15M']}* | 1H *${ea.mtf['1H']}* | 4H *${ea.mtf['4H']}*\n` +
      `Reasons: ${ea.reasons.join(', ')}`;

    const photoUrl = buildQuickChartUrl({
      symbol: ea.symbol,
      closes: ea.recentCloses,
      entry: ea.price,
      sl: ea.suggestedSL,
      tp: ea.suggestedTP,
      signal: ea.signal
    });

    return { text: caption, photoUrl, markup: buildMainMenu(eaEnabled, svEnabled) };
  }

  // Update #10: Weekly Performance Report
  if (cmd === 'cmd_weekly' || cmd === '/weekly') {
    const reportText = await buildWeeklyReportText();
    return { text: reportText, markup: buildMainMenu(eaEnabled, svEnabled) };
  }

  // Ultra Pro: Funding Rate Squeeze Hunter (#17)
  if (cmd === 'cmd_squeeze' || cmd === '/squeeze') {
    const list = await ultraPro.scanFundingRateSqueezes(5);
    if (!list.length) {
      return { text: `🔥 *FUNDING SQUEEZE RADAR*
No extreme funding rate squeezes right now.`, markup: buildMainMenu(eaEnabled, svEnabled) };
    }
    const lines = list.map(x =>
      `• *${x.symbol}* ($${x.price}) | Funding: *${x.fundingRatePct}%* | 24h: *${x.chg24h}%*
  _${x.squeezeType}_`
    ).join('\n');
    return { text: `🔥 *FUNDING RATE SQUEEZE HUNTER*\n\n${lines}`, markup: buildMainMenu(eaEnabled, svEnabled) };
  }

  // v14.0 Ultra Pro Max: EA Mode vs Normal v6 Performance Compare
  if (cmd === 'cmd_compare' || cmd === '/compare') {
    const [journal, history] = await Promise.all([
      getJournalEntries().catch(() => []),
      bybitEaHelpers.fetchClosedPnlHistory(50).catch(() => [])
    ]);
    const cmp = ultraPro.computeModeComparison(journal, history);
    return {
      text:
        `⚖️ *EA MODE vs NORMAL v6 PERFORMANCE*\n\n` +
        `🧠 *EA Mode:*\n` +
        `• Win Rate: *${cmp.ea.winRate}%* (${cmp.ea.wins}W / ${cmp.ea.losses}L)\n` +
        `• Net PnL: *$${cmp.ea.netPnl.toFixed(2)}*\n\n` +
        `⚡ *Normal v6 Sniper:*\n` +
        `• Win Rate: *${cmp.normal.winRate}%* (${cmp.normal.wins}W / ${cmp.normal.losses}L)\n` +
        `• Net PnL: *$${cmp.normal.netPnl.toFixed(2)}*`,
      markup: buildMainMenu(eaEnabled, svEnabled)
    };
  }

  // Ultra Pro: Market Sessions Schedule (Sri Lanka Time + UTC)
  if (cmd === 'cmd_sessions' || cmd === '/sessions') {
    const cur = ultraPro.getCurrentSessionInfo();
    const lines = ultraPro.MARKET_SESSIONS.map(s =>
      `${s.emoji} *${s.label}*: ${s.slTime} (${String(s.utcHour).padStart(2, '0')}:00 UTC)`
    ).join('\n');
    return {
      text: `🌍 *MARKET SESSIONS (AUTO ALERTS ON)*\nCurrent Active: *${cur.name}*\n\n${lines}`,
      markup: buildMainMenu(eaEnabled, svEnabled)
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
        `EA Mode: *${eaEnabled ? 'ON 🟢' : 'OFF ⚪ (Normal v6)'}*\n` +
        `Mode: *${String(currentFilters.strategyMode || 'strict').toUpperCase()}*\n` +
        `Risk: *${currentFilters.riskPct || 'Default'}%* | Lev: *${currentFilters.leverage || 'Default'}x*\n` +
        `Avail: *$${acct.wallet.availableBalance.toFixed(2)}* | Equity: *$${acct.wallet.totalEquity.toFixed(2)}*\n\n` +
        `*Open Positions:*\n${posLines}`,
      markup: buildMainMenu(eaEnabled, svEnabled)
    };
  }

  if (cmd === '/nexttrade' || cmd === 'cmd_next_trade') {
    await setTradingHalted(false);
    const host = req.headers.host;
    const cronSecret = (process.env.CRON_SECRET || '').trim();
    let triggerNote = 'Trading enabled for next cron cycle.';
    if (host && cronSecret) {
      try {
        const resp = await fetch(`https://${host}/api/futures-agent`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-cron-secret': cronSecret
          },
          body: JSON.stringify({ action: 'cron_tick' })
        });
        triggerNote = resp.ok
          ? `v6 Sniper Agent triggered immediately (${eaEnabled ? 'EA Mode ON' : 'Normal Mode'})!`
          : `Agent responded with status ${resp.status}.`;
      } catch (e) {
        triggerNote = `Trigger sent (${e.message})`;
      }
    }
    await appendJournalEntry({ type: 'TG_START_NEXT_TRADE', eaMode: eaEnabled, note: triggerNote });
    return {
      text: `▶️ *START NEXT TRADE*\nTrading is active. ${triggerNote}`,
      markup: buildMainMenu(eaEnabled, svEnabled)
    };
  }

  if (cmd === '/stop' || cmd === 'cmd_stop') {
    await setTradingHalted(true);
    const stopRes = await bybitClient.executeLiveEmergencyStop();
    await appendJournalEntry({ type: 'TG_EMERGENCY_STOP', ...stopRes });
    return {
      text: `🚨 *EMERGENCY STOP*\nClosed ${stopRes.closedCount} positions. Trading HALTED.`,
      markup: buildMainMenu(eaEnabled, svEnabled)
    };
  }

  if (cmd === '/resume' || cmd === 'cmd_resume') {
    await setTradingHalted(false);
    await appendJournalEntry({ type: 'TG_RESUME_TRADING' });
    return { text: `✅ *TRADING RESUMED* via Telegram.`, markup: buildMainMenu(eaEnabled, svEnabled) };
  }

  if (cmd === 'cmd_mode_strict' || cmd === 'cmd_mode_balanced' || (cmd === '/mode' && parts[1])) {
    const targetMode = (cmd === 'cmd_mode_balanced' || parts[1]?.toLowerCase() === 'balanced') ? 'balanced' : 'strict';
    await setBotFilters({ ...currentFilters, strategyMode: targetMode });
    return { text: `⚙️ Strategy Mode switched to *${targetMode.toUpperCase()}*.`, markup: buildMainMenu(eaEnabled, svEnabled) };
  }

  if (cmd === '/price' && parts[1]) {
    return { text: await fetchLivePrice(parts[1]), markup: buildMainMenu(eaEnabled, svEnabled) };
  }

  if (cmd === '/risk' && parts[1]) {
    const riskPct = Number(parts[1]);
    if (isNaN(riskPct) || riskPct <= 0 || riskPct > 20) {
      return { text: `⚠️ Valid risk % එකක් දෙන්න (උදා: \`/risk 2\`)`, markup: buildMainMenu(eaEnabled, svEnabled) };
    }
    await setBotFilters({ ...currentFilters, riskPct });
    return { text: `🎯 Risk per trade updated to *${riskPct}%*.`, markup: buildMainMenu(eaEnabled, svEnabled) };
  }

  if (cmd === '/lev' && parts[1]) {
    const leverage = Number(parts[1]);
    if (isNaN(leverage) || leverage < 1 || leverage > 50) {
      return { text: `⚠️ Valid leverage එකක් දෙන්න (උදා: \`/lev 10\`)`, markup: buildMainMenu(eaEnabled, svEnabled) };
    }
    await setBotFilters({ ...currentFilters, leverage });
    return { text: `⚡ Leverage updated to *${leverage}x*.`, markup: buildMainMenu(eaEnabled, svEnabled) };
  }

  if (cmd === '/close' && parts[1]) {
    const closeRes = await bybitClient.closeVerifiedLivePosition(parts[1].toUpperCase());
    return {
      text: closeRes.closed
        ? `🔒 *CLOSED ${closeRes.symbol}* | Qty: ${closeRes.qty}`
        : `⚠️ Could not close ${parts[1]}: ${closeRes.reason}`,
      markup: buildMainMenu(eaEnabled, svEnabled)
    };
  }

  if (cmd === '/tp50' && parts[1]) {
    const fn = typeof bybitClient.closePartialPosition === 'function'
      ? bybitClient.closePartialPosition
      : bybitEaHelpers.closePartialPosition;
    const res50 = await fn(parts[1].toUpperCase(), 0.5);
    return {
      text: res50.ok ? `✂️ *50% Partial Close (${parts[1].toUpperCase()}):* ${res50.message}` : `⚠️ ${res50.message}`,
      markup: buildMainMenu(eaEnabled, svEnabled)
    };
  }

  if (cmd === '/be' && parts[1]) {
    const fn = typeof bybitClient.moveStopLossToBreakeven === 'function'
      ? bybitClient.moveStopLossToBreakeven
      : bybitEaHelpers.moveStopLossToBreakeven;
    const resBe = await fn(parts[1].toUpperCase());
    return {
      text: resBe.ok ? `🛡️ *Breakeven SL (${parts[1].toUpperCase()}):* ${resBe.message}` : `⚠️ ${resBe.message}`,
      markup: buildMainMenu(eaEnabled, svEnabled)
    };
  }

  if (cmd === '/history' || cmd === 'cmd_history') {
    const fn = typeof bybitClient.fetchClosedPnlHistory === 'function'
      ? bybitClient.fetchClosedPnlHistory
      : bybitEaHelpers.fetchClosedPnlHistory;
    const list = await fn(5);
    const lines = list
      .map(t => `${Number(t.closedPnl) >= 0 ? '✅' : '🔻'} *${t.symbol}* (${t.side}): *$${Number(t.closedPnl).toFixed(2)}*`)
      .join('\n') || 'No recent closed trades.';
    return { text: `📜 *LAST 5 CLOSED TRADES*\n${lines}`, markup: buildMainMenu(eaEnabled, svEnabled) };
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
      markup: buildMainMenu(eaEnabled, svEnabled)
    };
  }

  return { text: `❓ Unknown command. Type \`/menu\` to see all options.`, markup: buildMainMenu(eaEnabled, svEnabled) };
}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') return res.status(200).send('OK');
    // Update 26: Telegram signs real webhook calls with X-Telegram-Bot-Api-Secret-Token.
    // Without this check anyone who knows the chat id could forge /stop, /resume or /nexttrade.
    const expectedHook = String(process.env.TELEGRAM_WEBHOOK_SECRET || '').trim();
    const providedHook = String(req.headers?.['x-telegram-bot-api-secret-token'] || '').trim();
    if (!expectedHook) {
      if (String(process.env.TELEGRAM_WEBHOOK_INSECURE_OK || '').toLowerCase() !== 'true') {
        console.error('[TG_WEBHOOK_BLOCKED] TELEGRAM_WEBHOOK_SECRET is not set (fail-closed).');
        return res.status(200).send('OK');
      }
    } else if (!safeCompareSecret(providedHook, expectedHook)) {
      console.error('[TG_WEBHOOK_BAD_SECRET]');
      return res.status(200).send('OK');
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
    if (reply.photoUrl) {
      await sendTelegramPhoto(reply.photoUrl, reply.text, reply.markup || null);
    } else {
      await sendTelegramAlert(reply.text, reply.markup || null);
    }
    return res.status(200).send('OK');
  } catch (err) {
    console.error('[TG_WEBHOOK_ERR]', err.message);
    await sendTelegramAlert(`🚨 *Webhook Error:* \`${err.message}\``);
    return res.status(200).send('OK');
  }
};
