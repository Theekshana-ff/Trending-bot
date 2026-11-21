// File: api/telegram-webhook.js (v9.0 #2 Interactive Telegram Bot Commands)
// Supported commands: /status, /stop, /resume, /close <SYMBOL>
const { getTradingHalted, setTradingHalted, appendJournalEntry } = require('../lib/modules/securityAndState');
const { fetchBybitWalletAndPositions, closeVerifiedLivePosition, executeLiveEmergencyStop } = require('../lib/modules/bybitLiveClient');
const { sendTelegramAlert } = require('../lib/modules/telegramNotifier');

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') {
      return res.status(200).json({ ok: true, message: 'Telegram webhook active.' });
    }
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const msg = body.message || body.edited_message;
    if (!msg || !msg.text) return res.status(200).json({ ok: true });

    const allowedChatId = String(process.env.TELEGRAM_CHAT_ID || '').trim();
    const incomingChatId = String(msg.chat?.id || '').trim();
    if (!allowedChatId || incomingChatId !== allowedChatId) {
      return res.status(403).json({ ok: false, error: 'Unauthorized Telegram Chat ID' });
    }

    const text = String(msg.text || '').trim();
    const parts = text.split(/\s+/);
    const cmd = parts[0].toLowerCase();

    if (cmd === '/status') {
      const [acct, halted] = await Promise.all([
        fetchBybitWalletAndPositions(),
        getTradingHalted()
      ]);
      const posLines = (acct.positions || []).map(p => `- ${p.symbol} ${p.side} (${p.leverage}x) uPnL: $${Number(p.unrealisedPnl).toFixed(2)}`).join('\n') || 'None';
      await sendTelegramAlert(
        `📊 <b>BOT STATUS (v9.0)</b>\n` +
        `Halted: <b>${halted.halted ? 'YES' : 'NO'}</b>\n` +
        `Avail: <b>$${acct.wallet.availableBalance.toFixed(2)}</b> | Equity: <b>$${acct.wallet.totalEquity.toFixed(2)}</b>\n` +
        `Positions:\n${posLines}`
      );
    } else if (cmd === '/stop') {
      await setTradingHalted(true);
      const stopRes = await executeLiveEmergencyStop();
      await appendJournalEntry({ type: 'TG_EMERGENCY_STOP', ...stopRes });
      await sendTelegramAlert(`🚨 <b>TELEGRAM EMERGENCY STOP</b>\nClosed ${stopRes.closedCount} positions. Trading HALTED.`);
    } else if (cmd === '/resume') {
      await setTradingHalted(false);
      await appendJournalEntry({ type: 'TG_RESUME_TRADING' });
      await sendTelegramAlert(`✅ <b>TRADING RESUMED</b> via Telegram.`);
    } else if (cmd === '/close' && parts[1]) {
      const closeRes = await closeVerifiedLivePosition(parts[1]);
      if (closeRes.closed) {
        await sendTelegramAlert(`🔒 <b>CLOSED ${closeRes.symbol}</b> | Qty: ${closeRes.qty}`);
      } else {
        await sendTelegramAlert(`⚠️ Could not close ${parts[1]}: ${closeRes.reason}`);
      }
    } else {
      await sendTelegramAlert(`🤖 <b>Commands:</b>\n/status — Wallet & Positions\n/stop — Emergency Stop & Close All\n/resume — Resume Trading\n/close SOLUSDT — Close Position`);
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(200).json({ ok: false, error: err.message });
  }
};
