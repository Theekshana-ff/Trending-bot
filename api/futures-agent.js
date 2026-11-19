// File: api/futures-agent.js
// STANDALONE BYBIT V5 LIVE-ONLY 6-STAGE QUANT PIPELINE ENGINE (v2.0)
// Fixed: Singapore region (sin1), api.bytick.com automatic fallback, safe JSON response parsing.

const crypto = require('crypto');

const signBybitV5 = (apiKey, secret, ts, recvWindow, paramStr) =>
  crypto.createHmac('sha256', secret).update(ts + apiKey + recvWindow + paramStr).digest('hex');

function safeCompareSecret(a, b) {
  const strA = String(a || '').trim();
  const strB = String(b || '').trim();
  if (!strA || !strB || strA.length !== strB.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(strA, 'utf8'), Buffer.from(strB, 'utf8'));
  } catch (e) {
    return false;
  }
}

let localLockUntil = 0;
let localLockToken = null;
const localNonceCache = new Map();
const localRateLimitMap = {};

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
    throw new Error(`${label} HTTP ${res.status} [region=${region}] non-JSON response: ${raw.replace(/\s+/g, ' ').slice(0, 140)}`);
  }
}

function getBybitBaseUrls() {
  if (String(process.env.BYBIT_TESTNET || '').trim().toLowerCase() === 'true') {
    return ['https://api-testnet.bybit.com'];
  }
  return ['https://api.bybit.com', 'https://api.bytick.com'];
}

async function fetchBybitPublicJson(pathWithQuery, timeoutMs = 3000) {
  const bases = getBybitBaseUrls();
  let lastErr = null;
  for (const base of bases) {
    try {
      const r = await fetchWithTimeout(`${base}${pathWithQuery}`, {
        headers: { 'User-Agent': 'BybitQuantBot/2.0', 'Accept': 'application/json' }
      }, timeoutMs);
      return await safeReadJson(r, `Bybit Public (${base})`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('Bybit Public API unreachable.');
}

async function bybitV5Req(method, pathUrl, payload = null) {
  const apiKey = (process.env.BYBIT_API_KEY || '').trim();
  const secret = (process.env.BYBIT_API_SECRET || '').trim();
  if (!apiKey || !secret) throw new Error('BYBIT_API_KEY and BYBIT_API_SECRET are not configured in Vercel Environment Variables.');

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
          'User-Agent': 'BybitQuantBot/2.0'
        },
        body
      }, 4500);

      const j = await safeReadJson(r, `Bybit V5 (${base})`);
      if (j.retCode !== 0) throw new Error(`Bybit V5 Error (${j.retCode}): ${j.retMsg || 'Unknown error'}`);
      return j.result;
    } catch (e) {
      lastErr = e;
      if (String(e.message || '').includes('Bybit V5 Error')) throw e; // real Bybit API error, don't retry
    }
  }
  throw lastErr || new Error('Bybit V5 API unreachable.');
}

async function redisCmd(command, ...args) {
  const url = (process.env.UPSTASH_REDIS_REST_URL || '').trim().replace(/^["']|["']$/g, '');
  const token = (process.env.UPSTASH_REDIS_REST_TOKEN || '').trim().replace(/^["']|["']$/g, '');
  if (!url || !token) return { ok: false, result: null, source: 'NO_REDIS_CONFIG' };
  try {
    const r = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([command, ...args])
    }, 1500);
    if (!r.ok) return { ok: false, result: null, source: `REDIS_HTTP_${r.status}` };
    const j = await safeReadJson(r, 'Upstash Redis');
    if (j.error) return { ok: false, result: null, source: `REDIS_CMD_ERROR` };
    return { ok: true, result: j.result, source: 'UPSTASH_REDIS_VERIFIED' };
  } catch (e) {
    return { ok: false, result: null, source: 'REDIS_UNREACHABLE' };
  }
}

async function acquireLock(lockName = 'bybit_live_lock', ttlMs = 12000) {
  const token = crypto.randomBytes(12).toString('hex');
  const res = await redisCmd('SET', lockName, token, 'NX', 'PX', String(ttlMs));
  if (res.source === 'UPSTASH_REDIS_VERIFIED') {
    if (res.result !== 'OK') return { acquired: false, token: null, reason: 'Concurrent live order locked by Redis.' };
    return { acquired: true, token, mode: 'UPSTASH_REDIS_VERIFIED' };
  }
  const now = Date.now();
  if (now < localLockUntil) return { acquired: false, token: null, reason: 'Local execution lock busy.' };
  localLockUntil = now + ttlMs;
  localLockToken = token;
  return { acquired: true, token, mode: 'LOCAL_LOCK_FALLBACK' };
}

async function releaseLock(lockName = 'bybit_live_lock', token = null) {
  if (!token) return;
  if (localLockToken === token) { localLockUntil = 0; localLockToken = null; }
  const lua = 'if redis.call("get",KEYS[1]) == ARGV[1] then return redis.call("del",KEYS[1]) else return 0 end';
  await redisCmd('EVAL', lua, '1', lockName, token);
}

async function validateRequestNonce(nonce, tsHeader) {
  if (!nonce || !tsHeader) return { valid: true };
  const reqTs = Number(tsHeader);
  if (!Number.isFinite(reqTs) || Math.abs(Date.now() - reqTs) > 120000) {
    return { valid: false, reason: 'Request timestamp expired (>120s drift).' };
  }
  const cleanNonce = String(nonce).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  if (cleanNonce.length < 8) return { valid: false, reason: 'Invalid nonce format.' };
  const r = await redisCmd('SET', `nonce:${cleanNonce}`, '1', 'NX', 'PX', '180000');
  if (r.source === 'UPSTASH_REDIS_VERIFIED') {
    return r.result === 'OK' ? { valid: true } : { valid: false, reason: 'Replay rejected: Nonce already used.' };
  }
  const now = Date.now();
  for (const [k, exp] of localNonceCache.entries()) if (exp <= now) localNonceCache.delete(k);
  if (localNonceCache.has(cleanNonce)) return { valid: false, reason: 'Replay rejected (local cache).' };
  localNonceCache.set(cleanNonce, now + 180000);
  return { valid: true };
}

async function checkRateLimit(clientIp, maxPerMin = 90) {
  const nowMs = Date.now();
  const rl = localRateLimitMap[clientIp] || { count: 0, resetAt: nowMs + 60000 };
  if (nowMs > rl.resetAt) { rl.count = 0; rl.resetAt = nowMs + 60000; }
  rl.count += 1;
  localRateLimitMap[clientIp] = rl;
  return rl.count <= maxPerMin;
}

const toBybitSymbol = (sym) => {
  const clean = String(sym || 'BTCUSDT').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return clean.endsWith('USDT') ? clean : `${clean}USDT`;
};

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
      size: p.size,
      avgPrice: p.avgPrice,
      markPrice: p.markPrice,
      leverage: p.leverage,
      unrealisedPnl: Number(p.unrealisedPnl || 0),
      stopLoss: p.stopLoss,
      takeProfit: p.takeProfit
    }));

  const unrealizedPnl = openPositions.reduce((acc, p) => acc + p.unrealisedPnl, 0);
  return {
    wallet: { availableBalance, totalEquity, unrealizedPnl },
    positions: openPositions
  };
}

function getDecimalsFromStep(stepVal) {
  const s = String(stepVal || '0.01');
  if (s.includes('e-')) return Number(s.split('e-')[1]) || 4;
  if (!s.includes('.')) return 0;
  return s.split('.')[1].replace(/0+$/, '').length;
}

function formatBybitPrice(rawPrice, tickSize = 0.01) {
  const tick = Number(tickSize) > 0 ? Number(tickSize) : 0.01;
  const dec = getDecimalsFromStep(tick);
  return Number((Math.round(Number(rawPrice) / tick) * tick).toFixed(dec));
}

function formatBybitQty(rawQty, qtyStep = 0.01) {
  const step = Number(qtyStep) > 0 ? Number(qtyStep) : 0.01;
  const dec = getDecimalsFromStep(step);
  return Number((Math.floor((Number(rawQty) + 1e-12) / step) * step).toFixed(dec));
}

function calcEMAVal(arr, period) {
  if (!arr || !arr.length) return 0;
  const k = 2 / (period + 1);
  const seedLen = Math.min(arr.length, period);
  let ema = arr.slice(0, seedLen).reduce((a, b) => a + b, 0) / seedLen;
  for (let i = seedLen; i < arr.length; i++) ema = arr[i] * k + ema * (1 - k);
  return ema;
}

function calcWilderATR(highs, lows, closes, period = 14) {
  if (!closes || closes.length <= period) return 1;
  const trs = [];
  for (let i = 1; i < closes.length; i++) {
    trs.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  }
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) atr = (atr * (period - 1) + trs[i]) / period;
  return atr;
}

function evaluateMTF({ closes1d, closes4h, closes1h, closes15m, closes5m, minConfirmations = 3 }) {
  const evalTf = (arr) => {
    if (!Array.isArray(arr) || arr.length < 20) return 'NEUTRAL';
    const e20 = calcEMAVal(arr, 20), e50 = calcEMAVal(arr, 50), last = arr[arr.length - 1];
    if (e20 > e50 * 1.0015 && last > e20) return 'BULL';
    if (e20 < e50 * 0.9985 && last < e20) return 'BEAR';
    return 'NEUTRAL';
  };
  const d1 = evalTf(closes1d), h4 = evalTf(closes4h), h1 = evalTf(closes1h), m15 = evalTf(closes15m), m5 = evalTf(closes5m);
  const all = [d1, h4, h1, m15, m5];
  const bullCount = all.filter(x => x === 'BULL').length;
  const bearCount = all.filter(x => x === 'BEAR').length;
  const neutralCount = all.filter(x => x === 'NEUTRAL').length;
  const dominant = bullCount >= bearCount ? 'LONG' : 'SHORT';
  const maxDir = Math.max(bullCount, bearCount);
  const agreementPct = Math.round((maxDir / 5) * 100);
  const conflictDetected = maxDir < minConfirmations || agreementPct < 60;

  return {
    ok: !conflictDetected,
    decision: conflictDetected ? 'NO_TRADE' : dominant,
    conflictDetected,
    agreementPct,
    bullCount,
    bearCount,
    neutralCount,
    breakdown: { '1D': d1, '4H': h4, '1H': h1, '15M': m15, '5M': m5 },
    reason: conflictDetected
      ? `NO_TRADE: MTF alignment below threshold (1D=${d1}, 4H=${h4}, 1H=${h1}, 15M=${m15}, 5M=${m5} · ${agreementPct}%)`
      : `MTF Aligned ${dominant} (${agreementPct}%)`
  };
}

function computeLevels({ closedCandles, livePrice, direction, tickSize, atr, spreadPct }) {
  if (!Array.isArray(closedCandles) || closedCandles.length < 20) {
    return { valid: false, reason: 'NO_TRADE: Insufficient 15M candles.' };
  }
  const last = closedCandles[closedCandles.length - 1];
  const prev = closedCandles[closedCandles.length - 2];
  const isLong = direction === 'LONG';
  const confirmed = isLong ? (last[4] > last[1] && last[4] >= prev[4]) : (last[4] < last[1] && last[4] <= prev[4]);
  if (!confirmed) return { valid: false, reason: `NO_TRADE: Latest 15M closed candle failed ${direction} momentum check.` };

  const entry = formatBybitPrice(livePrice, tickSize);
  const sign = isLong ? 1 : -1;
  const recentLows = closedCandles.slice(-12).map(c => c[3]);
  const recentHighs = closedCandles.slice(-12).map(c => c[2]);
  const swingInv = isLong ? Math.min(...recentLows) - atr * 0.25 : Math.max(...recentHighs) + atr * 0.25;
  const cost = entry * ((0.11 + Number(spreadPct || 0.02)) / 100);
  const riskDist = Math.max(atr * 1.2, Math.abs(entry - swingInv)) + cost;

  const sl = formatBybitPrice(entry - sign * riskDist, tickSize);
  const tp1 = formatBybitPrice(entry + sign * (riskDist * 1.5 + cost), tickSize);
  const tp2 = formatBybitPrice(entry + sign * (riskDist * 3.0 + cost), tickSize);
  const tp3 = formatBybitPrice(entry + sign * (riskDist * 5.0 + cost), tickSize);
  const tp4 = formatBybitPrice(entry + sign * (riskDist * 8.0 + cost), tickSize);
  const rrRatio = +((Math.abs(tp2 - entry) - cost) / Math.max(1e-8, riskDist)).toFixed(2);

  return { valid: true, entry, sl, tp1, tp2, tp3, tp4, tp: tp4, rrRatio };
}

function calcLiveOrderSize({ availBal, entryPrice, slPrice, qtyStep, minOrderQty, maxOrderQty, riskPerTradePct = 0.03 }) {
  const slDist = Math.abs(entryPrice - slPrice);
  if (!Number.isFinite(availBal) || availBal <= 0 || slDist <= 0) {
    return { approved: false, orderQty: 0, reason: 'NO_TRADE: Insufficient Bybit USDT balance or invalid SL distance.' };
  }
  const riskBudget = availBal * riskPerTradePct;
  const unitRisk = slDist + entryPrice * 0.0013;
  const rawQty = Math.min(maxOrderQty, riskBudget / Math.max(1e-8, unitRisk));
  const orderQty = formatBybitQty(rawQty, qtyStep);
  if (orderQty < minOrderQty) {
    return { approved: false, orderQty: 0, reason: `NO_TRADE: Calculated qty (${orderQty}) is below Bybit minOrderQty (${minOrderQty}).` };
  }
  return { approved: true, orderQty };
}

async function getBybitMarketData() {
  const [tj, ij] = await Promise.all([
    fetchBybitPublicJson('/v5/market/tickers?category=linear', 3000),
    fetchBybitPublicJson('/v5/market/instruments-info?category=linear&limit=200', 3000)
  ]);
  const tickers = {}, instMap = {};
  (tj?.result?.list || []).forEach(t => {
    if (!t.symbol?.endsWith('USDT')) return;
    tickers[t.symbol] = {
      bybitSymbol: t.symbol,
      lastPrice: Number(t.lastPrice || t.markPrice || 0),
      chgPct: Number(t.price24hPcnt || 0) * 100,
      bid1: Number(t.bid1Price || t.lastPrice || 0),
      ask1: Number(t.ask1Price || t.lastPrice || 0)
    };
  });
  (ij?.result?.list || []).forEach(c => {
    if (!c.symbol?.endsWith('USDT')) return;
    instMap[c.symbol] = {
      qtyStep: Number(c.lotSizeFilter?.qtyStep || 0.01),
      minOrderQty: Number(c.lotSizeFilter?.minOrderQty || 0.01),
      maxOrderQty: Number(c.lotSizeFilter?.maxOrderQty || 100000),
      tickSize: Number(c.priceFilter?.tickSize || 0.01)
    };
  });
  return { tickers, instMap };
}

async function fetchKlines(coin, interval = '15m', limit = 90) {
  const sym = toBybitSymbol(coin);
  const tfMap = { '5m': '5', '15m': '15', '1h': '60', '4h': '240', '1d': 'D' };
  const bInt = tfMap[interval] || '15';
  const j = await fetchBybitPublicJson(`/v5/market/kline?category=linear&symbol=${sym}&interval=${bInt}&limit=${limit}`, 2500);
  if (j?.result?.list?.length >= 22) {
    return [...j.result.list].reverse().map(k => [Number(k[0]), Number(k[1]), Number(k[2]), Number(k[3]), Number(k[4]), Number(k[5] || 0)]);
  }
  return null;
}

const TOP_COINS = ['SOL', 'XRP', 'DOGE', 'SUI', 'ADA', 'OP', 'ARB', 'LINK', 'AVAX', 'NEAR', 'APT', 'INJ', 'RENDER', 'TRX', 'LTC', 'BNB', 'ETH', 'BTC'];

async function runSixStageScan({ coinMode, manualCoin, humanBias, riskPerTradePct, availBal, enforceVeto }) {
  const { tickers, instMap } = await getBybitMarketData();
  const cleanManual = String(manualCoin || 'SOL').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/USDT$/, '');
  const list = coinMode === 'manual' && cleanManual ? [cleanManual] : TOP_COINS;

  const candidates = list.map(coin => {
    const bybitSymbol = `${coin}USDT`;
    const t = tickers[bybitSymbol];
    if (!t) return null;
    const spreadPct = t.bid1 > 0 ? ((t.ask1 - t.bid1) / t.bid1) * 100 : 0.02;
    return {
      coin, bybitSymbol, price: t.lastPrice, chgPct: t.chgPct, spreadPct,
      spec: instMap[bybitSymbol] || { qtyStep: 0.01, minOrderQty: 0.01, maxOrderQty: 100000, tickSize: 0.01 }
    };
  }).filter(Boolean).sort((a, b) => Math.abs(b.chgPct) - Math.abs(a.chgPct)).slice(0, 4);

  const results = await Promise.all(candidates.map(async cand => {
    const safeK = (tf, lim) => fetchKlines(cand.coin, tf, lim).catch(() => null);
    const [k1d, k4h, k1h, k15m, k5m] = await Promise.all([
      safeK('1d', 60), safeK('4h', 60), safeK('1h', 60), safeK('15m', 90), safeK('5m', 60)
    ]);
    const toClosed = (k) => (Array.isArray(k) && k.length >= 22 ? k.slice(0, -1) : null);
    const c15m = toClosed(k15m);
    if (!c15m) return null;

    const mtf = evaluateMTF({
      closes1d: toClosed(k1d)?.map(x => x[4]),
      closes4h: toClosed(k4h)?.map(x => x[4]),
      closes1h: toClosed(k1h)?.map(x => x[4]),
      closes15m: c15m.map(x => x[4]),
      closes5m: toClosed(k5m)?.map(x => x[4])
    });

    const highs = c15m.map(x => x[2]), lows = c15m.map(x => x[3]), closes = c15m.map(x => x[4]);
    const atr = calcWilderATR(highs, lows, closes, 14);
    let dir = (mtf.decision === 'LONG' || mtf.decision === 'SHORT') ? mtf.decision : (closes[closes.length - 1] >= calcEMAVal(closes, 20) ? 'LONG' : 'SHORT');
    if (humanBias === 'long_only') dir = 'LONG';
    if (humanBias === 'short_only') dir = 'SHORT';

    const levels = computeLevels({ closedCandles: c15m, livePrice: cand.price, direction: dir, tickSize: cand.spec.tickSize, atr, spreadPct: cand.spreadPct });
    const size = levels.valid ? calcLiveOrderSize({
      availBal, entryPrice: levels.entry, slPrice: levels.sl,
      qtyStep: cand.spec.qtyStep, minOrderQty: cand.spec.minOrderQty, maxOrderQty: cand.spec.maxOrderQty,
      riskPerTradePct
    }) : { approved: false, orderQty: 0, reason: levels.reason };

    const isNoTrade = mtf.conflictDetected || !levels.valid || !size.approved;
    const noTradeReason = mtf.conflictDetected ? mtf.reason : (!levels.valid ? levels.reason : (!size.approved ? size.reason : null));

    const entry = levels.entry || cand.price;
    const sl = levels.sl || formatBybitPrice(entry * (dir === 'LONG' ? 0.985 : 1.015), cand.spec.tickSize);
    const tp1 = levels.tp1 || formatBybitPrice(entry * (dir === 'LONG' ? 1.02 : 0.98), cand.spec.tickSize);
    const tp = levels.tp || formatBybitPrice(entry * (dir === 'LONG' ? 1.08 : 0.92), cand.spec.tickSize);

    return {
      decision: isNoTrade ? 'NO_TRADE' : dir,
      noTradeReason,
      coin: cand.coin,
      bybitSymbol: cand.bybitSymbol,
      direction: dir,
      spreadPct: +cand.spreadPct.toFixed(3),
      rrRatio: levels.rrRatio || 2.0,
      chartTf: '15m',
      mtfConfluenceScore: mtf.agreementPct,
      mtfBreakdown: mtf.breakdown,
      orderQty: size.orderQty,
      qtyStep: cand.spec.qtyStep,
      entry, sl, tp1, tp,
      summaryNote: `MTF: ${mtf.agreementPct}% (${mtf.bullCount}B / ${mtf.bearCount}S / ${mtf.neutralCount}N) · Balance $${Number(availBal).toFixed(2)}`
    };
  }));

  const all = results.filter(Boolean);
  const valid = all.filter(x => x.decision !== 'NO_TRADE').sort((a, b) => b.mtfConfluenceScore - a.mtfConfluenceScore);
  const chosen = valid.length ? valid : all;
  if (!chosen.length) throw new Error('NO_TRADE: Bybit market data unavailable.');

  const best = chosen[0];
  if (best.decision === 'NO_TRADE' && enforceVeto) throw new Error(best.noTradeReason || 'NO_TRADE: Safety gate rejected setup.');
  return { scannedCount: candidates.length, pick: best };
}

function isServerLiveAuthorized() {
  return String(process.env.ALLOW_LIVE_TRADING || '').trim().toLowerCase() === 'true';
}

module.exports = async (req, res) => {
  try {
    const method = String(req.method || 'GET').toUpperCase();
    if (!['GET', 'POST'].includes(method)) return res.status(405).json({ error: 'Method Not Allowed' });

    const clientIp = String(req.headers?.['x-vercel-forwarded-for'] || req.socket?.remoteAddress || 'local').split(',')[0].trim();
    if (!(await checkRateLimit(clientIp, 90))) return res.status(429).json({ error: 'Rate limit exceeded.' });

    let body = {};
    if (method === 'POST') {
      if (typeof req.body === 'string') {
        try { body = JSON.parse(req.body || '{}'); } catch (e) { return res.status(400).json({ error: 'Invalid JSON request body.' }); }
      } else {
        body = req.body || {};
      }
    } else {
      body = req.query || {};
    }
    const action = String(body.action || 'status').trim();

    if (action === 'bybit_klines') {
      try {
        const kl = await fetchKlines(body.symbol || 'BTC', body.tf || '15m', 110);
        const candles = (kl || []).map(k => ({ time: Math.floor(k[0] / 1000), open: k[1], high: k[2], low: k[3], close: k[4] }));
        return res.status(200).json({ ok: true, candles });
      } catch (e) {
        return res.status(200).json({ ok: false, candles: [], error: e.message });
      }
    }

    const expectedSecret = (process.env.AGENT_SECRET || '').trim();
    const providedSecret = String(req.headers?.['x-agent-secret'] || '').trim();
    if (expectedSecret && !safeCompareSecret(providedSecret, expectedSecret)) {
      return res.status(401).json({ error: 'Unauthorized: Valid AGENT_SECRET required.' });
    }

    if (['scan_and_trade', 'close', 'emergency_stop'].includes(action)) {
      const nonceCheck = await validateRequestNonce(req.headers?.['x-request-nonce'], req.headers?.['x-request-ts']);
      if (!nonceCheck.valid) return res.status(401).json({ error: nonceCheck.reason });
    }

    const liveArmed = isServerLiveAuthorized();
    const telemetry = {
      liveTradingStatus: liveArmed ? 'BYBIT_LIVE_ARMED' : 'ENV_GATE_LOCKED',
      region: process.env.VERCEL_REGION || 'sin1'
    };

    if (action === 'status') {
      const acct = await fetchBybitWalletAndPositions();
      return res.status(200).json({ ok: true, systemTelemetry: telemetry, ...acct });
    }

    if (action === 'analyze_only') {
      let acct = { wallet: { availableBalance: 0, totalEquity: 0, unrealizedPnl: 0 }, positions: [] };
      let walletWarning = null;
      try {
        acct = await fetchBybitWalletAndPositions();
      } catch (e) {
        walletWarning = `Bybit Wallet Sync Warning: ${e.message}`;
      }
      const scanRes = await runSixStageScan({
        coinMode: body.coinMode || 'auto',
        manualCoin: body.manualCoin || 'SOL',
        humanBias: body.humanBias || 'ai_100',
        riskPerTradePct: Number(body.riskPerTradePct || 0.03),
        availBal: acct.wallet.availableBalance,
        enforceVeto: false
      });
      return res.status(200).json({
        ok: true,
        decision: scanRes.pick.decision,
        noTradeReason: scanRes.pick.noTradeReason,
        walletWarning,
        systemTelemetry: telemetry,
        ...acct,
        ...scanRes
      });
    }

    if (action === 'scan_and_trade') {
      if (!liveArmed) return res.status(403).json({ error: 'SERVER_LIVE_GATE_LOCKED: Set ALLOW_LIVE_TRADING=true in Vercel Environment Variables.' });
      if (body.liveConfirmed !== true) return res.status(403).json({ error: 'LIVE_CONFIRMATION_MISSING: Tick Arm Real Bybit Orders.' });

      const lock = await acquireLock('bybit_live_trade_lock', 12000);
      if (!lock.acquired) return res.status(400).json({ error: lock.reason });
      try {
        const acct = await fetchBybitWalletAndPositions();
        const scanRes = await runSixStageScan({
          coinMode: body.coinMode || 'auto',
          manualCoin: body.manualCoin || 'SOL',
          humanBias: body.humanBias || 'ai_100',
          riskPerTradePct: Number(body.riskPerTradePct || 0.03),
          availBal: acct.wallet.availableBalance,
          enforceVeto: true
        });
        const pick = scanRes.pick;
        const lev = String(Math.min(20, Math.max(1, Number(body.leverage || 5))));
        try {
          await bybitV5Req('POST', '/v5/position/set-leverage', {
            category: 'linear', symbol: pick.bybitSymbol, buyLeverage: lev, sellLeverage: lev
          });
        } catch (e) { /* ignore if leverage already set */ }

        const side = pick.direction === 'LONG' ? 'Buy' : 'Sell';
        const orderRes = await bybitV5Req('POST', '/v5/order/create', {
          category: 'linear',
          symbol: pick.bybitSymbol,
          side,
          orderType: 'Market',
          qty: String(pick.orderQty),
          timeInForce: 'IOC',
          stopLoss: String(pick.sl),
          takeProfit: String(pick.tp),
          positionIdx: 0
        });

        return res.status(200).json({
          ok: true,
          systemTelemetry: telemetry,
          pick,
          exec: {
            orderId: orderRes?.orderId || 'LIVE_ORDER',
            orderTypeLabel: `LIVE ${pick.bybitSymbol} ${pick.direction} · Qty ${pick.orderQty} @ ${pick.entry} (${lev}x)`
          }
        });
      } catch (err) {
        return res.status(400).json({ decision: 'NO_TRADE', error: err.message });
      } finally {
        await releaseLock('bybit_live_trade_lock', lock.token);
      }
    }

    if (action === 'close') {
      if (!liveArmed) return res.status(403).json({ error: 'ALLOW_LIVE_TRADING=true required.' });
      const closeSide = body.side === 'Buy' ? 'Sell' : 'Buy';
      const orderRes = await bybitV5Req('POST', '/v5/order/create', {
        category: 'linear',
        symbol: toBybitSymbol(body.symbol),
        side: closeSide,
        orderType: 'Market',
        qty: String(body.qty),
        reduceOnly: true,
        positionIdx: 0
      });
      return res.status(200).json({ ok: true, orderId: orderRes?.orderId });
    }

    if (action === 'emergency_stop') {
      if (!liveArmed) return res.status(403).json({ error: 'ALLOW_LIVE_TRADING=true required.' });
      const acct = await fetchBybitWalletAndPositions();
      let closedCount = 0;
      for (const pos of acct.positions) {
        await bybitV5Req('POST', '/v5/order/create', {
          category: 'linear',
          symbol: pos.symbol,
          side: pos.side === 'Buy' ? 'Sell' : 'Buy',
          orderType: 'Market',
          qty: String(pos.size),
          reduceOnly: true,
          positionIdx: 0
        });
        closedCount++;
      }
      return res.status(200).json({ ok: true, closedCount });
    }

    return res.status(400).json({ error: `Unhandled action: ${action}` });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
