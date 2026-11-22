// File: lib/modules/telegramAlerts.js (v12.6 — Alerts + Chart Snapshot Photo)
async function sendTelegramAlert(text, replyMarkup = null) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    return { ok: false, reason: 'Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID' };
  }

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

async function sendTelegramPhoto(photoUrl, caption = '', replyMarkup = null) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId || !photoUrl) {
    return sendTelegramAlert(caption, replyMarkup);
  }

  const payload = {
    chat_id: chatId,
    photo: photoUrl,
    caption: String(caption || '').slice(0, 1000),
    parse_mode: 'Markdown'
  };
  if (replyMarkup) payload.reply_markup = replyMarkup;

  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await resp.json();
    if (!data.ok) {
      return sendTelegramAlert(caption, replyMarkup);
    }
    return data;
  } catch (err) {
    console.error('[TG_PHOTO_ERR]', err.message);
    return sendTelegramAlert(caption, replyMarkup);
  }
}

function buildQuickChartUrl({ symbol, closes = [], entry = null, sl = null, tp = null, signal = 'HOLD' }) {
  if (!Array.isArray(closes) || closes.length < 5) return null;
  const pts = closes.slice(-30);
  const labels = pts.map((_, i) => String(i + 1));
  const datasets = [
    {
      label: `${symbol} (15M)`,
      data: pts,
      borderColor: signal === 'BUY' ? '#10b981' : signal === 'SELL' ? '#f43f5e' : '#38bdf8',
      backgroundColor: 'rgba(56,189,248,0.08)',
      borderWidth: 2,
      pointRadius: 0,
      fill: true
    }
  ];

  if (entry && Number(entry) > 0) {
    datasets.push({
      label: `Entry ${entry}`,
      data: pts.map(() => Number(entry)),
      borderColor: '#38bdf8',
      borderDash: [4, 4],
      borderWidth: 1.5,
      pointRadius: 0,
      fill: false
    });
  }
  if (sl && Number(sl) > 0) {
    datasets.push({
      label: `SL ${sl}`,
      data: pts.map(() => Number(sl)),
      borderColor: '#ef4444',
      borderDash: [5, 3],
      borderWidth: 1.5,
      pointRadius: 0,
      fill: false
    });
  }
  if (tp && Number(tp) > 0) {
    datasets.push({
      label: `TP ${tp}`,
      data: pts.map(() => Number(tp)),
      borderColor: '#22c55e',
      borderDash: [5, 3],
      borderWidth: 1.5,
      pointRadius: 0,
      fill: false
    });
  }

  const cfg = {
    type: 'line',
    data: { labels, datasets },
    options: {
      title: { display: true, text: `${symbol} · EA ${signal}`, fontColor: '#e2e8f0' },
      legend: { labels: { fontColor: '#cbd5e1', boxWidth: 12 } },
      scales: {
        xAxes: [{ ticks: { display: false }, gridLines: { color: '#1e293b' } }],
        yAxes: [{ ticks: { fontColor: '#94a3b8' }, gridLines: { color: '#1e293b' } }]
      }
    }
  };

  return `https://quickchart.io/chart?w=600&h=320&bkg=%230f172a&c=${encodeURIComponent(JSON.stringify(cfg))}`;
}

async function alertTradeOpened({ symbol, side, qty, entryPrice, leverage, sl, tp, eaScore }) {
  const eaLine = eaScore ? `\nEA Quality Score: *${eaScore}/100*` : '';
  return sendTelegramAlert(
    `🚀 *NEW TRADE OPENED*\n` +
    `Coin: *${symbol}* (${side} ${leverage || ''}x)\n` +
    `Entry: *$${entryPrice}* | Qty: *${qty}*\n` +
    `SL: *$${sl || 'N/A'}* | TP: *$${tp || 'N/A'}*${eaLine}`
  );
}

async function alertTradeClosed({ symbol, side, pnl }) {
  const numPnl = Number(pnl || 0);
  const icon = numPnl >= 0 ? '✅' : '🔻';
  return sendTelegramAlert(
    `${icon} *TRADE CLOSED*\n` +
    `Coin: *${symbol}* (${side || 'N/A'})\n` +
    `Realized PnL: *$${numPnl.toFixed(2)}*`
  );
}

async function alertMarginWarning(availableBalance, equity) {
  return sendTelegramAlert(
    `⚠️ *LOW MARGIN WARNING*\n` +
    `Available: *$${Number(availableBalance || 0).toFixed(2)}*\n` +
    `Total Equity: *$${Number(equity || 0).toFixed(2)}*\n` +
    `Check open positions immediately!`
  );
}

async function alertSystemError(context, errorMsg) {
  return sendTelegramAlert(`🚨 *BOT ERROR (${context})*\n\`${String(errorMsg || 'Unknown error')}\``);
}

module.exports = {
  sendTelegramAlert,
  sendTelegramPhoto,
  buildQuickChartUrl,
  alertTradeOpened,
  alertTradeClosed,
  alertMarginWarning,
  alertSystemError
};
