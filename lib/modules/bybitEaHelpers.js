// File: lib/modules/bybitEaHelpers.js (v12.4)
// Self-contained Bybit V5 signed helpers + exact lotSizeFilter (qtyStep/minOrderQty) formatter

const crypto = require('crypto');

function getBybitBaseUrl() {
  const isTestnet =
    String(process.env.BYBIT_TESTNET || '').toLowerCase() === 'true' ||
    String(process.env.BYBIT_ENV || '').toLowerCase() === 'testnet';
  return isTestnet ? 'https://api-testnet.bybit.com' : 'https://api.bybit.com';
}

async function bybitPrivateRequest(method, endpoint, params = {}) {
  const apiKey = process.env.BYBIT_API_KEY;
  const apiSecret = process.env.BYBIT_API_SECRET;
  if (!apiKey || !apiSecret) {
    throw new Error('Missing BYBIT_API_KEY or BYBIT_API_SECRET');
  }

  const timestamp = Date.now().toString();
  const recvWindow = '5000';
  const baseUrl = getBybitBaseUrl();

  let url = `${baseUrl}${endpoint}`;
  let payloadStr = '';

  if (method === 'GET') {
    const qs = new URLSearchParams(params).toString();
    if (qs) url += `?${qs}`;
    payloadStr = qs;
  } else {
    payloadStr = JSON.stringify(params);
  }

  const signStr = timestamp + apiKey + recvWindow + payloadStr;
  const signature = crypto.createHmac('sha256', apiSecret).update(signStr).digest('hex');

  const headers = {
    'X-BAPI-API-KEY': apiKey,
    'X-BAPI-SIGN': signature,
    'X-BAPI-TIMESTAMP': timestamp,
    'X-BAPI-RECV-WINDOW': recvWindow,
    'Content-Type': 'application/json'
  };

  const resp = await fetch(url, {
    method,
    headers,
    body: method === 'POST' ? payloadStr : undefined
  });

  const data = await resp.json();
  if (data.retCode !== 0) {
    throw new Error(data.retMsg || `Bybit API error (${data.retCode})`);
  }
  return data.result;
}

async function formatValidBybitQty(symbol, rawQty) {
  const cleanSym = String(symbol).toUpperCase();
  const baseUrl = getBybitBaseUrl();
  const resp = await fetch(`${baseUrl}/v5/market/instruments-info?category=linear&symbol=${cleanSym}`);
  const data = await resp.json();
  const info = data?.result?.list?.[0];
  const lot = info?.lotSizeFilter;

  if (!lot) return { valid: false, qty: '0', reason: `No lotSizeFilter for ${cleanSym}` };

  const minQty = Number(lot.minOrderQty || 0);
  const step = Number(lot.qtyStep || 0.001);
  const stepStr = String(lot.qtyStep || '0.001');
  const decimals = stepStr.includes('.') ? stepStr.split('.')[1].length : 0;

  let adjusted = Math.floor(Number(rawQty) / step) * step;
  if (adjusted < minQty) {
    adjusted = minQty;
  }

  const formatted = adjusted.toFixed(decimals);
  return {
    valid: Number(formatted) >= minQty && Number(formatted) > 0,
    qty: formatted,
    minQty,
    step
  };
}

async function placeMarketOrder({ symbol, side, qty, stopLoss, takeProfit }) {
  const cleanSym = String(symbol).toUpperCase();
  const qtyInfo = await formatValidBybitQty(cleanSym, qty);
  if (!qtyInfo.valid) {
    throw new Error(`Qty invalid for ${cleanSym} (min: ${qtyInfo.minQty})`);
  }

  const payload = {
    category: 'linear',
    symbol: cleanSym,
    side,
    orderType: 'Market',
    qty: qtyInfo.qty
  };
  if (stopLoss) payload.stopLoss = String(stopLoss);
  if (takeProfit) payload.takeProfit = String(takeProfit);
  return bybitPrivateRequest('POST', '/v5/order/create', payload);
}

async function fetchClosedPnlHistory(limit = 5) {
  const result = await bybitPrivateRequest('GET', '/v5/position/closed-pnl', {
    category: 'linear',
    limit: String(limit)
  });
  return (result?.list || []).map(item => ({
    symbol: item.symbol,
    side: item.side,
    qty: item.qty,
    avgEntryPrice: item.avgEntryPrice,
    avgExitPrice: item.avgExitPrice,
    closedPnl: Number(item.closedPnl || 0),
    createdTime: item.createdTime
  }));
}

async function getOpenPosition(symbol) {
  const cleanSym = String(symbol || '').toUpperCase();
  const result = await bybitPrivateRequest('GET', '/v5/position/list', {
    category: 'linear',
    symbol: cleanSym
  });
  const list = result?.list || [];
  return list.find(p => Number(p.size || 0) > 0) || null;
}

async function closePartialPosition(symbol, ratio = 0.5) {
  const cleanSym = String(symbol || '').toUpperCase();
  const pos = await getOpenPosition(cleanSym);
  if (!pos) return { ok: false, message: `No open position found for ${cleanSym}` };

  const rawClose = Number(pos.size) * ratio;
  const qtyInfo = await formatValidBybitQty(cleanSym, rawClose);
  if (!qtyInfo.valid || Number(qtyInfo.qty) >= Number(pos.size)) {
    return { ok: false, message: `Position size too small to split (${pos.size})` };
  }

  const closeSide = pos.side === 'Buy' ? 'Sell' : 'Buy';
  await bybitPrivateRequest('POST', '/v5/order/create', {
    category: 'linear',
    symbol: cleanSym,
    side: closeSide,
    orderType: 'Market',
    qty: qtyInfo.qty,
    reduceOnly: true
  });

  return {
    ok: true,
    symbol: cleanSym,
    closedQty: qtyInfo.qty,
    message: `Closed ${Math.round(ratio * 100)}% (${qtyInfo.qty}) of ${cleanSym}`
  };
}

async function moveStopLossToBreakeven(symbol) {
  const cleanSym = String(symbol || '').toUpperCase();
  const pos = await getOpenPosition(cleanSym);
  if (!pos) return { ok: false, message: `No open position found for ${cleanSym}` };

  const entryPrice = String(pos.avgPrice);
  await bybitPrivateRequest('POST', '/v5/position/trading-stop', {
    category: 'linear',
    symbol: cleanSym,
    stopLoss: entryPrice,
    positionIdx: Number(pos.positionIdx || 0)
  });

  return {
    ok: true,
    symbol: cleanSym,
    stopLoss: entryPrice,
    message: `Stop Loss moved to Breakeven ($${entryPrice})`
  };
}

module.exports = {
  formatValidBybitQty,
  placeMarketOrder,
  fetchClosedPnlHistory,
  closePartialPosition,
  moveStopLossToBreakeven
};
