// lib/telegram.js — Compatible with Original My Bybit AI Trader Reply Keyboard + v18.1 Controls

export function getTelegramChatId(overrideChatId) {
  return String(
    overrideChatId ||
    process.env.TELEGRAM_CHAT_ID ||
    process.env.TELEGRAM_ADMIN_CHAT_ID ||
    ''
  );
}

export async function sendTelegram(text, replyMarkup = undefined, chatIdOverride = undefined) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = getTelegramChatId(chatIdOverride);
  if (!token || !chatId) return { ok: false, skipped: true };

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        reply_markup: replyMarkup,
      }),
    });
    return await res.json();
  } catch (err) {
    console.error('[Telegram Error]', err.message);
    return { ok: false, error: err.message };
  }
}

export async function answerCallback(callbackQueryId, text = '') {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !callbackQueryId) return;
  await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
  }).catch(() => {});
}

/**
 * Matches the exact Reply Keyboard layout from the user's original Telegram Bot
 */
export function buildMainMenuKeyboard(config) {
  const svStatusLabel = config.svModeOn ? '⚡ SV Mode: ON 🟢' : '⚡ SV Mode: OFF 🔴';
  const presetIcon = config.tradeMode === 'FAST' ? '⚡ FAST' : '🛡️ SAFE';
  const presetLabel = `🎚️ ${presetIcon} ($${config.marginUsdt} / ${config.leverage}x)`;

  return {
    keyboard: [
      [{ text: '📜 History' }, { text: '📈 Daily PnL' }],
      [{ text: '✅ Resume' }, { text: '🚨 Emergency Stop' }],
      [{ text: '⚡ SV Status' }, { text: '▶ Run SV Now' }],
      [{ text: svStatusLabel }, { text: presetLabel }],
      [{ text: '📊 Wallet & Positions' }, { text: '🔥 Coin Heatmap' }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };
}

export function buildPositionButtons(symbol) {
  return {
    inline_keyboard: [
      [
        { text: '🔒 Move SL to BE', callback_data: `v18_be:${symbol}` },
        { text: '💰 Quick Cut Now', callback_data: `v18_cut:${symbol}` },
      ],
      [
        { text: '🚨 Emergency Stop', callback_data: 'v18_stop_all' },
      ],
    ],
  };
}
