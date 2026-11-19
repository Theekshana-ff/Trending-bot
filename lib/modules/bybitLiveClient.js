// Module 14: Live Bybit V5 Private Client & Position Monitor
const crypto = require('crypto');
const { getBybitBaseUrls, fetchWithTimeout, safeReadJson, toBybitSymbol } = require('./marketData');

const signBybitV5 = (apiKey, secret, ts, recvWindow, paramStr) =>
  crypto.createHmac('sha256', secret).update(ts + apiKey + recvWindow + paramStr).digest('hex');

async function bybitV5Req(method, pathUrl, payload = null) {
  const apiKey = (process.env.BYBIT_API_KEY || '').trim();
  const secret = (process.env.BYBIT_API_SECRET || '').trim();
  if (!apiKey || !secret) {
    throw new Error('BYBIT_KEYS_MISSING: Configure BYBIT_API_KEY and BYBIT_API_SECRET in Vercel Environment Variables.');
  }

  const bases = getBybitBaseUrls();
  let lastErr = null;

  for (const base of bases) {
    const ts = Date.now().toString();
    const recvWindow = '5000';
    let url = `${base}${pathUrl}`;
    let paramStr = '';
    let body = undefined;

    if (method === 'GET' && payload) {
      paramStr = Object.keys(payload).sort().map(k => `${k}=${encodeURIComponent(payload[k])}`).join('&');
      if (paramStr) url += '?' + paramStr;
    } else if (method === 'POST' && payload) {
      paramStr = JSON.stringify(payload);
      body = paramStr;
    }

    const sig = signBybitV5(apiKey, secret, ts, recvWindow, paramStr);
    try {
      const r = await fetchWithTimeout(url, {
        method,
        headers: {
          'X-BAPI-API-KEY': apiKey,
          'X-BAPI-TIMESTAMP': ts,
          'X-BAPI-RECV-WINDOW': recvWindow,
          'X-BAPI-SIGN': sig,
          'Content-Type': 'application/json',
          'User-Agent': 'BybitQuantBot/3.0'
        },
        body
      }, 4500);

      const j = await safeReadJson(r, `Bybit V5 (${base})`);
      if (j.retCode !== 0) {
        throw new Error(`Bybit V5 Error (${j.retCode}): ${j.retMsg || 'Unknown error'}`);
      }
      return j.result;
    } catch (e) {
      lastErr = e;
      if (String(e.message || '').includes('Bybit V5 Error')) throw e;
    }
  }
  throw lastErr || new Error('BYBIT_PRIVATE_UNREACHABLE');
}

async function fetchBybitWalletAndPositions() {
  const [walletRes, posRes] = await Promise.all([
    bybitV5Req('GET', '/v5/account/wallet-balance', { accountType: 'UNIFIED', coin: 'USDT' }),
    bybitV5Req('GET', '/v5/position/list', { category: 'linear', settleCoin: 'USDT' })
  ]);

  const acct = walletRes?.list?.[0] || {};
  const usdtCoin = (acct.coin || []).find(c => c.coin === 'USDT') || {};
  const availableBalance = Number(usdtCoin.availableToWithdraw || acct.totalAvailableBalance || usdtCoin.walletBalance || 0);
  const totalEquity = Number(acct.totalEquity || usdtCoin.equity || availableBalance);

  const openPositions = (posRes?.list || [])
    .filter(p => Number(p.size || 0) > 0)
    .map(p => ({
      symbol: p.symbol,
      side: p.side,
      size: String(p.size),
      avgPrice: Number(p.avgPrice || 0),
      markPrice: Number(p.markPrice || 0),
      leverage: p.leverage,
      unrealisedPnl: Number(p.unrealisedPnl || 0),
      stopLoss: p.stopLoss || '',
      takeProfit: p.takeProfit || '',
      hasSlProtection: Number(p.stopLoss || 0) > 0
    }));

  const unrealizedPnl = openPositions.reduce((acc, p) => acc + p.unrealisedPnl, 0);
  return {
    wallet: { availableBalance, totalEquity, unrealizedPnl },
    positions: openPositions
  };
}

async function closeVerifiedLivePosition(symbol) {
  const targetSym = toBybitSymbol(symbol);
  const acct = await fetchBybitWalletAndPositions();
  const pos = acct.positions.find(p => p.symbol === targetSym && Number(p.size) > 0);
  if (!pos) {
    return { closed: false, errorCode: 'POSITION_NOT_FOUND', reason: `No open Bybit live position found for ${targetSym}.` };
  }
  const closeSide = pos.side === 'Buy' ? 'Sell' : 'Buy';
  const orderRes = await bybitV5Req('POST', '/v5/order/create', {
    category: 'linear',
    symbol: pos.symbol,
    side: closeSide,
    orderType: 'Market',
    qty: pos.size,
    reduceOnly: true,
    positionIdx: 0
  });
  return { closed: true, symbol: pos.symbol, side: closeSide, qty: pos.size, orderId: orderRes?.orderId || null };
}

async function executeLiveEmergencyStop() {
  // 1. Cancel all resting linear orders
  let cancelledOrders = false;
  try {
    await bybitV5Req('POST', '/v5/order/cancel-all', { category: 'linear', settleCoin: 'USDT' });
    cancelledOrders = true;
  } catch (e) {
    cancelledOrders = false;
  }

  // 2. Fetch and close every verified open position
  const acct = await fetchBybitWalletAndPositions();
  const closed = [];
  const failed = [];
  for (const pos of acct.positions) {
    try {
      const orderRes = await bybitV5Req('POST', '/v5/order/create', {
        category: 'linear',
        symbol: pos.symbol,
        side: pos.side === 'Buy' ? 'Sell' : 'Buy',
        orderType: 'Market',
        qty: pos.size,
        reduceOnly: true,
        positionIdx: 0
      });
      closed.push({ symbol: pos.symbol, qty: pos.size, orderId: orderRes?.orderId || null });
    } catch (e) {
      failed.push({ symbol: pos.symbol, error: e.message });
    }
  }
  return { cancelledOrders, closedCount: closed.length, closed, failed };
}

module.exports = {
  signBybitV5,
  bybitV5Req,
  fetchBybitWalletAndPositions,
  closeVerifiedLivePosition,
  executeLiveEmergencyStop
};
