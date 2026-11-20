// Module 21: Instant Telegram Trade & Guardian Notifier (v6)
const { fetchWithTimeout } = require('./marketData');

async function sendTelegramAlert(message) {
  const token = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
  const chatId = (process.env.TELEGRAM_CHAT_ID || '').trim();
  if (!token || !chatId) return { sent: false, reason: 'TELEGRAM_NOT_CONFIGURED' };

  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const r = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: String(message || '').slice(0, 3900),
        parse_mode: 'HTML',
        disable_web_page_preview: true
      })
    }, 3500);
    return { sent: r.ok, status: r.status };
  } catch (e) {
    return { sent: false, reason: e.message };
  }
}

module.exports = { sendTelegramAlert };
