// Module 14: Live Bybit V5 Private Client — Production-Hardened v8
// Fixes: Idempotent orderLinkId, Open Orders & Stale Limit Cleanup, tickSize Precision,
// Original-R Partial TP1, Consecutive Losses Tracking, Honest UTA Margin Mode, Non-Silent Cancel-All
const crypto = require('crypto');
const { getBybitBaseUrls, fetchWithTimeout, safeReadJson, toBybitSymbol } = require('./marketData');
const { formatBybitQty, formatBybitPrice } = require('./riskAndValidation');
const { savePositionMeta, getPositionMeta, markPositionPartialTpDone, markPositionTpStage, markPositionPyramided, hasPartialTpDone, markPartialTpDone } = require('./securityAndState');
const { calcChandelierTrail } = require('./profitEngine');

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
  let openOrdersVerified = true;
  let openOrdersError = null;
  const [walletRes, posRes, openOrdRes] = await Promise.all([
    bybitV5Req('GET', '/v5/account/wallet-balance', { accountType: 'UNIFIED', coin: 'USDT' }),
    bybitV5Req('GET', '/v5/position/list', { category: 'linear', settleCoin: 'USDT' }),
    bybitV5Req('GET', '/v5/order/realtime', { category: 'linear', settleCoin: 'USDT', limit: '50' }).catch(e => {
      openOrdersVerified = false;
      openOrdersError = e.message;
      return { list: [] };
    })
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
    openOrders,
    openOrdersVerified,
    openOrdersError
  };
}

// v8: Auto-cancel stale unfilled Limit orders older than maxAgeMinutes (default 45m)

// v10.0.3 #6: Smart Chase Limit Order (auto-adjust unfilled PostOnly limit order if price drifts 0.15%-0.8%)
async function chaseOpenLimitOrders(openOrders = [], tickers = {}, instMap = {}) {
  const now = Date.now();
  const chased = [];
  for (const o of openOrders) {
    if (o.orderType !== 'Limit' || !o.createdTime) continue;
    const ageMin = (now - o.createdTime) / 60000;
    if (ageMin < 3 || ageMin > 35) continue;
    const t = tickers[o.symbol];
    const spec = instMap[o.symbol];
    const ordPrice = Number(o.price || 0);
    if (!t || !spec || ordPrice <= 0) continue;

    let newPrice = 0;
    if (o.side === 'Buy' && t.bid1 > ordPrice) {
      const drift = (t.bid1 - ordPrice) / ordPrice;
      if (drift >= 0.0015 && drift <= 0.008) newPrice = formatBybitPrice(t.bid1, spec.tickSize);
    } else if (o.side === 'Sell' && t.ask1 > 0 && t.ask1 < ordPrice) {
      const drift = (ordPrice - t.ask1) / ordPrice;
      if (drift >= 0.0015 && drift <= 0.008) newPrice = formatBybitPrice(t.ask1, spec.tickSize);
    }

    if (newPrice > 0 && newPrice !== ordPrice) {
      try {
        await bybitV5Req('POST', '/v5/order/amend', {
          category: 'linear',
          symbol: o.symbol,
          orderId: o.orderId,
          price: String(newPrice)
        });
        chased.push({ symbol: o.symbol, orderId: o.orderId, oldPrice: ordPrice, newPrice, side: o.side });
      } catch (e) {}
    }
  }
  return chased;
}

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
  if (!leverageSet) {
    throw new Error(`LEVERAGE_CONFIG_FAILED: Could not verify ${levStr}x leverage for ${sym}.`);
  }
  return {
    ok: true,
    verified: leverageSet,
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
    let meta = await getPositionMeta(pos.symbol);

    // v8.3: Recover missing position metadata safely if SL is on losing side
    if (!meta && !slAlreadyProtected && Math.abs(entry - sl) > 0) {
      meta = await savePositionMeta(pos.symbol, {
        entry,
        initialSl: sl,
        direction: isLong ? 'LONG' : 'SHORT'
      });
    }

    const riskDist = (meta && meta.initialRiskDist > 0)
      ? meta.initialRiskDist
      : (!slAlreadyProtected ? Math.abs(entry - sl) : 0);

    if (riskDist <= 0) continue;

    const profitDist = isLong ? (mark - entry) : (entry - mark);
    const rMultiple = profitDist / riskDist;

    const currentStage = Number(meta?.tpStage || (meta?.partialTpDone ? 1 : 0));

    // v9.0 #1 Multi-TP Ladder: TP1 (40% @ 1.5R), TP2 (30% @ 3.0R), Remainder (30% Dynamic ATR Trailing)
    if (rMultiple >= 1.5 && currentStage < 1) {
      const alreadyDone = await hasPartialTpDone(pos.symbol, entry);
      if (!alreadyDone) {
        const tp1Qty = formatBybitQty(size * 0.40, qtyStep);
        if (tp1Qty >= minQty && tp1Qty < size) {
          try {
            const closeSide = isLong ? 'Sell' : 'Buy';
            const res = await bybitV5Req('POST', '/v5/order/create', {
              category: 'linear',
              symbol: pos.symbol,
              side: closeSide,
              orderType: 'Market',
              qty: String(tp1Qty),
              reduceOnly: true,
              positionIdx: 0
            });
            await markPositionTpStage(pos.symbol, 1);
            await markPartialTpDone(pos.symbol, entry);
            updates.push({ symbol: pos.symbol, action: 'PARTIAL_TP1_40PCT_LOCKED', closedQty: tp1Qty, rMultiple: +rMultiple.toFixed(2), orderId: res?.orderId || null });
          } catch (e) {
            updates.push({ symbol: pos.symbol, action: 'PARTIAL_TP1_FAILED', error: e.message });
          }
        }
      }
    }

    if (rMultiple >= 3.0 && currentStage < 2) {
      const tp2Qty = formatBybitQty(size * 0.50, qtyStep); // 50% of remaining 60% = 30% of original
      if (tp2Qty >= minQty && tp2Qty < size) {
        try {
          const closeSide = isLong ? 'Sell' : 'Buy';
          const res = await bybitV5Req('POST', '/v5/order/create', {
            category: 'linear',
            symbol: pos.symbol,
            side: closeSide,
            orderType: 'Market',
            qty: String(tp2Qty),
            reduceOnly: true,
            positionIdx: 0
          });
          await markPositionTpStage(pos.symbol, 2);
          updates.push({ symbol: pos.symbol, action: 'PARTIAL_TP2_30PCT_LOCKED', closedQty: tp2Qty, rMultiple: +rMultiple.toFixed(2), orderId: res?.orderId || null });
        } catch (e) {
          updates.push({ symbol: pos.symbol, action: 'PARTIAL_TP2_FAILED', error: e.message });
        }
      }
    }

    // v10.0 #11: Time-Based Dead Trade Killer (open >= 6h, stagnant between -0.35R and +0.5R)
    const maxStagnantHours = Number(process.env.DEAD_TRADE_HOURS || 6);
    if (meta && meta.openedAt && (Date.now() - Number(meta.openedAt)) >= maxStagnantHours * 3600 * 1000 && rMultiple < 0.5 && rMultiple > -0.35) {
      try {
        const closeSide = isLong ? 'Sell' : 'Buy';
        const res = await bybitV5Req('POST', '/v5/order/create', {
          category: 'linear',
          symbol: pos.symbol,
          side: closeSide,
          orderType: 'Market',
          qty: String(size),
          reduceOnly: true,
          positionIdx: 0
        });
        updates.push({ symbol: pos.symbol, action: 'DEAD_TRADE_EXITED', rMultiple: +rMultiple.toFixed(2), orderId: res?.orderId || null });
        continue;
      } catch (e) {
        updates.push({ symbol: pos.symbol, action: 'DEAD_TRADE_EXIT_FAILED', error: e.message });
      }
    }

    // v10.0 #6: Pyramiding (Winning Trade Scaling: add 25% when >= +2R & SL already at Breakeven & ENABLE_PYRAMIDING=true)
    const pyramidingOn = String(process.env.ENABLE_PYRAMIDING || '').trim().toLowerCase() === 'true';
    if (pyramidingOn && rMultiple >= 2.0 && slAlreadyProtected && meta && !meta.pyramided) {
      const addQty = formatBybitQty(size * 0.25, qtyStep);
      if (addQty >= minQty && (addQty * mark) >= 5) {
        try {
          const addSide = isLong ? 'Buy' : 'Sell';
          const res = await bybitV5Req('POST', '/v5/order/create', {
            category: 'linear',
            symbol: pos.symbol,
            side: addSide,
            orderType: 'Market',
            qty: String(addQty),
            positionIdx: 0
          });
          await markPositionPyramided(pos.symbol);
          updates.push({ symbol: pos.symbol, action: 'PYRAMID_SCALED_IN_25PCT', addedQty: addQty, rMultiple: +rMultiple.toFixed(2), orderId: res?.orderId || null });
        } catch (e) {
          updates.push({ symbol: pos.symbol, action: 'PYRAMID_FAILED', error: e.message });
        }
      }
    }

    if (rMultiple >= 1.5) {
      // v10.0 #7: Chandelier Exit / Supertrend ATR-scaled Trailing Stop + Breakeven SL
      if (!slAlreadyProtected) {
        const bePrice = formatBybitPrice(isLong ? entry * 1.0015 : entry * 0.9985, tickSize);
        const rawTrail = calcChandelierTrail({ atr: Number(meta?.atr || 0), entryPrice: entry, multiplier: 2.0 });
        const trailDist = formatBybitPrice(rawTrail, tickSize);
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


// v8.3: Verify order fill / active status on Bybit
async function verifyOrderStatus(symbol, orderId) {
  if (!orderId) return { verified: false, status: 'MISSING_ORDER_ID' };
  try {
    const sym = toBybitSymbol(symbol);
    const res = await bybitV5Req('GET', '/v5/order/realtime', { category: 'linear', symbol: sym, orderId: String(orderId) });
    const ord = (res?.list || [])[0];
    if (ord) {
      return {
        verified: true,
        orderId: ord.orderId,
        orderStatus: ord.orderStatus,
        avgPrice: Number(ord.avgPrice || ord.price || 0),
        cumExecQty: Number(ord.cumExecQty || 0)
      };
    }
    const hist = await bybitV5Req('GET', '/v5/order/history', { category: 'linear', symbol: sym, orderId: String(orderId), limit: '1' });
    const hOrd = (hist?.list || [])[0];
    if (hOrd) {
      return {
        verified: true,
        orderId: hOrd.orderId,
        orderStatus: hOrd.orderStatus,
        avgPrice: Number(hOrd.avgPrice || hOrd.price || 0),
        cumExecQty: Number(hOrd.cumExecQty || 0)
      };
    }
    return { verified: false, orderId, orderStatus: 'NOT_FOUND' };
  } catch (e) {
    return { verified: false, orderId, orderStatus: 'VERIFY_ERROR', error: e.message };
  }
}

// v8.3: Prevent duplicate orders & duplicate positions (fail-closed if openOrders unverified)
function checkDuplicateExposure(symbol, acct) {
  const sym = toBybitSymbol(symbol);
  if (acct && acct.openOrdersVerified === false) {
    return {
      blocked: true,
      errorCode: 'OPEN_ORDERS_UNVERIFIED',
      reason: `FAIL_CLOSED: Open Orders API failed (${acct.openOrdersError || 'unknown'}); blocking new order to prevent duplicates.`
    };
  }
  const hasPos = (acct?.positions || []).some(p => p.symbol === sym && Number(p.size || 0) > 0);
  if (hasPos) {
    return { blocked: true, errorCode: 'DUPLICATE_POSITION', reason: `Duplicate position blocked: ${sym} already open.` };
  }
  const hasOrd = (acct?.openOrders || []).some(o => o.symbol === sym);
  if (hasOrd) {
    return { blocked: true, errorCode: 'DUPLICATE_ORDER', reason: `Duplicate order blocked: active order already exists for ${sym}.` };
  }
  return { blocked: false, errorCode: null, reason: null };
}

// v8.3: Reconcile SL/TP on any open position missing server-side SL protection
async function reconcileUnprotectedPositions(positions = [], instMap = {}) {
  const reconciled = [];
  for (const pos of positions) {
    if (pos.hasSlProtection || Number(pos.size || 0) <= 0 || Number(pos.avgPrice || 0) <= 0) continue;
    const meta = await getPositionMeta(pos.symbol);
    const isLong = pos.side === 'Buy';
    const spec = instMap[pos.symbol] || {};
    const tickSize = Number(spec.tickSize || 0.0001);
    const fallbackSl = formatBybitPrice(pos.avgPrice * (isLong ? 0.985 : 1.015), tickSize);
    const targetSl = (meta && Number(meta.initialSl) > 0) ? formatBybitPrice(meta.initialSl, tickSize) : fallbackSl;
    try {
      await bybitV5Req('POST', '/v5/position/trading-stop', {
        category: 'linear',
        symbol: pos.symbol,
        stopLoss: String(targetSl),
        positionIdx: 0
      });
      reconciled.push({ symbol: pos.symbol, action: 'SL_RECONCILED', stopLoss: targetSl });
    } catch (e) {
      reconciled.push({ symbol: pos.symbol, action: 'SL_RECONCILE_FAILED', error: e.message });
    }
  }
  return reconciled;
}

module.exports = {
  verifyOrderStatus,
  checkDuplicateExposure,
  reconcileUnprotectedPositions,
  signBybitV5,
  bybitV5Req,
  fetchBybitWalletAndPositions,
  chaseOpenLimitOrders,
  cancelStaleLimitOrders,
  fetchBybitClosedPnlStats,
  configureIsolatedAndLeverage,
  applyTrailingAndBreakeven,
  closeVerifiedLivePosition,
  executeLiveEmergencyStop
};
