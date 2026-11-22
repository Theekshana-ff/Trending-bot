// File: api/whatsapp-webhook.js (v11.1.1 — Added Debug Logging)
const {
  getTradingHalted, setTradingHalted, appendJournalEntry,
  getBotFilters, setBotFilters
} = require('../lib/modules/securityAndState');
const {
  fetchBybitWalletAndPositions, closeVerifiedLivePosition, executeLiveEmergencyStop
} = require('../lib/modules/bybitLiveClient');
const { fetchWithTimeout } = require('../lib/modules/marketData');

async function sendWhatsAppText(to, bodyText) {
  const token = (process.env.WHATSAPP_TOKEN || '').trim();
  const phoneId = (process.env.WHATSAPP_PHONE_ID || '').trim();
  if (!token || !phoneId || !to) {
    console.error('[WA_ERR] Missing config:', { hasToken: !!token, hasPhoneId: !!phoneId, to });
    return { sent: false, reason: 'WHATSAPP_NOT_CONFIGURED' };
  }

  try {
    const url = `https://graph.facebook.com/v21.0/${encodeURIComponent(phoneId)}/messages`;
    const r = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: String(to).replace(/[^0-9]/g, ''),
        type: 'text',
        text: { body: String(bodyText || '').slice(0, 3900) }
      })
    }, 5000);

    const respText = await r.text();
    if (!r.ok) {
      console.error('[WA_SEND_FAIL]', r.status, respText);
    } else {
      console.log('[WA_SEND_OK]', r.status, respText);
    }
    return { sent: r.ok, status: r.status };
  } catch (e) {
    console.error('[WA_SEND_EXCEPTION]', e.message);
    return { sent: false, reason: e.message };
  }
}

module.exports = async (req, res) => {
  try {
    // 1. Meta Webhook Verification (GET)
    if (req.method === 'GET') {
      const mode = req.query?.['hub.mode'];
      const token = req.query?.['hub.verify_token'];
      const challenge = req.query?.['hub.challenge'];
      const expectedToken = (process.env.WHATSAPP_VERIFY_TOKEN || '').trim();

      if (mode === 'subscribe' && expectedToken && token === expectedToken) {
        return res.status(200).send(String(challenge || ''));
      }
      return res.status(403).json({ ok: false, error: 'Webhook verification failed.' });
    }

    if (req.method !== 'POST') {
      return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
    }

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const entry = body?.entry?.[0];
    const change = entry?.changes?.[0]?.value;
    const msg = change?.messages?.[0];

    if (!msg || msg.type !== 'text' || !msg.text?.body) {
      console.log('[WA_IGNORE] Non-text or status update');
      return res.status(200).json({ ok: true });
    }

    const from = String(msg.from || '').replace(/[^0-9]/g, '');
    const allowedNum = String(process.env.WHATSAPP_ALLOWED_NUMBER || '').replace(/[^0-9]/g, '');
    console.log('[WA_INCOMING]', { from, allowedNum, text: msg.text.body });

    if (!allowedNum || from !== allowedNum) {
      console.error('[WA_UNAUTHORIZED]', { from, allowedNum });
      return res.status(200).json({ ok: false, error: 'Unauthorized WhatsApp number' });
    }

    const text = String(msg.text.body || '').trim();
    const parts = text.split(/\s+/);
    const cmd = parts[0].toLowerCase();

    if (cmd === '/status' || cmd === 'status') {
      const [acct, halted, filters] = await Promise.all([
        fetchBybitWalletAndPositions(),
        getTradingHalted(),
        getBotFilters()
      ]);
      const posLines = (acct.positions || [])
        .map(p => `- ${p.symbol} ${p.side} (${p.leverage}x) uPnL: $${Number(p.unrealisedPnl).toFixed(2)}`)
        .join('\n') || 'None';
      await sendWhatsAppText(
        from,
        `📊 *BYBIT BOT STATUS (v11.1)*\n` +
        `Halted: *${halted.halted ? 'YES' : 'NO'}*\n` +
        `Mode: *${String(filters?.strategyMode || 'strict').toUpperCase()}*\n` +
        `Avail: *$${acct.wallet.availableBalance.toFixed(2)}* | Equity: *$${acct.wallet.totalEquity.toFixed(2)}*\n` +
        `Positions:\n${posLines}`
      );
    } else if (cmd === '/stop' || cmd === 'stop') {
      await setTradingHalted(true);
      const stopRes = await executeLiveEmergencyStop();
      await appendJournalEntry({ type: 'WA_EMERGENCY_STOP', ...stopRes });
      await sendWhatsAppText(from, `🚨 *WHATSAPP EMERGENCY STOP*\nClosed ${stopRes.closedCount} positions. Trading HALTED.`);
    } else if (cmd === '/resume' || cmd === 'resume') {
      await setTradingHalted(false);
      await appendJournalEntry({ type: 'WA_RESUME_TRADING' });
      await sendWhatsAppText(from, `✅ *TRADING RESUMED* via WhatsApp.`);
    } else if ((cmd === '/close' || cmd === 'close') && parts[1]) {
      const closeRes = await closeVerifiedLivePosition(parts[1]);
      if (closeRes.closed) {
        await sendWhatsAppText(from, `🔒 *CLOSED ${closeRes.symbol}* | Qty: ${closeRes.qty}`);
      } else {
        await sendWhatsAppText(from, `⚠️ Could not close ${parts[1]}: ${closeRes.reason}`);
      }
    } else if ((cmd === '/mode' || cmd === 'mode') && parts[1]) {
      const targetMode = parts[1].toLowerCase() === 'balanced' ? 'balanced' : 'strict';
      const cur = await getBotFilters();
      await setBotFilters({ ...cur, strategyMode: targetMode });
      await sendWhatsAppText(from, `⚙️ Strategy Mode switched to *${targetMode.toUpperCase()}*.`);
    } else {
      await sendWhatsAppText(
        from,
        `🤖 *Bybit Bot WhatsApp Commands:*\n` +
        `/status — Wallet & Open Positions\n` +
        `/stop — Emergency Stop & Close All\n` +
        `/resume — Resume Trading\n` +
        `/close SOLUSDT — Close Position\n` +
        `/mode balanced — Switch to Balanced Mode\n` +
        `/mode strict — Switch to Strict Mode`
      );
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[WA_WEBHOOK_ERR]', err.message);
    return res.status(200).json({ ok: false, error: err.message });
  }
};
