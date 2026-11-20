// Module 14: Live Bybit V5 Private Client — Production-Hardened v8
// Fixes: Idempotent orderLinkId, Open Orders & Stale Limit Cleanup, tickSize Precision,
// Original-R Partial TP1, Consecutive Losses Tracking, Honest UTA Margin Mode, Non-Silent Cancel-All
const crypto = require('crypto');
const { getBybitBaseUrls, fetchWithTimeout, safeReadJson, toBybitSymbol } = require('./marketData');
const { formatBybitQty, formatBybitPrice } = require('./riskAndValidation');
const { getPositionMeta, markPositionPartialTpDone } = require('./securityAndState');

const signBybitV5 = (apiKey, secret, ts, recvWindow, paramStr) =>
  crypto.createHmac('sha256', secret).update(ts + apiKey + recvWindow + paramStr).digest('hex');

async function bybitV5Req(method, pathUrl, payload = null) {
  const apiKey = (process.env.BYBIT_API_KEY || '').trim();
  const secret = (process.env.BYBIT_API_SECRET || '').trim();
  if (!apiKey || !secret) {
    throw new Error('BYBIT_KEYS_MISSING: Configure BYBIT_API_KEY and BYBIT_API_SECRET in Vercel Environment Variables.');
  }

  // Idempotency: attach a stable orderLinkId before retrying across hosts
  let finalPayload = payload;
  if (method === 'POST' && pathUrl === '/v5/order/create' && payload && !payload.orderLinkId) {
    finalPayload = {
      ...payload,
      orderLinkId: `bot_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`
    };
  }

  const bases = getBybitBaseUrls();
  let lastErr = null;

  for (const base of bases) {
    const ts = Date.now().toString();
    const recvWindow = '5000';
    let url = `${base}${pathUrl}`;
    let paramStr = '';
    let body = undefined;

    if (method === 'GET' && finalPayload) {
      paramStr = Object.keys(finalPayload).sort().map(k => `${k}=${encodeURIComponent(finalPayload[k])}`).join('&');
      if (paramStr) url += '?' + paramStr;
    } else if (method === 'POST' && finalPayload) {
      paramStr = JSON.stringify(finalPayload);
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
          'User-Agent': 'BybitQuantBot/8.0'
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
  const [walletRes, posRes, openOrdRes] = await Promise.all([
    bybitV5Req('GET', '/v5/account/wallet-balance', { accountType: 'UNIFIED', coin: 'USDT' }),
    bybitV5Req('GET', '/v5/position/list', { category: 'linear', settleCoin: 'USDT' }),
    bybitV5Req('GET', '/v5/order/realtime', { category: 'linear', settleCoin: 'USDT', limit: '50' }).catch(() => ({ list: [] }))
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
      tradeMode: p.tradeMode,
      unrealisedPnl: Number(p.unrealisedPnl || 0),
      stopLoss: p.stopLoss || '',
      takeProfit: p.takeProfit || '',
      trailingStop: p.trailingStop || '',
      hasSlProtection: Number(p.stopLoss || 0) > 0
    }));

  const openOrders = (openOrdRes?.list || []).map(o => ({
    orderId: o.orderId,
    symbol: o.symbol,
    side: o.side,
    orderType: o.orderType,
    price: Number(o.price || 0),
    qty: String(o.qty || '0'),
    createdTime: Number(o.createdTime || 0)
  }));

  const unrealizedPnl = openPositions.reduce((acc, p) => acc + p.unrealisedPnl, 0);
  return {
    wallet: { availableBalance, totalEquity, unrealizedPnl },
    positions: openPositions,
    openOrders
  };
}

// v8: Auto-cancel stale unfilled Limit orders older than maxAgeMinutes (default 45m)
async function cancelStaleLimitOrders(openOrders = [], maxAgeMinutes = 45) {
  const cutoff = Date.now() - maxAgeMinutes * 60 * 1000;
  const cancelled = [];
  for (const o of openOrders) {
    if (o.orderType === 'Limit' && o.createdTime > 0 && o.createdTime < cutoff) {
      try {
        await bybitV5Req('POST', '/v5/order/cancel', {
          category: 'linear',
          symbol: o.symbol,
          orderId: o.orderId
        });
        cancelled.push({ symbol: o.symbol, orderId: o.orderId });
      } catch (e) {}
    }
  }
  return cancelled;
}

// v8: Computes consecutiveLosses from most recent closed trades backwards
async function fetchBybitClosedPnlStats(limit = 50) {
  try {
    const res = await bybitV5Req('GET', '/v5/position/closed-pnl', { category: 'linear', limit: String(limit) });
    const list = res?.list || [];
    let wins = 0;
    let losses = 0;
    let totalPnl = 0;
    let bestTrade = 0;
    let consecutiveLosses = 0;
    let streakBroken = false;

    list.forEach(item => {
      const pnl = Number(item.closedPnl || 0);
      totalPnl += pnl;
      if (pnl > 0) {
        wins++;
        streakBroken = true;
      } else if (pnl < 0) {
        losses++;
        if (!streakBroken) consecutiveLosses++;
      }
      if (pnl > bestTrade) bestTrade = pnl;
    });

    const total = wins + losses;
    const winRate = total > 0 ? +((wins / total) * 100).toFixed(1) : 0;
    return {
      ok: true,
      wins,
      losses,
      consecutiveLosses,
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
    return { ok: false, wins: 0, losses: 0, consecutiveLosses: 0, totalTrades: 0, winRate: 0, totalClosedPnl: 0, bestTrade: 0, recent: [], error: e.message };
  }
}

// v8: Honest UTA margin reporting (never claims Isolated if switch-isolated failed on UTA)
async function configureIsolatedAndLeverage(symbol, leverage) {
  const sym = toBybitSymbol(symbol);
  const levStr = String(Math.min(20, Math.max(1, Number(leverage || 5))));
  let isolatedSet = false;
  let leverageSet = false;

  try {
    await bybitV5Req('POST', '/v5/position/switch-isolated', {
      category: 'linear',
      symbol: sym,
      tradeMode: 1,
      buyLeverage: levStr,
      sellLeverage: levStr
    });
    isolatedSet = true;
    leverageSet = true;
  } catch (e) {
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
      if (String(e.message || '').includes('110043')) leverageSet = true;
    }
  }
  return {
    isolatedSet,
    marginModeLabel: isolatedSet ? 'Isolated' : 'UTA/Cross',
    leverageSet,
    leverage: levStr
  };
}

// v8: Partial TP1 uses persisted initialRiskDist (never moved BE SL) + exact tickSize formatting
async function applyTrailingAndBreakeven(positions = [], instMap = {}) {
  const updates = [];
  for (const pos of positions) {
    const entry = Number(pos.avgPrice || 0);
    const mark = Number(pos.markPrice || 0);
    const sl = Number(pos.stopLoss || 0);
    const size = Number(pos.size || 0);
    if (entry <= 0 || mark <= 0 || sl <= 0 || size <= 0) continue;

    const isLong = pos.side === 'Buy';
    const spec = instMap[pos.symbol] || {};
    const tickSize = Number(spec.tickSize || 0.0001);
    const qtyStep = Number(spec.qtyStep || 0.01);
    const minQty = Number(spec.minOrderQty || qtyStep);

    const slAlreadyProtected = isLong ? (sl >= entry) : (sl <= entry);
    const meta = await getPositionMeta(pos.symbol);

    // Use persisted initialRiskDist if available; otherwise only calculate if SL is still on losing side
    const riskDist = (meta && meta.initialRiskDist > 0)
      ? meta.initialRiskDist
      : (!slAlreadyProtected ? Math.abs(entry - sl) : 0);

    if (riskDist <= 0) continue;

    const profitDist = isLong ? (mark - entry) : (entry - mark);
    const rMultiple = profitDist / riskDist;

    if (rMultiple >= 1.5) {
      // 1. Partial TP1: Only run if meta exists and partialTpDone is explicitly false
      if (meta && meta.partialTpDone === false) {
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
            await markPositionPartialTpDone(pos.symbol);
            updates.push({ symbol: pos.symbol, action: 'PARTIAL_TP1_50PCT_LOCKED', closedQty: halfQty, rMultiple: +rMultiple.toFixed(2), orderId: res?.orderId || null });
          } catch (e) {
            updates.push({ symbol: pos.symbol, action: 'PARTIAL_TP1_FAILED', error: e.message });
          }
        }
      }

      // 2. Move SL to Breakeven + Trailing Stop using exact tickSize
      if (!slAlreadyProtected) {
        const bePrice = formatBybitPrice(isLong ? entry * 1.0015 : entry * 0.9985, tickSize);
        const trailDist = formatBybitPrice(Math.max(riskDist * 0.8, entry * 0.004), tickSize);
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

// v8: Never silently swallows cancel-all errors
async function executeLiveEmergencyStop() {
  let cancelledOrders = false;
  let cancelError = null;
  try {
    await bybitV5Req('POST', '/v5/order/cancel-all', { category: 'linear', settleCoin: 'USDT' });
    cancelledOrders = true;
  } catch (e) {
    cancelledOrders = false;
    cancelError = e.message;
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
  return { cancelledOrders, cancelError, closedCount: closed.length, closed, failed };
}

module.exports = {
  signBybitV5,
  bybitV5Req,
  fetchBybitWalletAndPositions,
  cancelStaleLimitOrders,
  fetchBybitClosedPnlStats,
  configureIsolatedAndLeverage,
  applyTrailingAndBreakeven,
  closeVerifiedLivePosition,
  executeLiveEmergencyStop
};
