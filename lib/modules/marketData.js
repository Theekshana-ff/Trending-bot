// Module 01: Market Data Intelligence & Strict Validation (H-07)
const crypto = require('crypto');

const TF_MS = {
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000
};

function toBybitSymbol(sym) {
  const clean = String(sym || 'BTCUSDT').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!clean) throw new Error('INVALID_SYMBOL');
  return clean.endsWith('USDT') ? clean : `${clean}USDT`;
}

function getBybitBaseUrls() {
  if (String(process.env.BYBIT_TESTNET || '').trim().toLowerCase() === 'true') {
    return ['https://api-testnet.bybit.com'];
  }
  return ['https://api.bybit.com', 'https://api.bytick.com'];
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 4000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...options, signal: ctrl.signal });
    clearTimeout(id);
    return r;
  } catch (e) {
    clearTimeout(id);
    throw e;
  }
}

async function safeReadJson(res, label = 'Bybit API') {
  const raw = await res.text();
  try {
    const parsed = raw ? JSON.parse(raw) : {};
    if (!res.ok) {
      throw new Error(`${label} HTTP ${res.status}: ${parsed.retMsg || raw.slice(0, 140)}`);
    }
    return parsed;
  } catch (e) {
    if (e.message && e.message.startsWith(`${label} HTTP`)) throw e;
    const region = process.env.VERCEL_REGION || 'unknown';
    throw new Error(`${label} HTTP ${res.status} [region=${region}] non-JSON: ${raw.replace(/\s+/g, ' ').slice(0, 140)}`);
  }
}

async function fetchBybitPublicJson(pathWithQuery, timeoutMs = 3000) {
  const bases = getBybitBaseUrls();
  let lastErr = null;
  for (const base of bases) {
    try {
      const r = await fetchWithTimeout(`${base}${pathWithQuery}`, {
        headers: { 'User-Agent': 'BybitQuantBot/3.0', 'Accept': 'application/json' }
      }, timeoutMs);
      return await safeReadJson(r, `Bybit Public (${base})`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('BYBIT_PUBLIC_UNREACHABLE');
}

function validateCandles(rawCandles, tf = '15m', nowMs = Date.now(), minCount = 22) {
  if (!Array.isArray(rawCandles) || rawCandles.length < minCount) {
    return { ok: false, errorCode: 'INSUFFICIENT_CANDLES', reason: `Need >=${minCount} candles for ${tf}`, closedCandles: [], incompleteCandle: null };
  }
  const intervalMs = TF_MS[tf] || 900000;
  const cleaned = [];
  let prevTs = 0;

  for (let i = 0; i < rawCandles.length; i++) {
    const c = rawCandles[i];
    if (!Array.isArray(c) || c.length < 6) {
      return { ok: false, errorCode: 'MALFORMED_OHLCV', reason: `Candle index ${i} missing OHLCV fields`, closedCandles: [], incompleteCandle: null };
    }
    const [ts, o, h, l, cl, vol] = c.map(Number);
    if (![ts, o, h, l, cl, vol].every(Number.isFinite)) {
      return { ok: false, errorCode: 'NAN_OHLCV', reason: `NaN/Infinity in candle ${i}`, closedCandles: [], incompleteCandle: null };
    }
    if (o <= 0 || h <= 0 || l <= 0 || cl <= 0 || h < l || h < Math.max(o, cl) || l > Math.min(o, cl) || vol < 0) {
      return { ok: false, errorCode: 'INVALID_OHLC_BOUNDS', reason: `Invalid OHLC bounds at candle ${i}`, closedCandles: [], incompleteCandle: null };
    }
    if (prevTs > 0 && ts <= prevTs) {
      return { ok: false, errorCode: 'NON_MONOTONIC_TS', reason: `Duplicate or out-of-order timestamp at ${i}`, closedCandles: [], incompleteCandle: null };
    }
    prevTs = ts;
    cleaned.push([ts, o, h, l, cl, vol]);
  }

  const latest = cleaned[cleaned.length - 1];
  const ageMs = nowMs - latest[0];
  // Reject stale feed (> 3 full candle intervals old)
  if (ageMs > intervalMs * 3.5) {
    return {
      ok: false,
      errorCode: 'STALE_MARKET_DATA',
      reason: `Stale ${tf} candles: latest candle is ${Math.round(ageMs / 60000)}m old`,
      closedCandles: [],
      incompleteCandle: null
    };
  }
  // Reject future exchange timestamps (> 2 min ahead)
  if (latest[0] > nowMs + 120000) {
    return {
      ok: false,
      errorCode: 'FUTURE_TIMESTAMP',
      reason: `Invalid future exchange timestamp on ${tf}`,
      closedCandles: [],
      incompleteCandle: null
    };
  }

  // Separate currently forming (incomplete) candle from closed candles
  const isForming = (nowMs - latest[0]) < intervalMs;
  const incompleteCandle = isForming ? latest : null;
  const closedCandles = isForming ? cleaned.slice(0, -1) : cleaned;

  if (closedCandles.length < minCount - 1) {
    return { ok: false, errorCode: 'INSUFFICIENT_CLOSED_CANDLES', reason: `Not enough closed candles for ${tf}`, closedCandles: [], incompleteCandle };
  }

  return {
    ok: true,
    errorCode: null,
    tf,
    closedCandles,
    incompleteCandle,
    lastClosedTs: closedCandles[closedCandles.length - 1][0],
    staleCheckPassed: true
  };
}


async function fetchAllLinearInstruments() {
  const all = [];
  let cursor = '';
  for (let page = 0; page < 3; page++) {
    const q = `/v5/market/instruments-info?category=linear&limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const j = await fetchBybitPublicJson(q, 3500);
    const list = j?.result?.list || [];
    all.push(...list);
    cursor = j?.result?.nextPageCursor || '';
    if (!cursor) break;
  }
  return { result: { list: all } };
}

async function getBybitMarketData() {
  const [tj, ij] = await Promise.all([
    fetchBybitPublicJson('/v5/market/tickers?category=linear', 3500),
    fetchAllLinearInstruments()
  ]);
  const tickers = {};
  const instMap = {};

  (tj?.result?.list || []).forEach(t => {
    if (!t.symbol || !t.symbol.endsWith('USDT')) return;
    const lastPrice = Number(t.lastPrice || t.markPrice || 0);
    const bid1 = Number(t.bid1Price || lastPrice || 0);
    const ask1 = Number(t.ask1Price || lastPrice || 0);
    if (!Number.isFinite(lastPrice) || lastPrice <= 0) return;
    tickers[t.symbol] = {
      bybitSymbol: t.symbol,
      lastPrice,
      chgPct: Number(t.price24hPcnt || 0) * 100,
      bid1,
      ask1,
      fundingRate: Number(t.fundingRate || 0),
      turnover24h: Number(t.turnover24h || 0),
      openInterestValue: Number(t.openInterestValue || 0)
    };
  });

  (ij?.result?.list || []).forEach(c => {
    if (!c.symbol || !c.symbol.endsWith('USDT')) return;
    if (c.status && c.status !== 'Trading') return;
    instMap[c.symbol] = {
      status: c.status || 'Trading',
      qtyStep: Number(c.lotSizeFilter?.qtyStep || 0.01),
      minOrderQty: Number(c.lotSizeFilter?.minOrderQty || 0.01),
      maxOrderQty: Number(c.lotSizeFilter?.maxOrderQty || 100000),
      minNotionalValue: Number(c.lotSizeFilter?.minNotionalValue || 5),
      tickSize: Number(c.priceFilter?.tickSize || 0.01),
      maxLeverage: Number(c.leverageFilter?.maxLeverage || 20)
    };
  });

  return { tickers, instMap, updatedAt: new Date().toISOString() };
}

async function fetchKlines(coin, interval = '15m', limit = 90) {
  const sym = toBybitSymbol(coin);
  const tfMap = { '5m': '5', '15m': '15', '1h': '60', '4h': '240', '1d': 'D' };
  const bInt = tfMap[interval] || '15';
  const j = await fetchBybitPublicJson(`/v5/market/kline?category=linear&symbol=${sym}&interval=${bInt}&limit=${limit}`, 2800);
  const raw = (j?.result?.list || []).slice().reverse().map(k => [
    Number(k[0]), Number(k[1]), Number(k[2]), Number(k[3]), Number(k[4]), Number(k[5] || 0)
  ]);
  return validateCandles(raw, interval);
}


async function fetchOpenInterest(symbol, intervalTime = '15min') {
  try {
    const sym = toBybitSymbol(symbol);
    const j = await fetchBybitPublicJson(
      `/v5/market/open-interest?category=linear&symbol=${sym}&intervalTime=${intervalTime}&limit=5`,
      3000
    );
    const list = j?.result?.list || [];
    if (list.length < 2) return { ok: false, latestOi: 0, prevOi: 0, oiChangePct: 0 };
    const latestOi = Number(list[0].openInterest || 0);
    const prevOi = Number(list[list.length - 1].openInterest || 0);
    const oiChangePct = prevOi > 0 ? +(((latestOi - prevOi) / prevOi) * 100).toFixed(2) : 0;
    return { ok: true, latestOi, prevOi, oiChangePct };
  } catch (e) {
    return { ok: false, latestOi: 0, prevOi: 0, oiChangePct: 0, error: e.message };
  }
}


// v10.0 #3: Live Order Book Imbalance (Top 10 Bids vs Asks)
async function fetchOrderBookImbalance(symbol, limit = 10) {
  try {
    const sym = toBybitSymbol(symbol);
    const j = await fetchBybitPublicJson(`/v5/market/orderbook?category=linear&symbol=${sym}&limit=${limit}`, 2500);
    const bids = j?.result?.b || [];
    const asks = j?.result?.a || [];
    const bidVol = bids.reduce((acc, x) => acc + Number(x[1] || 0), 0);
    const askVol = asks.reduce((acc, x) => acc + Number(x[1] || 0), 0);
    const total = bidVol + askVol;
    if (total <= 0) return { ok: false, obi: 0, bestBid: 0, bestAsk: 0 };
    return {
      ok: true,
      obi: +((bidVol - askVol) / total).toFixed(3),
      bestBid: Number(bids[0]?.[0] || 0),
      bestAsk: Number(asks[0]?.[0] || 0)
    };
  } catch (e) {
    return { ok: false, obi: 0, bestBid: 0, bestAsk: 0, error: e.message };
  }
}

module.exports = {
  fetchOrderBookImbalance,
  fetchOpenInterest,
  TF_MS,
  toBybitSymbol,
  getBybitBaseUrls,
  fetchWithTimeout,
  safeReadJson,
  fetchBybitPublicJson,
  validateCandles,
  getBybitMarketData,
  fetchKlines
};
