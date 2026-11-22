// File: lib/modules/telegramAlerts.js
async function sendTelegramAlert(text, replyMarkup = null) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return { ok: false, reason: 'Missing Telegram env vars' };

  const payload = {
    chat_id: chatId,
    text: String(text || '').slice(0, 4000),
    parse_mode: 'Markdown'
  };
  if (replyMarkup) payload.reply_markup = replyMarkup;

  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    return await resp.json();
  } catch (err) {
    console.error('[TG_ALERT_ERR]', err.message);
    return { ok: false, error: err.message };
  }
}

async function alertTradeOpened({ symbol, side, qty, entryPrice, leverage, sl, tp }) {
  return sendTelegramAlert(
    `🚀 *NEW TRADE OPENED*\n` +
    `Coin: *${symbol}* (${side} ${leverage}x)\n` +
    `Entry: *$${entryPrice}* | Qty: *${qty}*\n` +
    `SL: *$${sl || 'N/A'}* | TP: *$${tp || 'N/A'}*`
  );
}

async function alertTradeClosed({ symbol, side, pnl }) {
  const icon = Number(pnl) >= 0 ? '✅' : '🔻';
  return sendTelegramAlert(
    `${icon} *TRADE CLOSED*\n` +
    `Coin: *${symbol}* (${side})\n` +
    `Realized PnL: *$${Number(pnl).toFixed(2)}*`
  );
}

async function alertMarginWarning(availableBalance, equity) {
  return sendTelegramAlert(
    `⚠️ *LOW MARGIN WARNING*\n` +
    `Available: *$${Number(availableBalance).toFixed(2)}*\n` +
    `Total Equity: *$${Number(equity).toFixed(2)}*\n` +
    `Check open positions immediately!`
  );
}

async function alertSystemError(context, errorMsg) {
  return sendTelegramAlert(`🚨 *BOT ERROR (${context})*\n\`${errorMsg}\``);
}

module.exports = {
  sendTelegramAlert,
  alertTradeOpened,
  alertTradeClosed,
  alertMarginWarning,
  alertSystemError
};
