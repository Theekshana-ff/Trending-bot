// lib/securityAndState.js — Drop-in State Store (Upstash Redis / Vercel KV / Memory Fallback) & Auth Guard

const memoryStore = new Map();

export class StateStore {
  constructor() {
    this.url = (
      process.env.UPSTASH_REDIS_REST_URL ||
      process.env.KV_REST_API_URL ||
      ''
    ).replace(/\/$/, '');
    this.token =
      process.env.UPSTASH_REDIS_REST_TOKEN ||
      process.env.KV_REST_API_TOKEN ||
      '';
    this.useRedis = Boolean(this.url && this.token);
  }

  async _cmd(...args) {
    if (!this.useRedis) return this._memCmd(args);
    const res = await fetch(this.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(args),
    });
    const data = await res.json();
    if (data.error) throw new Error(`Redis error: ${data.error}`);
    return data.result;
  }

  _memCmd(args) {
    const [cmd, key, val, opt, ttl] = args;
    const now = Date.now();
    const readEntry = (k) => {
      const e = memoryStore.get(k);
      if (!e) return null;
      if (e.exp && e.exp < now) {
        memoryStore.delete(k);
        return null;
      }
      return e.val;
    };

    switch (cmd) {
      case 'GET':
        return readEntry(key);
      case 'SET': {
        const exp = opt === 'EX' && ttl ? now + Number(ttl) * 1000 : null;
        memoryStore.set(key, { val: String(val), exp });
        return 'OK';
      }
      case 'DEL':
        memoryStore.delete(key);
        return 1;
      case 'INCRBY': {
        const cur = Number(readEntry(key) || 0) + Number(val);
        memoryStore.set(key, { val: String(cur), exp: null });
        return cur;
      }
      case 'INCRBYFLOAT': {
        const cur = Number(readEntry(key) || 0) + Number(val);
        memoryStore.set(key, { val: String(cur), exp: null });
        return cur;
      }
      case 'SADD': {
        const set = readEntry(key) instanceof Set ? readEntry(key) : new Set();
        set.add(String(val));
        memoryStore.set(key, { val: set, exp: null });
        return 1;
      }
      case 'SMEMBERS': {
        const set = readEntry(key);
        return set instanceof Set ? Array.from(set) : [];
      }
      case 'RPUSH': {
        const arr = Array.isArray(readEntry(key)) ? readEntry(key) : [];
        arr.push(String(val));
        memoryStore.set(key, { val: arr, exp: null });
        return arr.length;
      }
      case 'LTRIM': {
        const arr = Array.isArray(readEntry(key)) ? readEntry(key) : [];
        const start = Number(val);
        const sliced = start < 0 ? arr.slice(start) : arr.slice(start, Number(opt) + 1);
        memoryStore.set(key, { val: sliced, exp: null });
        return 'OK';
      }
      case 'LRANGE': {
        const arr = Array.isArray(readEntry(key)) ? readEntry(key) : [];
        return arr;
      }
      default:
        return null;
    }
  }

  get(key) { return this._cmd('GET', key); }
  set(key, val, exSeconds) {
    return exSeconds
      ? this._cmd('SET', key, String(val), 'EX', String(exSeconds))
      : this._cmd('SET', key, String(val));
  }
  async getJson(key) {
    const raw = await this.get(key);
    if (!raw) return null;
    try { return typeof raw === 'string' ? JSON.parse(raw) : raw; }
    catch { return null; }
  }
  setJson(key, obj, exSeconds) {
    return this.set(key, JSON.stringify(obj), exSeconds);
  }
  del(key) { return this._cmd('DEL', key); }
  incrby(key, n) { return this._cmd('INCRBY', key, String(n)); }
  incrbyfloat(key, n) { return this._cmd('INCRBYFLOAT', key, String(n)); }
  sadd(key, member) { return this._cmd('SADD', key, String(member)); }
  smembers(key) { return this._cmd('SMEMBERS', key); }
  rpush(key, val) { return this._cmd('RPUSH', key, String(val)); }
  ltrim(key, start, stop) { return this._cmd('LTRIM', key, String(start), String(stop)); }
  lrange(key, start, stop) { return this._cmd('LRANGE', key, String(start), String(stop)); }
}

export function isAuthorizedRequest(req, body = {}) {
  const cronSecret = process.env.CRON_SECRET || '';
  const adminPw =
    process.env.ADMIN_PASSWORD ||
    process.env.DASHBOARD_PASSWORD ||
    process.env.BOT_PASSWORD ||
    '';

  const headerCron = req.headers?.['x-cron-secret'] || req.query?.cron_secret || '';
  const headerPw =
    req.headers?.['x-admin-password'] ||
    req.headers?.['x-dashboard-password'] ||
    body?.password ||
    '';

  if (cronSecret && headerCron === cronSecret) return true;
  if (adminPw && headerPw === adminPw) return true;
  if (!cronSecret && !adminPw) return true;
  return false;
}

export function clamp(val, min, max) {
  if (Number.isNaN(val)) return min;
  return Math.min(max, Math.max(min, val));
}

export async function loadRuntimeConfig(store) {
  const saved = (await store.getJson('v18:settings')) || {};

  const coins = (process.env.SV_COINS || 'SOL,XRP,DOGE,SUI,AVAX,LINK')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
    .map((s) => (s.endsWith('USDT') ? s : `${s}USDT`));

  const tradeMode =
    String(saved.tradeMode || process.env.TRADE_MODE || 'FAST').toUpperCase() === 'SAFE'
      ? 'SAFE'
      : 'FAST';

  const marginUsdt = clamp(
    Number(saved.marginUsdt ?? process.env.MARGIN_USDT ?? process.env.SV_MARGIN_USDT ?? 2.0),
    1.0,
    500
  );

  const maxLev = tradeMode === 'FAST' ? 18 : 10;
  const defaultLev = tradeMode === 'FAST' ? 12 : 5;
  const leverage = clamp(
    Math.round(Number(saved.leverage ?? process.env.LEVERAGE ?? process.env.SV_LEVERAGE ?? defaultLev)),
    2,
    maxLev
  );

  const targetNetUsdt = clamp(
    Number(
      saved.targetNetUsdt ??
      process.env.TARGET_NET_PROFIT_USDT ??
      process.env.SV_PROFIT_TARGET_USDT ??
      0.10
    ),
    0.05,
    50
  );

  const maxLossPerTradeUsdt = clamp(
    Number(saved.maxLossPerTradeUsdt ?? process.env.MAX_LOSS_PER_TRADE_USDT ?? 0.14),
    0.06,
    50
  );

  const maxDailyLossUsdt = clamp(
    Number(saved.maxDailyLossUsdt ?? process.env.MAX_DAILY_LOSS_USDT ?? 0.50),
    0.15,
    100
  );

  // Respects old SV_MODE env var and Redis toggle
  const svEnvEnabled =
    String(process.env.SV_MODE ?? process.env.BOT_ENABLED ?? 'true').toLowerCase() !== 'false';
  const savedSvMode = await store.get('v18:sv_mode');
  const svModeOn = savedSvMode === null ? svEnvEnabled : savedSvMode === '1';

  const pausedFlag = (await store.get('v18:paused')) === '1';

  return {
    // Compatible with existing live keys unless BYBIT_TESTNET=true is explicitly set
    testnet: String(process.env.BYBIT_TESTNET || 'false').toLowerCase() === 'true',
    svModeOn,
    paused: pausedFlag || !svModeOn,
    tradeMode,
    coins,
    marginUsdt,
    leverage,
    targetNetUsdt,
    maxLossPerTradeUsdt,
    stopLossPct: Number(process.env.STOP_LOSS_PCT || 0.65),
    takeProfitPct: Number(process.env.TAKE_PROFIT_PCT || 1.25),
    minNetRR: Number(process.env.MIN_RR_RATIO || 1.5),
    maxDailyLossUsdt,
    maxConsecutiveLosses: Number(process.env.MAX_CONSECUTIVE_LOSSES || 2),
    cooldownMinutes:
      tradeMode === 'FAST'
        ? Number(process.env.COOLDOWN_MINUTES_FAST || 3)
        : Number(process.env.COOLDOWN_MINUTES_SAFE || 15),
    maxSpreadPct: Number(process.env.MAX_SPREAD_PCT || 0.05),
  };
}
