// Module 14: Live Bybit V5 Private Client, Isolated Margin, Auto Trailing Stop & Closed PnL Analytics (v5)
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
          'User-Agent': 'BybitQuantBot/5.0'
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
      tradeMode: p.tradeMode, // 0=Cross, 1=Isolated
      unrealisedPnl: Number(p.unrealisedPnl || 0),
      stopLoss: p.stopLoss || '',
      takeProfit: p.takeProfit || '',
      trailingStop: p.trailingStop || '',
      hasSlProtection: Number(p.stopLoss || 0) > 0
    }));

  const unrealizedPnl = openPositions.reduce((acc, p) => acc + p.unrealisedPnl, 0);
  return {
    wallet: { availableBalance, totalEquity, unrealizedPnl },
    positions: openPositions
  };
}

// v5: Fetch real closed PnL stats from Bybit for Win Rate Donut & Best Trade
async function fetchBybitClosedPnlStats(limit = 50) {
  try {
    const res = await bybitV5Req('GET', '/v5/position/closed-pnl', { category: 'linear', limit: String(limit) });
    const list = res?.list || [];
    let wins = 0;
    let losses = 0;
    let totalPnl = 0;
    let bestTrade = 0;

    list.forEach(item => {
      const pnl = Number(item.closedPnl || 0);
      totalPnl += pnl;
      if (pnl > 0) wins++;
      else if (pnl < 0) losses++;
      if (pnl > bestTrade) bestTrade = pnl;
    });

    const total = wins + losses;
    const winRate = total > 0 ? +((wins / total) * 100).toFixed(1) : 0;
    return {
      ok: true,
      wins,
      losses,
      totalTrades: total,
      winRate,
      totalClosedPnl: +totalPnl.toFixed(4),
      bestTrade: +bestTrade.toFixed(4),
      recent: list.slice(0, 10).map(x => ({
        symbol: x.symbol,
        side: x.side,
        closedPnl: Number(x.closedPnl || 0),
        avgEntryPrice: x.avgEntryPrice,
        avgExitPrice: x.avgExitPrice,
        updatedTime: x.updatedTime
      }))
    };
  } catch (e) {
    return { ok: false, wins: 0, losses: 0, totalTrades: 0, winRate: 0, totalClosedPnl: 0, bestTrade: 0, recent: [], error: e.message };
  }
}

// v5: Auto-configure Isolated Margin + Dynamic Leverage before live order
async function configureIsolatedAndLeverage(symbol, leverage) {
  const sym = toBybitSymbol(symbol);
  const levStr = String(Math.min(20, Math.max(1, Number(leverage || 5))));
  let isolatedSet = false;
  let leverageSet = false;

  try {
    await bybitV5Req('POST', '/v5/position/switch-isolated', {
      category: 'linear',
      symbol: sym,
      tradeMode: 1, // 1 = Isolated Margin
      buyLeverage: levStr,
      sellLeverage: levStr
    });
    isolatedSet = true;
    leverageSet = true;
  } catch (e) {
    // 110026 = already isolated; fall through to set-leverage
    if (String(e.message || '').includes('110026')) isolatedSet = true;
  }

  if (!leverageSet) {
    try {
      await bybitV5Req('POST', '/v5/position/set-leverage', {
        category: 'linear',
        symbol: sym,
        buyLeverage: levStr,
        sellLeverage: levStr
      });
      leverageSet = true;
    } catch (e) {
      if (String(e.message || '').includes('110043')) leverageSet = true; // already set
    }
  }
  return { isolatedSet, leverageSet, leverage: levStr };
}

const { formatBybitQty } = require('./riskAndValidation');
const { hasPartialTpDone, markPartialTpDone } = require('./securityAndState');

// v6 Update #4: Partial Take Profit (50% lock at +1.5R) + Auto Breakeven & Trailing Stop
async function applyTrailingAndBreakeven(positions = [], instMap = {}) {
  const updates = [];
  for (const pos of positions) {
    const entry = Number(pos.avgPrice || 0);
    const mark = Number(pos.markPrice || 0);
    const sl = Number(pos.stopLoss || 0);
    const size = Number(pos.size || 0);
    if (entry <= 0 || mark <= 0 || sl <= 0 || size <= 0) continue;

    const isLong = pos.side === 'Buy';
    const riskDist = Math.abs(entry - sl);
    if (riskDist <= 0) continue;

    const profitDist = isLong ? (mark - entry) : (entry - mark);
    const rMultiple = profitDist / riskDist;

    if (rMultiple >= 1.5) {
      // 1. Partial TP1: Close 50% of position once at +1.5R
      const alreadyPartial = await hasPartialTpDone(pos.symbol, pos.avgPrice);
      if (!alreadyPartial) {
        const spec = instMap[pos.symbol] || {};
        const qtyStep = Number(spec.qtyStep || 0.01);
        const minQty = Number(spec.minOrderQty || qtyStep);
        const halfQty = formatBybitQty(size * 0.5, qtyStep);

        if (halfQty >= minQty && halfQty < size) {
          try {
            const closeSide = isLong ? 'Sell' : 'Buy';
            const res = await bybitV5Req('POST', '/v5/order/create', {
              category: 'linear',
              symbol: pos.symbol,
              side: closeSide,
              orderType: 'Market',
              qty: String(halfQty),
              reduceOnly: true,
              positionIdx: 0
            });
            await markPartialTpDone(pos.symbol, pos.avgPrice);
            updates.push({ symbol: pos.symbol, action: 'PARTIAL_TP1_50PCT_LOCKED', closedQty: halfQty, rMultiple: +rMultiple.toFixed(2), orderId: res?.orderId || null });
          } catch (e) {
            updates.push({ symbol: pos.symbol, action: 'PARTIAL_TP1_FAILED', error: e.message });
          }
        }
      }

      // 2. Move remaining SL to Breakeven + activate Trailing Stop
      const slAlreadyProtected = isLong ? (sl >= entry) : (sl <= entry);
      if (!slAlreadyProtected) {
        const bePrice = isLong ? +(entry * 1.0015).toPrecision(6) : +(entry * 0.9985).toPrecision(6);
        const trailDist = +(Math.max(riskDist * 0.8, entry * 0.004)).toPrecision(5);
        try {
          await bybitV5Req('POST', '/v5/position/trading-stop', {
            category: 'linear',
            symbol: pos.symbol,
            stopLoss: String(bePrice),
            trailingStop: String(trailDist),
            positionIdx: 0
          });
          updates.push({ symbol: pos.symbol, action: 'BREAKEVEN_AND_TRAILING_SET', bePrice, trailDist, rMultiple: +rMultiple.toFixed(2) });
        } catch (e) {
          updates.push({ symbol: pos.symbol, action: 'TRAILING_UPDATE_FAILED', error: e.message });
        }
      }
    }
  }
  return updates;
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
  let cancelledOrders = false;
  try {
    await bybitV5Req('POST', '/v5/order/cancel-all', { category: 'linear', settleCoin: 'USDT' });
    cancelledOrders = true;
  } catch (e) {
    cancelledOrders = false;
  }

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
  fetchBybitClosedPnlStats,
  configureIsolatedAndLeverage,
  applyTrailingAndBreakeven,
  closeVerifiedLivePosition,
  executeLiveEmergencyStop
};
