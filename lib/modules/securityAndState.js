// Security, Distributed Redis Lock, Nonce Replay Guard, Rate Limiter, Trade Journal & System Health Monitor
const crypto = require('crypto');
const { fetchWithTimeout, safeReadJson } = require('./marketData');

let localLockUntil = 0;
let localLockToken = null;
let localHalted = false;
const localNonceCache = new Map();
const localRateLimitMap = {};
const localJournal = [];

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

function makeResponse(ok, payload = {}, { sourceStatus = 'LIVE_BYBIT_V5', errorCode = null } = {}) {
  return {
    ok: Boolean(ok),
    sourceStatus,
    updatedAt: new Date().toISOString(),
    ...(errorCode ? { errorCode } : {}),
    ...payload
  };
}

async function redisCmd(command, ...args) {
  const url = (process.env.UPSTASH_REDIS_REST_URL || '').trim().replace(/^["']|["']$/g, '');
  const token = (process.env.UPSTASH_REDIS_REST_TOKEN || '').trim().replace(/^["']|["']$/g, '');
  if (!url || !token) return { ok: false, result: null, source: 'DEGRADED_NO_REDIS_CONFIG' };
  try {
    const r = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([command, ...args])
    }, 3000);
    if (!r.ok) return { ok: false, result: null, source: `DEGRADED_REDIS_HTTP_${r.status}` };
    const j = await safeReadJson(r, 'Upstash Redis');
    if (j.error) return { ok: false, result: null, source: 'DEGRADED_REDIS_CMD_ERROR' };
    return { ok: true, result: j.result, source: 'UPSTASH_REDIS_VERIFIED' };
  } catch (e) {
    return { ok: false, result: null, source: 'DEGRADED_REDIS_UNREACHABLE' };
  }
}

async function acquireLock(lockName = 'bybit_live_lock', ttlMs = 15000) {
  const token = crypto.randomBytes(12).toString('hex');
  const res = await redisCmd('SET', lockName, token, 'NX', 'PX', String(ttlMs));
  if (res.source === 'UPSTASH_REDIS_VERIFIED') {
    if (res.result !== 'OK') return { acquired: false, token: null, mode: res.source, reason: 'Concurrent execution locked by Redis.' };
    return { acquired: true, token, mode: res.source };
  }
  const now = Date.now();
  if (now < localLockUntil) return { acquired: false, token: null, mode: res.source, reason: 'Concurrent execution locked (memory fallback).' };
  localLockUntil = now + ttlMs;
  localLockToken = token;
  return { acquired: true, token, mode: res.source };
}

async function releaseLock(lockName = 'bybit_live_lock', token = null) {
  if (!token) return;
  if (localLockToken === token) { localLockUntil = 0; localLockToken = null; }
  const lua = 'if redis.call("get",KEYS[1]) == ARGV[1] then return redis.call("del",KEYS[1]) else return 0 end';
  await redisCmd('EVAL', lua, '1', lockName, token);
}

async function validateRequestNonce(nonce, tsHeader, requireStrict = true) {
  if (!nonce || !tsHeader) {
    return requireStrict
      ? { valid: false, errorCode: 'MISSING_NONCE_OR_TS', reason: 'Protected live action requires x-request-nonce and x-request-ts headers.' }
      : { valid: true };
  }
  const reqTs = Number(tsHeader);
  if (!Number.isFinite(reqTs) || Math.abs(Date.now() - reqTs) > 120000) {
    return { valid: false, errorCode: 'EXPIRED_TIMESTAMP', reason: 'Request timestamp expired (>120s drift).' };
  }
  const cleanNonce = String(nonce).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  if (cleanNonce.length < 8) {
    return { valid: false, errorCode: 'INVALID_NONCE', reason: 'Nonce must be >= 8 alphanumeric characters.' };
  }
  const r = await redisCmd('SET', `nonce:${cleanNonce}`, '1', 'NX', 'PX', '180000');
  if (r.source === 'UPSTASH_REDIS_VERIFIED') {
    return r.result === 'OK'
      ? { valid: true, storage: r.source }
      : { valid: false, errorCode: 'NONCE_REPLAY', reason: 'Replay rejected: Nonce already used.' };
  }
  const now = Date.now();
  for (const [k, exp] of localNonceCache.entries()) if (exp <= now) localNonceCache.delete(k);
  if (localNonceCache.has(cleanNonce)) {
    return { valid: false, errorCode: 'NONCE_REPLAY', reason: 'Replay rejected: Duplicate nonce (memory cache).' };
  }
  localNonceCache.set(cleanNonce, now + 180000);
  return { valid: true, storage: r.source };
}

function checkRateLimit(clientIp, maxPerMin = 60) {
  const ip = String(clientIp || 'unknown').slice(0, 64);
  const nowMs = Date.now();
  const rl = localRateLimitMap[ip] || { count: 0, resetAt: nowMs + 60000 };
  if (nowMs > rl.resetAt) { rl.count = 0; rl.resetAt = nowMs + 60000; }
  rl.count += 1;
  localRateLimitMap[ip] = rl;
  return rl.count <= maxPerMin;
}

async function getTradingHalted() {
  const r = await redisCmd('GET', 'bybit_bot:halted');
  if (r.source === 'UPSTASH_REDIS_VERIFIED') {
    return { halted: r.result === '1', storage: r.source };
  }
  return { halted: localHalted, storage: r.source };
}

async function setTradingHalted(flag) {
  localHalted = Boolean(flag);
  const r = await redisCmd('SET', 'bybit_bot:halted', flag ? '1' : '0');
  return { halted: localHalted, storage: r.source };
}

async function appendJournalEntry(entry) {
  const record = { ts: new Date().toISOString(), ...entry };
  localJournal.unshift(record);
  if (localJournal.length > 50) localJournal.pop();
  await redisCmd('LPUSH', 'bybit_bot:journal', JSON.stringify(record));
  await redisCmd('LTRIM', 'bybit_bot:journal', '0', '49');
  return record;
}

async function getJournalEntries() {
  const r = await redisCmd('LRANGE', 'bybit_bot:journal', '0', '24');
  if (r.source === 'UPSTASH_REDIS_VERIFIED' && Array.isArray(r.result)) {
    return r.result.map(x => { try { return JSON.parse(x); } catch (e) { return null; } }).filter(Boolean);
  }
  return localJournal.slice(0, 25);
}

async function getSystemHealth() {
  const redisPing = await redisCmd('PING');
  const haltedState = await getTradingHalted();
  return {
    region: process.env.VERCEL_REGION || 'local',
    nodeVersion: process.version,
    envConfigured: {
      AGENT_SECRET: Boolean((process.env.AGENT_SECRET || '').trim()),
      CRON_SECRET: Boolean((process.env.CRON_SECRET || '').trim()),
      ALLOW_LIVE_TRADING: String(process.env.ALLOW_LIVE_TRADING || '').trim().toLowerCase() === 'true',
      BYBIT_API_KEY: Boolean((process.env.BYBIT_API_KEY || '').trim()),
      BYBIT_API_SECRET: Boolean((process.env.BYBIT_API_SECRET || '').trim()),
      UPSTASH_REDIS: Boolean((process.env.UPSTASH_REDIS_REST_URL || '').trim() && (process.env.UPSTASH_REDIS_REST_TOKEN || '').trim())
    },
    redisStatus: redisPing.source,
    tradingHalted: haltedState.halted
  };
}


const localEquityHistory = [];

async function recordEquitySnapshot(equity) {
  const val = Number(equity);
  if (!Number.isFinite(val) || val <= 0) return;
  const pt = { ts: Date.now(), equity: +val.toFixed(2) };
  localEquityHistory.push(pt);
  if (localEquityHistory.length > 60) localEquityHistory.shift();
  await redisCmd('RPUSH', 'bybit_bot:equity_curve', JSON.stringify(pt));
  await redisCmd('LTRIM', 'bybit_bot:equity_curve', '-60', '-1');
}

async function getEquityHistory() {
  const r = await redisCmd('LRANGE', 'bybit_bot:equity_curve', '0', '59');
  if (r.source === 'UPSTASH_REDIS_VERIFIED' && Array.isArray(r.result) && r.result.length) {
    return r.result.map(x => { try { return JSON.parse(x); } catch (e) { return null; } }).filter(Boolean);
  }
  return localEquityHistory.slice(-60);
}


const localDailyStart = new Map();
const localPartialTp = new Set();

function getUtcDayKey() {
  return new Date().toISOString().slice(0, 10);
}

// v6 Update #9: Daily Max Loss & Daily Profit Target Lock
async function checkDailyGuard(currentEquity, { maxDailyLossPct = 5, dailyProfitTargetPct = 10 } = {}) {
  const eq = Number(currentEquity || 0);
  if (!Number.isFinite(eq) || eq <= 0) {
    return { locked: false, dailyPnlPct: 0, startEquity: 0, reason: null };
  }
  const dayKey = `bybit_bot:daily_start:${getUtcDayKey()}`;
  let startEq = localDailyStart.get(dayKey);

  if (!startEq) {
    const r = await redisCmd('GET', dayKey);
    if (r.source === 'UPSTASH_REDIS_VERIFIED' && r.result) {
      startEq = Number(r.result);
    }
  }
  if (!Number.isFinite(startEq) || startEq <= 0) {
    startEq = eq;
    localDailyStart.set(dayKey, startEq);
    await redisCmd('SET', dayKey, String(startEq), 'EX', '90000');
  } else {
    localDailyStart.set(dayKey, startEq);
  }

  const dailyPnlPct = +(((eq - startEq) / startEq) * 100).toFixed(2);
  const maxLoss = Math.abs(Number(maxDailyLossPct || 5));
  const maxProfit = Math.abs(Number(dailyProfitTargetPct || 10));

  if (dailyPnlPct <= -maxLoss) {
    return {
      locked: true,
      errorCode: 'DAILY_LOSS_LOCK',
      dailyPnlPct,
      startEquity: startEq,
      reason: `DAILY_LOSS_LOCK: Daily PnL (${dailyPnlPct}%) hit max daily loss limit (-${maxLoss}%). Trading paused until next UTC day.`
    };
  }
  if (dailyPnlPct >= maxProfit) {
    return {
      locked: true,
      errorCode: 'DAILY_PROFIT_LOCK',
      dailyPnlPct,
      startEquity: startEq,
      reason: `DAILY_PROFIT_LOCK: Daily PnL (+${dailyPnlPct}%) reached daily profit target (+${maxProfit}%). Profits locked for today.`
    };
  }
  return { locked: false, errorCode: null, dailyPnlPct, startEquity: startEq, reason: null };
}

async function hasPartialTpDone(symbol, avgPrice) {
  const key = `bybit_bot:ptp:${symbol}:${avgPrice}`;
  if (localPartialTp.has(key)) return true;
  const r = await redisCmd('GET', key);
  if (r.source === 'UPSTASH_REDIS_VERIFIED' && r.result === '1') {
    localPartialTp.add(key);
    return true;
  }
  return false;
}

async function markPartialTpDone(symbol, avgPrice) {
  const key = `bybit_bot:ptp:${symbol}:${avgPrice}`;
  localPartialTp.add(key);
  await redisCmd('SET', key, '1', 'EX', '604800');
}


const localPosMeta = new Map();

async function requireVerifiedRedis() {
  const ping = await redisCmd('PING');
  if (ping.source !== 'UPSTASH_REDIS_VERIFIED') {
    return {
      ok: false,
      errorCode: 'REDIS_REQUIRED_FOR_LIVE',
      reason: 'FAIL_CLOSED: Upstash Redis is required and must be reachable for LIVE trading (locks, nonces, halt flag, daily guard, partial-TP state).'
    };
  }
  return { ok: true, errorCode: null };
}

// v8: Persist original entry & initial SL/R at position open so Partial TP1 never recalculates from Breakeven SL
async function savePositionMeta(symbol, { entry, initialSl, direction }) {
  const initialRiskDist = Math.abs(Number(entry) - Number(initialSl));
  const meta = {
    symbol,
    entry: Number(entry),
    initialSl: Number(initialSl),
    initialRiskDist,
    direction,
    partialTpDone: false,
    openedAt: Date.now()
  };
  const key = `bybit_bot:pos_meta:${symbol}`;
  localPosMeta.set(key, meta);
  await redisCmd('SET', key, JSON.stringify(meta), 'EX', '1209600');
  return meta;
}

async function getPositionMeta(symbol) {
  const key = `bybit_bot:pos_meta:${symbol}`;
  const r = await redisCmd('GET', key);
  if (r.source === 'UPSTASH_REDIS_VERIFIED' && r.result) {
    try { return JSON.parse(r.result); } catch (e) {}
  }
  return localPosMeta.get(key) || null;
}

async function markPositionPartialTpDone(symbol) {
  const key = `bybit_bot:pos_meta:${symbol}`;
  const meta = (await getPositionMeta(symbol)) || { symbol, partialTpDone: true };
  meta.partialTpDone = true;
  meta.partialTpAt = Date.now();
  localPosMeta.set(key, meta);
  await redisCmd('SET', key, JSON.stringify(meta), 'EX', '1209600');
}

module.exports = {
  requireVerifiedRedis,
  savePositionMeta,
  getPositionMeta,
  markPositionPartialTpDone,
  checkDailyGuard,
  hasPartialTpDone,
  markPartialTpDone,
  recordEquitySnapshot,
  getEquityHistory,
  safeCompareSecret,
  makeResponse,
  redisCmd,
  acquireLock,
  releaseLock,
  validateRequestNonce,
  checkRateLimit,
  getTradingHalted,
  setTradingHalted,
  appendJournalEntry,
  getJournalEntries,
  getSystemHealth
};
