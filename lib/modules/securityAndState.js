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
  if (!strA || !strB) return false;
  try {
    // Hash both sides first so comparison time never leaks the secret length
    const ha = crypto.createHash('sha256').update(strA, 'utf8').digest();
    const hb = crypto.createHash('sha256').update(strB, 'utf8').digest();
    return crypto.timingSafeEqual(ha, hb);
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
  // Drop expired entries so the map cannot grow forever on a warm instance
  const keys = Object.keys(localRateLimitMap);
  if (keys.length > 500) {
    for (const k of keys) if (nowMs > localRateLimitMap[k].resetAt) delete localRateLimitMap[k];
  }
  const rl = localRateLimitMap[ip] || { count: 0, resetAt: nowMs + 60000 };
  if (nowMs > rl.resetAt) { rl.count = 0; rl.resetAt = nowMs + 60000; }
  rl.count += 1;
  localRateLimitMap[ip] = rl;
  return rl.count <= maxPerMin;
}

// Update 26: separate, much stricter throttle for FAILED secret attempts (brute-force protection)
const localAuthFailMap = {};
function isAuthBlocked(clientIp, maxFails = 8) {
  const ip = String(clientIp || 'unknown').slice(0, 64);
  const rec = localAuthFailMap[ip];
  return Boolean(rec && Date.now() <= rec.resetAt && rec.count >= maxFails);
}
function recordAuthFailure(clientIp) {
  const ip = String(clientIp || 'unknown').slice(0, 64);
  const nowMs = Date.now();
  const keys = Object.keys(localAuthFailMap);
  if (keys.length > 500) {
    for (const k of keys) if (nowMs > localAuthFailMap[k].resetAt) delete localAuthFailMap[k];
  }
  const rec = localAuthFailMap[ip] && nowMs <= localAuthFailMap[ip].resetAt ? localAuthFailMap[ip] : { count: 0, resetAt: nowMs + 10 * 60000 };
  rec.count += 1;
  localAuthFailMap[ip] = rec;
  return rec.count;
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
  const persisted = r.source === 'UPSTASH_REDIS_VERIFIED' && r.ok;
  return {
    halted: localHalted,
    persisted,
    storage: r.source,
    warning: persisted ? null : 'EMERGENCY_STOP_LOCAL_ONLY: Redis unreachable; halt state is in-memory only.'
  };
}

function sanitizeErrorForClient(err) {
  const msg = String(err?.message || err || 'Unknown error');
  return msg
    .replace(/(gsk_[a-zA-Z0-9_-]{8,})/g, '[REDACTED_GROQ_KEY]')
    .replace(/(xai-[a-zA-Z0-9_-]{8,})/g, '[REDACTED_XAI_KEY]')
    .replace(/(Bearer\s+[a-zA-Z0-9._-]{8,})/gi, 'Bearer [REDACTED]')
    .slice(0, 320);
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

// v8.3: Daily Max Loss & Daily Profit Target Lock (Fail-Closed when equity unavailable in strict mode)
async function checkDailyGuard(currentEquity, { maxDailyLossPct = 5, dailyProfitTargetPct = 10, strict = false } = {}) {
  const eq = Number(currentEquity);
  if (!Number.isFinite(eq) || eq <= 0) {
    if (strict) {
      return {
        locked: true,
        errorCode: 'DAILY_GUARD_EQUITY_UNAVAILABLE',
        dailyPnlPct: 0,
        startEquity: 0,
        reason: 'FAIL_CLOSED: Account equity unavailable or zero; Daily Risk Guard locked live execution.'
      };
    }
    return { locked: false, errorCode: null, dailyPnlPct: 0, startEquity: 0, reason: 'Equity unavailable (non-strict preview).' };
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
async function savePositionMeta(symbol, { entry, initialSl, direction, atr = 0, tradeMode = 'NORMAL' }) {
  const initialRiskDist = Math.abs(Number(entry) - Number(initialSl));
  const meta = {
    symbol,
    entry: Number(entry),
    initialSl: Number(initialSl),
    initialRiskDist,
    direction,
    atr: Number(atr || 0),
    tradeMode: tradeMode === 'EA' ? 'EA' : 'NORMAL',
    partialTpDone: false,
    pyramided: false,
    tpExtended: false,
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


let localAutoWalletAlloc = { enabled: false, pct: 50, updatedAt: null };

async function getAutoWalletAlloc() {
  const r = await redisCmd('GET', 'bybit_bot:auto_wallet_alloc');
  if (r.source === 'UPSTASH_REDIS_VERIFIED' && r.result) {
    try {
      const parsed = JSON.parse(r.result);
      const pct = Math.min(100, Math.max(10, Number(parsed.pct || 50)));
      localAutoWalletAlloc = { enabled: Boolean(parsed.enabled), pct, updatedAt: parsed.updatedAt || null, storage: r.source };
      return localAutoWalletAlloc;
    } catch (e) {}
  }
  return { ...localAutoWalletAlloc, storage: r.source };
}

async function setAutoWalletAlloc({ enabled = false, pct = 50 } = {}) {
  const cleanPct = Math.min(100, Math.max(10, Math.round(Number(pct || 50))));
  const state = { enabled: Boolean(enabled), pct: cleanPct, updatedAt: new Date().toISOString() };
  localAutoWalletAlloc = state;
  const r = await redisCmd('SET', 'bybit_bot:auto_wallet_alloc', JSON.stringify(state));
  return { ...state, persisted: r.source === 'UPSTASH_REDIS_VERIFIED' && r.ok, storage: r.source };
}


let localCoinFilters = { whitelist: [], blacklist: [], blockWeekend: false, sessionOnly: false, strategyMode: 'strict', pyramidingEnabled: false, sniperLimitScaling: false, topMoverScanner: false, eaMode: false, svMode: false, riskPct: null, leverage: null };
let localLastDailyReportDay = '';

async function getBotFilters() {
  const r = await redisCmd('GET', 'bybit_bot:v9_filters');
  if (r.source === 'UPSTASH_REDIS_VERIFIED' && r.result) {
    try {
      const p = JSON.parse(r.result);
      localCoinFilters = {
        whitelist: Array.isArray(p.whitelist) ? p.whitelist : [],
        blacklist: Array.isArray(p.blacklist) ? p.blacklist : [],
        blockWeekend: Boolean(p.blockWeekend),
        sessionOnly: Boolean(p.sessionOnly),
        strategyMode: p.strategyMode === 'balanced' ? 'balanced' : 'strict',
        pyramidingEnabled: Boolean(p.pyramidingEnabled),
        sniperLimitScaling: Boolean(p.sniperLimitScaling),
        topMoverScanner: Boolean(p.topMoverScanner),
        eaMode: Boolean(p.eaMode),
        svMode: Boolean(p.svMode),
        riskPct: p.riskPct != null ? Number(p.riskPct) : null,
        leverage: p.leverage != null ? Number(p.leverage) : null
      };
      return { ...localCoinFilters, storage: r.source };
    } catch (e) {}
  }
  return { ...localCoinFilters, storage: r.source };
}

async function setBotFilters({ whitelist = [], blacklist = [], blockWeekend = false, sessionOnly = false, strategyMode = 'strict', pyramidingEnabled = false, sniperLimitScaling = false, topMoverScanner = false, eaMode = false, svMode = false, riskPct = null, leverage = null } = {}) {
  const cleanList = arr => [...new Set((Array.isArray(arr) ? arr : String(arr || '').split(',')).map(x => String(x || '').trim().toUpperCase().replace(/USDT$/, '')).filter(Boolean))];
  const state = {
    whitelist: cleanList(whitelist),
    blacklist: cleanList(blacklist),
    blockWeekend: Boolean(blockWeekend),
    sessionOnly: Boolean(sessionOnly),
    strategyMode: strategyMode === 'balanced' ? 'balanced' : 'strict',
    pyramidingEnabled: Boolean(pyramidingEnabled),
    sniperLimitScaling: Boolean(sniperLimitScaling),
    topMoverScanner: Boolean(topMoverScanner),
    eaMode: Boolean(eaMode),
    svMode: Boolean(svMode),
    riskPct: riskPct != null && !isNaN(Number(riskPct)) ? Number(riskPct) : null,
    leverage: leverage != null && !isNaN(Number(leverage)) ? Number(leverage) : null,
    updatedAt: new Date().toISOString()
  };
  localCoinFilters = state;
  const r = await redisCmd('SET', 'bybit_bot:v9_filters', JSON.stringify(state));
  return { ...state, persisted: r.source === 'UPSTASH_REDIS_VERIFIED' && r.ok, storage: r.source };
}

async function shouldSendDailyReport() {
  const day = getUtcDayKey();
  const hour = new Date().getUTCHours();
  if (hour < 23) return false;
  if (localLastDailyReportDay === day) return false;
  const r = await redisCmd('GET', `bybit_bot:daily_report:${day}`);
  if (r.source === 'UPSTASH_REDIS_VERIFIED' && r.result === '1') {
    localLastDailyReportDay = day;
    return false;
  }
  return true;
}

async function markDailyReportSent() {
  const day = getUtcDayKey();
  localLastDailyReportDay = day;
  await redisCmd('SET', `bybit_bot:daily_report:${day}`, '1', 'EX', '172800');
}

async function markPositionTpStage(symbol, stage) {
  const key = `bybit_bot:pos_meta:${symbol}`;
  const meta = (await getPositionMeta(symbol)) || { symbol };
  meta.tpStage = Math.max(Number(meta.tpStage || 0), Number(stage || 0));
  if (stage >= 1) meta.partialTpDone = true;
  localPosMeta.set(key, meta);
  await redisCmd('SET', key, JSON.stringify(meta), 'EX', '1209600');
}


let localCircuitBreakerUntil = 0;
let localCircuitBreakerReason = null;
const localSlippageMap = new Map();

// v10.0 #15: Flash Crash / Spike Circuit Breaker (60m pause)
async function tripCircuitBreaker(reason, durationMinutes = 60) {
  const until = Date.now() + durationMinutes * 60 * 1000;
  localCircuitBreakerUntil = until;
  localCircuitBreakerReason = reason;
  await redisCmd('SET', 'bybit_bot:circuit_breaker', JSON.stringify({ until, reason }), 'EX', String(durationMinutes * 60));
  return { active: true, until, reason };
}

async function getCircuitBreaker() {
  const r = await redisCmd('GET', 'bybit_bot:circuit_breaker');
  if (r.source === 'UPSTASH_REDIS_VERIFIED' && r.result) {
    try {
      const p = JSON.parse(r.result);
      if (Number(p.until || 0) > Date.now()) {
        return { active: true, until: p.until, reason: p.reason };
      }
    } catch (e) {}
  }
  if (localCircuitBreakerUntil > Date.now()) {
    return { active: true, until: localCircuitBreakerUntil, reason: localCircuitBreakerReason };
  }
  return { active: false, until: 0, reason: null };
}

// v10.0 #19: Slippage & Execution Quality Tracker
async function recordSlippage(symbol, expectedPrice, actualPrice) {
  const exp = Number(expectedPrice || 0);
  const act = Number(actualPrice || 0);
  if (exp <= 0 || act <= 0) return null;
  const slipPct = +((Math.abs(act - exp) / exp) * 100).toFixed(4);
  const key = `bybit_bot:slippage:${symbol}`;
  const prev = localSlippageMap.get(key) || { count: 0, avgSlipPct: 0, lastSlipPct: 0 };
  const nextCount = prev.count + 1;
  const nextAvg = +(((prev.avgSlipPct * prev.count) + slipPct) / nextCount).toFixed(4);
  const rec = { symbol, count: nextCount, avgSlipPct: nextAvg, lastSlipPct: slipPct, updatedAt: Date.now() };
  localSlippageMap.set(key, rec);
  await redisCmd('SET', key, JSON.stringify(rec), 'EX', '1209600');
  return rec;
}

async function getSlippageStats(symbol) {
  const key = `bybit_bot:slippage:${symbol}`;
  const r = await redisCmd('GET', key);
  if (r.source === 'UPSTASH_REDIS_VERIFIED' && r.result) {
    try { return JSON.parse(r.result); } catch (e) {}
  }
  return localSlippageMap.get(key) || { symbol, count: 0, avgSlipPct: 0, lastSlipPct: 0 };
}

// v10.0 #6: Mark position as pyramided once
async function markPositionPyramided(symbol) {
  const key = `bybit_bot:pos_meta:${symbol}`;
  const meta = (await getPositionMeta(symbol)) || { symbol };
  meta.pyramided = true;
  meta.pyramidedAt = Date.now();
  localPosMeta.set(key, meta);
  await redisCmd('SET', key, JSON.stringify(meta), 'EX', '1209600');
}


const localPostMortemSent = new Set();

async function hasLossPostMortemSent(tradeKey) {
  const k = `bybit_bot:loss_pm:${tradeKey}`;
  if (localPostMortemSent.has(k)) return true;
  const r = await redisCmd('GET', k);
  if (r.source === 'UPSTASH_REDIS_VERIFIED' && r.result === '1') {
    localPostMortemSent.add(k);
    return true;
  }
  return false;
}

async function markLossPostMortemSent(tradeKey) {
  const k = `bybit_bot:loss_pm:${tradeKey}`;
  localPostMortemSent.add(k);
  await redisCmd('SET', k, '1', 'EX', '604800');
}


// v11.0 #2: Mark position trailing stop tightened at >= 4R
async function markPositionTrailTightened(symbol) {
  const key = `bybit_bot:pos_meta:${symbol}`;
  const meta = (await getPositionMeta(symbol)) || { symbol };
  meta.trailTightened = true;
  meta.trailTightenedAt = Date.now();
  localPosMeta.set(key, meta);
  await redisCmd('SET', key, JSON.stringify(meta), 'EX', '1209600');
}

// v14.0 ULTRA PRO MAX: Mark position Take Profit extended (Big Runner Mode)
async function markPositionTpExtended(symbol, newTp) {
  const key = `bybit_bot:pos_meta:${symbol}`;
  const meta = (await getPositionMeta(symbol)) || { symbol };
  meta.tpExtended = true;
  meta.extendedTp = Number(newTp || 0);
  meta.tpExtendedAt = Date.now();
  localPosMeta.set(key, meta);
  await redisCmd('SET', key, JSON.stringify(meta), 'EX', '1209600');
}

// v11.0 #9: Profit Vault (Auto-Lock 50% of net profits once equity grows >= +20% above baseline)
let localProfitVault = { baseCapital: 0, lockedUsdt: 0 };

async function getProfitVaultState(currentEquity) {
  const eq = Number(currentEquity || 0);
  if (!Number.isFinite(eq) || eq <= 0) {
    return { active: false, baseCapital: 0, lockedUsdt: 0, tradableEquity: 0 };
  }
  const envBase = Number(process.env.PROFIT_VAULT_BASE_USDT || 0);
  const key = 'bybit_bot:profit_vault';
  let state = { ...localProfitVault };

  const r = await redisCmd('GET', key);
  if (r.source === 'UPSTASH_REDIS_VERIFIED' && r.result) {
    try {
      const p = JSON.parse(r.result);
      if (Number(p.baseCapital) > 0) state.baseCapital = Number(p.baseCapital);
      if (Number(p.lockedUsdt) >= 0) state.lockedUsdt = Number(p.lockedUsdt);
    } catch (e) {}
  }

  if (envBase > 0) {
    state.baseCapital = envBase;
  } else if (state.baseCapital <= 0) {
    state.baseCapital = +eq.toFixed(2);
  }

  let changed = false;
  if (state.baseCapital > 0 && eq >= state.baseCapital * 1.20) {
    const candidateLock = +((eq - state.baseCapital) * 0.50).toFixed(2);
    if (candidateLock > state.lockedUsdt) {
      state.lockedUsdt = candidateLock;
      changed = true;
    }
  }
  if (changed || localProfitVault.baseCapital <= 0) {
    localProfitVault = state;
    await redisCmd('SET', key, JSON.stringify(state));
  }

  const locked = Math.min(state.lockedUsdt, Math.max(0, +(eq - state.baseCapital).toFixed(2)));
  return {
    active: locked > 0,
    baseCapital: +state.baseCapital.toFixed(2),
    lockedUsdt: +locked.toFixed(2),
    tradableEquity: +Math.max(0, eq - locked).toFixed(2)
  };
}

module.exports = {
  tripCircuitBreaker,
  getCircuitBreaker,
  recordSlippage,
  getSlippageStats,
  markPositionPyramided,
  markPositionTrailTightened,
  markPositionTpExtended,
  getProfitVaultState,
  hasLossPostMortemSent,
  markLossPostMortemSent,
  getBotFilters,
  setBotFilters,
  shouldSendDailyReport,
  markDailyReportSent,
  markPositionTpStage,
  getAutoWalletAlloc,
  setAutoWalletAlloc,
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
  isAuthBlocked,
  recordAuthFailure,
  getTradingHalted,
  setTradingHalted,
  appendJournalEntry,
  getJournalEntries,
  getSystemHealth,
  sanitizeErrorForClient
};
