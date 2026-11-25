// File: lib/modules/svScalpEngine.js (v16.0 — SV ULTRA PRO EDITION)
// Standalone 1m/3m Micro-Scalping Engine: $2 Margin x 18x Leverage -> $0.10 Net Cut (Default Pro Preset)
// Includes All 40 Base SV Updates + All 10 Ultra Pro v16.0 Upgrades.

const { fetchBybitPublicJson, getBybitMarketData, fetchOrderBookImbalance } = require('./marketData');
const { calcEMA, calcRSI, calcWilderATR } = require('./indicators');
const { formatBybitPrice, formatBybitQty } = require('./riskAndValidation');
const {
  bybitV5Req, fetchBybitWalletAndPositions, configureIsolatedAndLeverage, closeVerifiedLivePosition
} = require('./bybitLiveClient');
const { redisCmd, appendJournalEntry, getBotFilters } = require('./securityAndState');
const { sendTelegramAlert } = require('./telegramNotifier');

const DEFAULT_SV_COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE'];

// Ultra Pro #3: Power Presets (Safe / Pro / Turbo)
const SV_PRESETS = {
  safe: {
    key: 'safe',
    label: '🐢 Safe ($1.5 / 10x)',
    baseMarginUsdt: 1.5,
    minLev: 6,
    maxLev: 10,
    recoveryLev: 6,
    targetUsdt: 0.10,
    maxSlUsdt: 0.25,
    maxSlPct: 0.010
  },
  pro: {
    key: 'pro',
    label: '⚡ Pro ($2 / 18x)',
    baseMarginUsdt: 2.0,
    minLev: 12,
    maxLev: 18,
    recoveryLev: 10,
    targetUsdt: 0.10,
    maxSlUsdt: 0.35,
    maxSlPct: 0.011
  },
  turbo: {
    key: 'turbo',
    label: '🔥 Turbo ($3 / 20x)',
    baseMarginUsdt: 3.0,
    minLev: 14,
    maxLev: 20,
    recoveryLev: 10,
    targetUsdt: 0.12,
    maxSlUsdt: 0.45,
    maxSlPct: 0.012
  }
};

function getSvPresetConfig(botFilters = null) {
  const envPreset = String(process.env.SV_PRESET || '').trim().toLowerCase();
  const key = SV_PRESETS[envPreset]
    ? envPreset
    : (botFilters && SV_PRESETS[String(botFilters.svPreset || '').toLowerCase()]
        ? String(botFilters.svPreset).toLowerCase()
        : 'pro');
  return SV_PRESETS[key];
}

function getSvCoins() {
  const raw = String(process.env.SV_COINS || '').trim();
  if (!raw) return DEFAULT_SV_COINS;
  const list = raw.split(',').map(s => s.trim().toUpperCase().replace(/USDT$/, '')).filter(Boolean);
  return list.length ? list : DEFAULT_SV_COINS;
}

function isSvModeActive(botFilters = null) {
  const envVal = String(process.env.SV_MODE || '').trim().toLowerCase();
  if (envVal === 'true') return true;
  if (envVal === 'false') return false;
  if (botFilters && typeof botFilters.svMode === 'boolean') return botFilters.svMode;
  return true;
}

function isSvPaperMode() {
  return String(process.env.SV_PAPER_MODE || '').trim().toLowerCase() === 'true';
}

function isMakerFirstEnabled() {
  const raw = String(process.env.SV_MAKER_ENTRY || 'true').trim().toLowerCase();
  return raw !== 'false';
}

function getUtcDay() {
  return new Date().toISOString().slice(0, 10);
}

function getUtcHourKey() {
  return new Date().toISOString().slice(0, 13);
}

async function fetchSvKlines(coin, interval = '1', limit = 50) {
  const sym = `${String(coin).toUpperCase().replace(/USDT$/, '')}USDT`;
  const j = await fetchBybitPublicJson(
    `/v5/market/kline?category=linear&symbol=${sym}&interval=${interval}&limit=${limit}`,
    2500
  );
  return (j?.result?.list || []).slice(1).reverse().map(k => [
    Number(k[0]), Number(k[1]), Number(k[2]), Number(k[3]), Number(k[4]), Number(k[5] || 0)
  ]);
}

function computeHeikinAshi(candles) {
  const ha = [];
  for (let i = 0; i < candles.length; i++) {
    const [ts, o, h, l, c] = candles[i];
    const haClose = (o + h + l + c) / 4;
    const haOpen = i === 0 ? (o + c) / 2 : (ha[i - 1].open + ha[i - 1].close) / 2;
    ha.push({ ts, open: haOpen, high: Math.max(h, haOpen, haClose), low: Math.min(l, haOpen, haClose), close: haClose, bullish: haClose > haOpen });
  }
  return ha;
}

function calcMicroVwap(candles, lookback = 30) {
  const slice = candles.slice(-Math.min(candles.length, lookback));
  let pv = 0;
  let vol = 0;
  for (const c of slice) {
    const tp = (c[2] + c[3] + c[4]) / 3;
    const v = Math.max(0, c[5] || 0);
    pv += tp * v;
    vol += v;
  }
  return vol > 0 ? pv / vol : (slice[slice.length - 1]?.[4] || 0);
}

function calcFastStochRsi(closes, rsiPeriod = 7, stochPeriod = 7) {
  if (closes.length < rsiPeriod + stochPeriod + 2) return { rsi7: 50, stochK: 50 };
  const rsiSeries = [];
  for (let i = rsiPeriod + 1; i <= closes.length; i++) {
    rsiSeries.push(calcRSI(closes.slice(0, i), rsiPeriod));
  }
  const latestRsi = rsiSeries[rsiSeries.length - 1];
  const recent = rsiSeries.slice(-stochPeriod);
  const lo = Math.min(...recent);
  const hi = Math.max(...recent);
  const stochK = hi > lo ? ((latestRsi - lo) / (hi - lo)) * 100 : 50;
  return { rsi7: +latestRsi.toFixed(1), stochK: +stochK.toFixed(1) };
}

function detectBollingerBounce(candles, period = 20) {
  if (candles.length < period + 2) return { bounce: 'NONE' };
  const closes = candles.slice(-period).map(c => c[4]);
  const mean = closes.reduce((a, b) => a + b, 0) / period;
  const std = Math.sqrt(closes.reduce((a, v) => a + Math.pow(v - mean, 2), 0) / period);
  const upper = mean + 2 * std;
  const lower = mean - 2 * std;
  const prev = candles[candles.length - 2];
  const last = candles[candles.length - 1];
  if (prev[3] < lower && last[4] > lower && last[4] > last[1]) return { bounce: 'LONG', lower, upper };
  if (prev[2] > upper && last[4] < upper && last[4] < last[1]) return { bounce: 'SHORT', lower, upper };
  return { bounce: 'NONE', lower, upper };
}

function detectMicroFvgTap(candles, direction) {
  if (candles.length < 6) return false;
  const last = candles[candles.length - 1];
  for (let i = candles.length - 2; i >= Math.max(2, candles.length - 7); i--) {
    const prev2 = candles[i - 2];
    const curr = candles[i];
    if (direction === 'LONG' && curr[3] > prev2[2] && last[3] <= curr[3] && last[4] >= prev2[2]) return true;
    if (direction === 'SHORT' && curr[2] < prev2[3] && last[2] >= curr[2] && last[4] <= prev2[3]) return true;
  }
  return false;
}

function hasExhaustionWick(candle, direction) {
  const [, o, h, l, c] = candle;
  const body = Math.max(1e-8, Math.abs(c - o));
  const upperWick = h - Math.max(o, c);
  const lowerWick = Math.min(o, c) - l;
  if (direction === 'LONG' && upperWick >= body * 2.0) return true;
  if (direction === 'SHORT' && lowerWick >= body * 2.0) return true;
  return false;
}

function isFundingBlackout(nowMs = Date.now()) {
  const d = new Date(nowMs);
  const minsSinceDay = d.getUTCHours() * 60 + d.getUTCMinutes();
  return (480 - (minsSinceDay % 480)) <= 5;
}

function isSvSessionAllowed(nowMs = Date.now()) {
  if (String(process.env.SV_SESSION_ONLY || '').trim().toLowerCase() !== 'true') return true;
  const h = new Date(nowMs).getUTCHours();
  return h >= 7 && h < 21;
}

// Target Profit Calculation (respects SV_PROFIT_TARGET_USDT or Preset default $0.10 + volatility boost)
function computeSvTargetUsdt(availBal, atrPct = 0.12, preset = SV_PRESETS.pro) {
  const explicit = Number(process.env.SV_PROFIT_TARGET_USDT || 0);
  let base = explicit > 0 ? explicit : preset.targetUsdt;

  if (explicit <= 0 && availBal >= 60) {
    if (availBal >= 200) base = Math.max(base, 0.35);
    else if (availBal >= 100) base = Math.max(base, 0.20);
    else base = Math.max(base, 0.15);
  }
  const volMult = atrPct >= 0.30 ? 1.35 : (atrPct >= 0.20 ? 1.15 : 1.0);
  return +(base * volMult).toFixed(3);
}

// Ultra Pro #1 (12x-18x Ladder), #6 (Smart Recovery Leverage), #7 (Auto-Compounding Margin)
function computeSvAutoSizing({ availBal, entryPrice, atrPct, spec, targetUsdt, preset = SV_PRESETS.pro, inRecoveryMode = false }) {
  const envLev = Number(process.env.SV_LEVERAGE || 0);
  const envMargin = Number(process.env.SV_MARGIN_USDT || 0);
  const maxLevSpec = Math.min(25, Number(spec.maxLeverage || 20));

  // #1 High-Speed Auto-Leverage Ladder + #6 Smart Recovery Leverage
  let leverage;
  if (envLev > 0) {
    leverage = Math.round(envLev);
  } else if (inRecoveryMode) {
    leverage = preset.recoveryLev;
  } else {
    if (atrPct > 0.32) leverage = preset.minLev;
    else if (atrPct > 0.22) leverage = Math.round((preset.minLev + preset.maxLev) / 2);
    else leverage = preset.maxLev;
  }
  leverage = Math.min(maxLevSpec, Math.max(3, leverage));

  // #7 Auto-Compounding SV Margin (Base $2 on Pro; scales up as balance grows, resets on recovery)
  let baseMargin = envMargin > 0 ? envMargin : preset.baseMarginUsdt;
  if (envMargin <= 0 && !inRecoveryMode) {
    if (availBal >= 40) baseMargin = Math.max(baseMargin, +(availBal * 0.10).toFixed(2));
    else if (availBal >= 30) baseMargin = Math.max(baseMargin, +(preset.baseMarginUsdt * 1.5).toFixed(2));
    else if (availBal >= 20) baseMargin = Math.max(baseMargin, +(preset.baseMarginUsdt * 1.25).toFixed(2));
  }

  const minNotional = Math.max(5.2, Number(spec.minNotionalValue || 5));
  const minMarginNeeded = (minNotional / leverage) * 1.05;
  let marginUsdt = Math.max(minMarginNeeded, baseMargin);
  marginUsdt = Math.min(availBal * 0.85, marginUsdt);

  if (marginUsdt < minMarginNeeded * 0.95) {
    return { ok: false, reason: `Insufficient balance ($${availBal.toFixed(2)}) for min margin ($${minMarginNeeded.toFixed(2)})` };
  }

  const notional = marginUsdt * leverage;
  const rawQty = entryPrice > 0 ? notional / entryPrice : 0;
  const qty = formatBybitQty(rawQty, spec.qtyStep);

  if (!Number.isFinite(qty) || qty < Number(spec.minOrderQty || 0.001)) {
    return { ok: false, reason: `SV qty (${qty}) < minOrderQty (${spec.minOrderQty})` };
  }
  const actualNotional = qty * entryPrice;
  if (actualNotional < Number(spec.minNotionalValue || 5)) {
    return { ok: false, reason: `SV notional ($${actualNotional.toFixed(2)}) < Bybit min ($${spec.minNotionalValue})` };
  }

  // #2 Smart Maker-First Fee Estimation & Fee-Ratio Guard (55% Taker / 40% Maker)
  const makerFirst = isMakerFirstEnabled();
  const estFeeRate = makerFirst ? 0.00055 : 0.0011;
  const estFeeUsdt = +(actualNotional * estFeeRate).toFixed(4);
  const feeCapRatio = makerFirst ? 0.45 : 0.55;
  if (estFeeUsdt > targetUsdt * feeCapRatio) {
    return { ok: false, reason: `SV Fee-Ratio Guard: est fee ($${estFeeUsdt}) > ${(feeCapRatio * 100).toFixed(0)}% of target ($${targetUsdt})` };
  }

  return {
    ok: true,
    leverage,
    inRecoveryMode,
    marginUsdt: +(actualNotional / leverage).toFixed(2),
    notional: +actualNotional.toFixed(2),
    qty,
    estFeeUsdt,
    grossTargetUsdt: +(targetUsdt + estFeeUsdt).toFixed(4)
  };
}

// ============================================================
// REDIS STATE & ANALYTICS (Ultra Pro #6, #9)
// ============================================================
async function getSvDailyStats() {
  const key = `bybit_bot:sv_stats:${getUtcDay()}`;
  const r = await redisCmd('GET', key);
  if (r.ok && r.result) {
    try {
      const p = JSON.parse(r.result);
      return {
        trades: 0, wins: 0, losses: 0,
        grossPnl: 0, totalFees: 0, netPnl: 0,
        cuts: 0, consecutiveLosses: 0, lastWasLoss: false,
        coinStats: {},
        ...p
      };
    } catch (e) {}
  }
  return {
    trades: 0, wins: 0, losses: 0,
    grossPnl: 0, totalFees: 0, netPnl: 0,
    cuts: 0, consecutiveLosses: 0, lastWasLoss: false,
    coinStats: {}
  };
}

async function recordSvTradeResult(symbol, grossPnlUsdt, feeUsdt = 0, isProfitCut = false) {
  const key = `bybit_bot:sv_stats:${getUtcDay()}`;
  const stats = await getSvDailyStats();
  const gross = Number(grossPnlUsdt || 0);
  const fee = Math.abs(Number(feeUsdt || 0));
  const net = +(gross - fee).toFixed(4);

  stats.trades += 1;
  stats.grossPnl = +(Number(stats.grossPnl || 0) + gross).toFixed(4);
  stats.totalFees = +(Number(stats.totalFees || 0) + fee).toFixed(4);
  stats.netPnl = +(Number(stats.netPnl || 0) + net).toFixed(4);

  if (net >= 0) {
    stats.wins += 1;
    stats.consecutiveLosses = 0;
    stats.lastWasLoss = false; // #6 Exit Recovery Leverage on win
    if (isProfitCut) stats.cuts += 1;
  } else {
    stats.losses += 1;
    stats.consecutiveLosses = (stats.consecutiveLosses || 0) + 1;
    stats.lastWasLoss = true; // #6 Trigger Smart Recovery Leverage (10x) for next trade
    await redisCmd('SET', `bybit_bot:sv_cd:${symbol}`, '1', 'EX', '300');
    if (stats.consecutiveLosses >= 3) {
      const until = Date.now() + 30 * 60 * 1000;
      await redisCmd('SET', 'bybit_bot:sv_pause_until', String(until), 'EX', '1800');
      await sendTelegramAlert(`🛑 <b>SV ULTRA PRO LOSS BRAKE (30m)</b>\n3 consecutive losses detected. Pausing SV Engine for 30 minutes.`);
    }
  }

  const cs = stats.coinStats[symbol] || { trades: 0, wins: 0, netPnl: 0 };
  cs.trades += 1;
  if (net >= 0) cs.wins += 1;
  cs.netPnl = +(cs.netPnl + net).toFixed(4);
  stats.coinStats[symbol] = cs;

  await redisCmd('SET', key, JSON.stringify(stats), 'EX', '172800');
  return stats;
}

async function isSvPaused() {
  const r = await redisCmd('GET', 'bybit_bot:sv_pause_until');
  if (r.ok && r.result && Number(r.result) > Date.now()) {
    return { paused: true, minsLeft: Math.ceil((Number(r.result) - Date.now()) / 60000) };
  }
  return { paused: false, minsLeft: 0 };
}

async function isCoinOnCooldown(symbol) {
  const r = await redisCmd('GET', `bybit_bot:sv_cd:${symbol}`);
  return Boolean(r.ok && r.result === '1');
}

async function getHourlyTradeCount() {
  const r = await redisCmd('GET', `bybit_bot:sv_hr:${getUtcHourKey()}`);
  return Number(r.ok && r.result ? r.result : 0);
}

async function incrementHourlyTradeCount() {
  const key = `bybit_bot:sv_hr:${getUtcHourKey()}`;
  const n = (await getHourlyTradeCount()) + 1;
  await redisCmd('SET', key, String(n), 'EX', '7200');
  return n;
}

async function saveSvPositionMeta(symbol, meta) {
  await redisCmd('SET', `bybit_bot:sv_pos:${symbol}`, JSON.stringify({ openedAt: Date.now(), ...meta }), 'EX', '86400');
}

async function getSvPositionMeta(symbol) {
  const r = await redisCmd('GET', `bybit_bot:sv_pos:${symbol}`);
  if (r.ok && r.result) {
    try { return JSON.parse(r.result); } catch (e) {}
  }
  return null;
}

// Ultra Pro #9: Daily Gross vs Fees vs Net Report (sent at 23:00+ UTC once per day)
async function maybeSendDailyGrossFeeNetReport(stats) {
  if (!stats || stats.trades === 0) return;
  if (new Date().getUTCHours() < 23) return;
  const key = `bybit_bot:sv_daily_rep:${getUtcDay()}`;
  const r = await redisCmd('GET', key);
  if (r.ok && r.result === '1') return;
  await redisCmd('SET', key, '1', 'EX', '172800');

  const wr = stats.trades ? ((stats.wins / stats.trades) * 100).toFixed(1) : '0.0';
  await sendTelegramAlert(
    `📊 <b>SV ULTRA PRO — DAILY GROSS vs FEES vs NET</b>\n` +
    `Trades: <b>${stats.trades}</b> (${stats.wins}W / ${stats.losses}L · WR ${wr}%)\n` +
    `Profit Cuts: <b>${stats.cuts}</b>\n` +
    `💵 Gross PnL: <b>${stats.grossPnl >= 0 ? '+' : ''}$${Number(stats.grossPnl || 0).toFixed(3)}</b>\n` +
    `🧾 Est. Fees: <b>-$${Number(stats.totalFees || 0).toFixed(3)}</b>\n` +
    `✅ <b>Net PnL: ${stats.netPnl >= 0 ? '+' : ''}$${Number(stats.netPnl || 0).toFixed(3)}</b>`
  );
}

// ============================================================
// CORE SV SIGNAL EVALUATOR + HEATMAP (Ultra Pro #8 & #10)
// ============================================================
async function evaluateSvCandidate({ coin, ticker, spec, btc1mMovePct, coinStats = {}, forHeatmap = false }) {
  const symbol = `${coin}USDT`;
  const maxSpread = Number(process.env.SV_MAX_SPREAD_PCT || 0.03);
  const spreadPct = ticker.bid1 > 0 ? ((ticker.ask1 - ticker.bid1) / ticker.bid1) * 100 : 0.05;

  const [c1m, c3m, obiRaw, onCd] = await Promise.all([
    fetchSvKlines(coin, '1', 45).catch(() => []),
    fetchSvKlines(coin, '3', 32).catch(() => []),
    fetchOrderBookImbalance(symbol, 5).catch(() => ({ ok: false, obi: 0 })),
    isCoinOnCooldown(symbol).catch(() => false)
  ]);

  if (c1m.length < 25 || c3m.length < 22) {
    return forHeatmap ? { coin, symbol, price: ticker.lastPrice, spreadPct: +spreadPct.toFixed(4), direction: 'WAIT', score: 0, status: 'NO_DATA' } : null;
  }

  const closes1m = c1m.map(c => c[4]);
  const highs1m = c1m.map(c => c[2]);
  const lows1m = c1m.map(c => c[3]);
  const vols1m = c1m.map(c => c[5]);
  const closes3m = c3m.map(c => c[4]);

  const last = c1m[c1m.length - 1];
  const price = ticker.lastPrice || last[4];

  const avgVol20 = vols1m.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  const volRatio = avgVol20 > 0 ? last[5] / avgVol20 : 1;
  const range5 = (Math.max(...highs1m.slice(-5)) - Math.min(...lows1m.slice(-5))) / Math.max(1e-8, price) * 100;

  const ema9_1m = calcEMA(closes1m, 9);
  const ema21_1m = calcEMA(closes1m, 21);
  const ema9_3m = calcEMA(closes3m, 9);
  const ema21_3m = calcEMA(closes3m, 21);
  const vwap = calcMicroVwap(c1m, 30);
  const { rsi7, stochK } = calcFastStochRsi(closes1m, 7, 7);
  const ha = computeHeikinAshi(c1m);
  const haLast = ha[ha.length - 1];
  const haPrev = ha[ha.length - 2];
  const bb = detectBollingerBounce(c1m, 20);
  const obi = Number(obiRaw?.obi || 0);

  let direction = null;
  let score = 0;
  const reasons = [];

  const bullTrend = ema9_1m > ema21_1m && price >= vwap * 0.9995;
  const bearTrend = ema9_1m < ema21_1m && price <= vwap * 1.0005;

  if (bullTrend || bb.bounce === 'LONG') {
    direction = 'LONG';
    if (ema9_1m > ema21_1m) { score += 22; reasons.push('1m EMA9>21'); }
    if (ema9_3m > ema21_3m) { score += 16; reasons.push('3m Bull'); }
    if (price > vwap) { score += 14; reasons.push('Above VWAP'); }
    if (haLast.bullish && haPrev.bullish) { score += 12; reasons.push('HA Bull'); }
    if (rsi7 >= 42 && rsi7 <= 68) { score += 10; reasons.push(`RSI7 ${rsi7}`); }
    if (stochK <= 45) { score += 8; reasons.push('Pullback'); }
    if (bb.bounce === 'LONG') { score += 12; reasons.push('BB Bounce'); }
  } else if (bearTrend || bb.bounce === 'SHORT') {
    direction = 'SHORT';
    if (ema9_1m < ema21_1m) { score += 22; reasons.push('1m EMA9<21'); }
    if (ema9_3m < ema21_3m) { score += 16; reasons.push('3m Bear'); }
    if (price < vwap) { score += 14; reasons.push('Below VWAP'); }
    if (!haLast.bullish && !haPrev.bullish) { score += 12; reasons.push('HA Bear'); }
    if (rsi7 >= 32 && rsi7 <= 58) { score += 10; reasons.push(`RSI7 ${rsi7}`); }
    if (stochK >= 55) { score += 8; reasons.push('Pullback'); }
    if (bb.bounce === 'SHORT') { score += 12; reasons.push('BB Bounce'); }
  }

  if (direction) {
    if ((direction === 'LONG' && obi >= 0.20) || (direction === 'SHORT' && obi <= -0.20)) {
      score += 10;
      reasons.push(`OBI ${(obi * 100).toFixed(0)}%`);
    }
    if (volRatio >= 1.8) { score += 10; reasons.push(`Vol ${volRatio.toFixed(1)}x`); }
    if (detectMicroFvgTap(c1m, direction)) { score += 8; reasons.push('1m FVG'); }
    const cs = coinStats[symbol];
    if (cs && cs.trades >= 2 && (cs.wins / cs.trades) >= 0.65 && cs.netPnl > 0) {
      score += 6;
      reasons.push('Top Coin');
    }
  }

  // Hard Safety Filters
  let blockReason = null;
  const cs = coinStats[symbol];
  if (spreadPct > maxSpread) blockReason = `SPREAD ${spreadPct.toFixed(3)}%`;
  else if (onCd) blockReason = 'COOLDOWN';
  else if (cs && cs.trades >= 4 && (cs.wins / cs.trades) < 0.25 && cs.netPnl < 0) blockReason = 'MUTED';
  else if (range5 < 0.04 || volRatio < 0.35) blockReason = 'DEAD_MKT';
  else if (!direction) blockReason = 'NEUTRAL';
  else if (coin !== 'BTC' && ((direction === 'LONG' && btc1mMovePct <= -0.25) || (direction === 'SHORT' && btc1mMovePct >= 0.25))) blockReason = 'BTC_SYNC';
  else if (hasExhaustionWick(last, direction)) blockReason = 'WICK_EXH';
  else if ((direction === 'LONG' && obi < -0.40) || (direction === 'SHORT' && obi > 0.40)) blockReason = 'OBI_WALL';

  const atr = calcWilderATR(highs1m, lows1m, closes1m, 14) || (price * 0.0015);
  const atrPct = (atr / Math.max(1e-8, price)) * 100;
  const finalScore = Math.min(100, score);

  if (blockReason && !forHeatmap) return null;

  return {
    coin,
    symbol,
    direction: direction || 'WAIT',
    price,
    bid1: ticker.bid1,
    ask1: ticker.ask1,
    spreadPct: +spreadPct.toFixed(4),
    atr,
    atrPct: +atrPct.toFixed(4),
    rsi7,
    obiPct: +(obi * 100).toFixed(0),
    volRatio: +volRatio.toFixed(2),
    score: finalScore,
    status: blockReason || (finalScore >= Number(process.env.SV_MIN_SCORE || 62) ? 'READY' : 'LOW_SCORE'),
    reasons,
    spec
  };
}

// Ultra Pro #8: Live SV Coin Heatmap (Dashboard)
async function getSvHeatmap() {
  const [mkt, btc1m, stats] = await Promise.all([
    getBybitMarketData(),
    fetchSvKlines('BTC', '1', 3).catch(() => []),
    getSvDailyStats()
  ]);
  let btc1mMovePct = 0;
  if (btc1m.length >= 1) {
    const bLast = btc1m[btc1m.length - 1];
    btc1mMovePct = bLast[1] > 0 ? ((bLast[4] - bLast[1]) / bLast[1]) * 100 : 0;
  }
  const coins = getSvCoins();
  const rows = (await Promise.all(
    coins.map(coin => {
      const sym = `${coin}USDT`;
      if (!mkt.tickers[sym] || !mkt.instMap[sym]) return null;
      return evaluateSvCandidate({
        coin, ticker: mkt.tickers[sym], spec: mkt.instMap[sym],
        btc1mMovePct, coinStats: stats.coinStats, forHeatmap: true
      });
    })
  )).filter(Boolean).sort((a, b) => b.score - a.score);

  return { btc1mMovePct: +btc1mMovePct.toFixed(3), rows };
}

// Ultra Pro #2: Smart Maker-First Order Placement with Instant Market Fallback
async function placeSmartSvOrder({ symbol, side, qty, bid1, ask1, tickSize, slPrice, tpPrice }) {
  const makerFirst = isMakerFirstEnabled();
  if (makerFirst && bid1 > 0 && ask1 > 0) {
    const limitPx = formatBybitPrice(side === 'Buy' ? bid1 : ask1, tickSize);
    try {
      const makerRes = await bybitV5Req('POST', '/v5/order/create', {
        category: 'linear',
        symbol,
        side,
        orderType: 'Limit',
        price: String(limitPx),
        qty: String(qty),
        timeInForce: 'PostOnly',
        stopLoss: String(slPrice),
        takeProfit: String(tpPrice),
        positionIdx: 0
      });
      if (makerRes?.orderId) {
        return { orderId: makerRes.orderId, orderType: 'PostOnly_Maker', execPrice: limitPx };
      }
    } catch (e) {
      // Fallback immediately to Market IOC if PostOnly crosses spread or is rejected
    }
  }

  const mktRes = await bybitV5Req('POST', '/v5/order/create', {
    category: 'linear',
    symbol,
    side,
    orderType: 'Market',
    qty: String(qty),
    timeInForce: 'IOC',
    stopLoss: String(slPrice),
    takeProfit: String(tpPrice),
    positionIdx: 0
  });
  return { orderId: mktRes?.orderId || null, orderType: 'Market_IOC', execPrice: side === 'Buy' ? ask1 : bid1 };
}

// ============================================================
// MAIN STANDALONE SV ULTRA PRO CYCLE
// ============================================================
async function runSvCycle({ halted = false, autoExecute = false, liveAuthorized = false } = {}) {
  // Ultra Pro #10: Parallelize initial market, BTC pulse, wallet, filters & stats
  const [mkt, btc1m, acct, filters, stats] = await Promise.all([
    getBybitMarketData(),
    fetchSvKlines('BTC', '1', 3).catch(() => []),
    fetchBybitWalletAndPositions(),
    getBotFilters().catch(() => ({})),
    getSvDailyStats()
  ]);

  const preset = getSvPresetConfig(filters);
  let btc1mMovePct = 0;
  if (btc1m.length >= 1) {
    const bLast = btc1m[btc1m.length - 1];
    btc1mMovePct = bLast[1] > 0 ? ((bLast[4] - bLast[1]) / bLast[1]) * 100 : 0;
  }

  const actions = [];
  let flipCandidateSymbol = null;

  // BTC Flash-Move Emergency Exit (>= 0.60% in 1m)
  if (Math.abs(btc1mMovePct) >= 0.60 && acct.positions.length > 0) {
    for (const pos of acct.positions) {
      if (pos.symbol === 'BTCUSDT') continue;
      const closeRes = await closeVerifiedLivePosition(pos.symbol).catch(() => ({ closed: false }));
      if (closeRes.closed) {
        const estFee = Number(pos.size || 0) * Number(pos.avgPrice || 0) * 0.0011;
        await recordSvTradeResult(pos.symbol, Number(pos.unrealisedPnl || 0), estFee, false);
        actions.push({ action: 'BTC_FLASH_EMERGENCY_EXIT', symbol: pos.symbol, btc1mMovePct: +btc1mMovePct.toFixed(2) });
        await sendTelegramAlert(`🚨 <b>SV BTC FLASH EXIT</b>\nBTC 1m moved ${btc1mMovePct.toFixed(2)}%. Closed <b>${pos.symbol}</b>.`);
      }
    }
    return { ok: true, mode: 'SV_ULTRA_PRO', preset: preset.key, halted, actions, stats, wallet: acct.wallet };
  }

  // Cancel stale unfilled PostOnly Maker orders older than 45 seconds
  for (const ord of (acct.openOrders || [])) {
    const ageSec = (Date.now() - Number(ord.createdTime || Date.now())) / 1000;
    if (ageSec >= 45) {
      await bybitV5Req('POST', '/v5/order/cancel', { category: 'linear', symbol: ord.symbol, orderId: ord.orderId }).catch(() => {});
      actions.push({ action: 'CANCELLED_STALE_MAKER', symbol: ord.symbol, ageSec: Math.round(ageSec) });
    }
  }

  // Manage existing positions (Net-of-Fee Cut, Step-Trailing Profit Lock #4, Fade Exit, Time-Stop)
  let cutHappened = false;
  const maxHoldMin = Number(process.env.SV_MAX_HOLD_MIN || 15);

  for (const pos of acct.positions) {
    const meta = await getSvPositionMeta(pos.symbol);
    const uPnl = Number(pos.unrealisedPnl || 0);
    const size = Number(pos.size || 0);
    const entry = Number(pos.avgPrice || 0);
    const mark = Number(pos.markPrice || entry);
    const isLong = pos.side === 'Buy';
    const spec = mkt.instMap[pos.symbol] || { tickSize: 0.0001, qtyStep: 0.01, minOrderQty: 0.01 };

    const targetUsdt = Number(meta?.targetUsdt || computeSvTargetUsdt(acct.wallet.availableBalance, 0.12, preset));
    const estFeeUsdt = Number(meta?.estFeeUsdt || (size * entry * 0.0011));
    const grossTarget = targetUsdt + estFeeUsdt;

    // 1. Instant Net-of-Fee Profit Cut
    if (uPnl >= grossTarget) {
      const cutRes = await closeVerifiedLivePosition(pos.symbol);
      if (cutRes.closed) {
        cutHappened = true;
        flipCandidateSymbol = pos.symbol;
        const netPnl = +(uPnl - estFeeUsdt).toFixed(4);
        await recordSvTradeResult(pos.symbol, uPnl, estFeeUsdt, true);
        await appendJournalEntry({ type: 'SV_PROFIT_CUT', symbol: pos.symbol, grossPnl: +uPnl.toFixed(4), estFeeUsdt, netPnl, targetUsdt });
        actions.push({ action: 'SV_PROFIT_CUT', symbol: pos.symbol, netPnl });
        await sendTelegramAlert(
          `⚡ <b>SV ULTRA PRO CUT (+$${netPnl.toFixed(3)} net)</b>\n` +
          `Closed: <b>${pos.symbol}</b> (Gross $${uPnl.toFixed(3)} · Fee ~$${estFeeUsdt.toFixed(3)})\n` +
          `🔄 Opening next scalp immediately...`
        );
      }
      continue;
    }

    // 2. Ultra Pro #4: Step-Trailing Profit Lock
    // Step 2: uPnl >= $0.09 + fee -> lock +$0.05 net | Step 1: uPnl >= $0.06 + fee -> lock +$0.01 net (BE)
    const stepStage = Number(meta?.stepStage || 0);
    if (size > 0) {
      if (uPnl >= (0.09 + estFeeUsdt) && stepStage < 2) {
        const lockDelta = (0.05 + estFeeUsdt) / size;
        const lockSl = formatBybitPrice(isLong ? entry + lockDelta : entry - lockDelta, spec.tickSize);
        const valid = isLong ? (lockSl > entry && lockSl < mark) : (lockSl < entry && lockSl > mark);
        if (valid) {
          await bybitV5Req('POST', '/v5/position/trading-stop', {
            category: 'linear', symbol: pos.symbol, stopLoss: String(lockSl), positionIdx: 0
          }).catch(() => {});
          await saveSvPositionMeta(pos.symbol, { ...meta, stepStage: 2 });
          actions.push({ action: 'SV_STEP2_LOCK_005', symbol: pos.symbol, lockSl });
        }
      } else if (uPnl >= (0.06 + estFeeUsdt) && stepStage < 1) {
        const lockDelta = (0.01 + estFeeUsdt) / size;
        const lockSl = formatBybitPrice(isLong ? entry + lockDelta : entry - lockDelta, spec.tickSize);
        const valid = isLong ? (lockSl > entry && lockSl < mark) : (lockSl < entry && lockSl > mark);
        if (valid) {
          await bybitV5Req('POST', '/v5/position/trading-stop', {
            category: 'linear', symbol: pos.symbol, stopLoss: String(lockSl), positionIdx: 0
          }).catch(() => {});
          await saveSvPositionMeta(pos.symbol, { ...meta, stepStage: 1 });
          actions.push({ action: 'SV_STEP1_LOCK_BE', symbol: pos.symbol, lockSl });
        }
      }
    }

    // 3. Time-Stop Auto Exit (15m stagnant)
    if (meta && meta.openedAt) {
      const ageMin = (Date.now() - Number(meta.openedAt)) / 60000;
      if (ageMin >= maxHoldMin && uPnl >= -0.03) {
        const cutRes = await closeVerifiedLivePosition(pos.symbol);
        if (cutRes.closed) {
          cutHappened = true;
          await recordSvTradeResult(pos.symbol, uPnl, estFeeUsdt, uPnl > estFeeUsdt);
          actions.push({ action: 'SV_TIME_STOP_EXIT', symbol: pos.symbol, ageMin: Math.round(ageMin), uPnl: +uPnl.toFixed(4) });
          await sendTelegramAlert(`⏱️ <b>SV TIME-STOP (${Math.round(ageMin)}m)</b>\nClosed stagnant <b>${pos.symbol}</b> (uPnL $${uPnl.toFixed(3)}).`);
        }
      }
    }
  }

  let latestAcct = acct;
  if (cutHappened) {
    latestAcct = await fetchBybitWalletAndPositions().catch(() => acct);
  }

  const latestStats = await getSvDailyStats();
  await maybeSendDailyGrossFeeNetReport(latestStats);

  const dailyTarget = Number(process.env.SV_DAILY_TARGET_USDT || 2.0);
  const pauseState = await isSvPaused();
  const maxPerHour = Number(process.env.SV_MAX_TRADES_PER_HOUR || 10);
  const hourCount = await getHourlyTradeCount();

  let entrySkippedReason = null;
  if (halted) entrySkippedReason = 'Trading is HALTED';
  else if (!liveAuthorized || !autoExecute) entrySkippedReason = 'ALLOW_LIVE_TRADING or AUTO_EXECUTE is OFF';
  else if (latestAcct.positions.length >= 1) entrySkippedReason = 'SV position already open (max 1 concurrent scalp)';
  else if ((latestAcct.openOrders || []).length >= 1) entrySkippedReason = 'Pending PostOnly Maker order waiting to fill';
  else if (pauseState.paused) entrySkippedReason = `SV Loss Brake active (${pauseState.minsLeft}m left)`;
  else if (latestStats.netPnl >= dailyTarget) entrySkippedReason = `SV Daily Target reached (+$${latestStats.netPnl.toFixed(2)} / $${dailyTarget.toFixed(2)})`;
  else if (isFundingBlackout()) entrySkippedReason = 'SV Funding-Time Blackout (within 5m of funding)';
  else if (!isSvSessionAllowed()) entrySkippedReason = 'SV Session-Only filter active';
  else if (hourCount >= maxPerHour) entrySkippedReason = `Hourly cap reached (${hourCount}/${maxPerHour})`;

  let openedTrade = null;
  if (!entrySkippedReason) {
    const coins = getSvCoins();
    const candidates = (await Promise.all(
      coins.map(coin => {
        const sym = `${coin}USDT`;
        if (!mkt.tickers[sym] || !mkt.instMap[sym]) return null;
        return evaluateSvCandidate({ coin, ticker: mkt.tickers[sym], spec: mkt.instMap[sym], btc1mMovePct, coinStats: latestStats.coinStats });
      })
    )).filter(Boolean).sort((a, b) => b.score - a.score);

    const pick = candidates.find(c => c.symbol === flipCandidateSymbol && c.score >= 78) || candidates[0];
    const minScore = Number(process.env.SV_MIN_SCORE || 62);

    if (pick && pick.score >= minScore) {
      const availBal = Number(latestAcct.wallet.availableBalance || 0);
      const targetUsdt = computeSvTargetUsdt(availBal, pick.atrPct, preset);
      const sz = computeSvAutoSizing({
        availBal, entryPrice: pick.price, atrPct: pick.atrPct,
        spec: pick.spec, targetUsdt, preset, inRecoveryMode: Boolean(latestStats.lastWasLoss)
      });

      if (sz.ok) {
        const isLong = pick.direction === 'LONG';
        const side = isLong ? 'Buy' : 'Sell';

        // Exchange-Level Auto TP (Net-of-Fee $0.10+)
        const tpDelta = sz.grossTargetUsdt / sz.qty;
        const tpPrice = formatBybitPrice(isLong ? pick.price + tpDelta : pick.price - tpDelta, pick.spec.tickSize);

        // Ultra Pro #5: Anti-Wick Liquidation Shield (Hard SL within maxSlUsdt AND maxSlPct <= 1.1%)
        const slDelta = Math.min(preset.maxSlUsdt / sz.qty, pick.price * preset.maxSlPct);
        const slPrice = formatBybitPrice(isLong ? pick.price - slDelta : pick.price + slDelta, pick.spec.tickSize);

        await configureIsolatedAndLeverage(pick.symbol, sz.leverage);

        const orderRes = await placeSmartSvOrder({
          symbol: pick.symbol,
          side,
          qty: sz.qty,
          bid1: pick.bid1,
          ask1: pick.ask1,
          tickSize: pick.spec.tickSize,
          slPrice,
          tpPrice
        });

        await incrementHourlyTradeCount();
        await saveSvPositionMeta(pick.symbol, {
          entry: orderRes.execPrice || pick.price,
          direction: pick.direction,
          qty: sz.qty,
          leverage: sz.leverage,
          targetUsdt,
          estFeeUsdt: sz.estFeeUsdt,
          tpPrice,
          slPrice,
          preset: preset.key,
          stepStage: 0
        });

        await appendJournalEntry({
          type: 'SV_ULTRA_OPEN',
          symbol: pick.symbol,
          direction: pick.direction,
          preset: preset.key,
          orderType: orderRes.orderType,
          qty: sz.qty,
          leverage: sz.leverage,
          margin: sz.marginUsdt,
          entry: orderRes.execPrice || pick.price,
          tp: tpPrice,
          sl: slPrice,
          targetUsdt,
          score: pick.score,
          orderId: orderRes.orderId
        });

        await sendTelegramAlert(
          `⚡ <b>SV ULTRA PRO ${pick.direction} (${pick.symbol})</b>\n` +
          `Preset: <b>${preset.label}</b>${sz.inRecoveryMode ? ' <i>(Recovery 10x)</i>' : ''}\n` +
          `Entry (${orderRes.orderType}): <code>${orderRes.execPrice || pick.price}</code>\n` +
          `Size: ${sz.qty} (${sz.leverage}x · $${sz.marginUsdt} margin · $${sz.notional})\n` +
          `Auto TP (+$${targetUsdt.toFixed(2)} net): <code>${tpPrice}</code> | Shield SL: <code>${slPrice}</code>\n` +
          `Score: <b>${pick.score}/100</b> | ${pick.reasons.join(' · ')}`
        );

        openedTrade = {
          symbol: pick.symbol, direction: pick.direction, orderType: orderRes.orderType,
          qty: sz.qty, leverage: sz.leverage, margin: sz.marginUsdt, tpPrice, slPrice, orderId: orderRes.orderId
        };
      } else {
        entrySkippedReason = sz.reason;
      }
    } else {
      entrySkippedReason = pick ? `Best setup ${pick.symbol} score ${pick.score} < ${minScore}` : 'No clean 1m/3m SV setup right now';
    }
  }

  return {
    ok: true,
    mode: 'SV_ULTRA_PRO',
    preset: preset.key,
    btc1mMovePct: +btc1mMovePct.toFixed(3),
    actions,
    openedTrade,
    entrySkippedReason,
    stats: latestStats,
    wallet: latestAcct.wallet,
    positions: latestAcct.positions
  };
}

async function getSvStatusSummary() {
  const [filters, stats, pauseState, hrCount] = await Promise.all([
    getBotFilters().catch(() => ({})),
    getSvDailyStats(),
    isSvPaused(),
    getHourlyTradeCount()
  ]);
  const active = isSvModeActive(filters);
  const preset = getSvPresetConfig(filters);
  const wr = stats.trades ? ((stats.wins / stats.trades) * 100).toFixed(1) : '0.0';
  const maxHr = Number(process.env.SV_MAX_TRADES_PER_HOUR || 10);
  const dailyTgt = Number(process.env.SV_DAILY_TARGET_USDT || 2.0);

  return (
    `⚡ *SV ULTRA PRO STATUS (v16.0)*\n` +
    `State: *${active ? 'ON 🟢' : 'OFF ⚪'}* | Preset: *${preset.label}*\n` +
    `Entry: *${isMakerFirstEnabled() ? 'Maker-First (Low Fee)' : 'Market IOC'}*${stats.lastWasLoss ? ' · _Recovery 10x Active_' : ''}\n` +
    `Today: *${stats.trades}* trades (${stats.wins}W / ${stats.losses}L · WR *${wr}%*)\n` +
    `Profit Cuts: *${stats.cuts}* | Cap: *${hrCount}/${maxHr}/hr*\n` +
    `💵 Gross: *$${Number(stats.grossPnl || 0).toFixed(3)}* | 🧾 Fees: *-$${Number(stats.totalFees || 0).toFixed(3)}*\n` +
    `✅ Net PnL: *$${Number(stats.netPnl || 0).toFixed(3)}* / $${dailyTgt.toFixed(2)}\n` +
    `Brake: *${pauseState.paused ? `PAUSED (${pauseState.minsLeft}m)` : 'OK'}*`
  );
}

module.exports = {
  SV_PRESETS,
  getSvPresetConfig,
  isSvModeActive,
  isSvPaperMode,
  computeSvAutoSizing,
  computeSvTargetUsdt,
  getSvHeatmap,
  runSvCycle,
  getSvStatusSummary,
  getSvDailyStats
};
