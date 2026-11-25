// File: lib/modules/svScalpEngine.js (v14.1 — STANDALONE SV MICRO-SCALPING ENGINE, ALL 40 UPDATES)
// When SV_MODE is ON (via Vercel Env SV_MODE=true or Telegram /sv_on), this engine runs EXCLUSIVELY
// with 100% Auto Leverage & Auto Margin, bypassing Normal v6 Pipeline, EA Gate, and Groq AI delays.

const { fetchBybitPublicJson, getBybitMarketData, fetchOrderBookImbalance } = require('./marketData');
const { calcEMA, calcRSI, calcWilderATR } = require('./indicators');
const { formatBybitPrice, formatBybitQty } = require('./riskAndValidation');
const {
  bybitV5Req, fetchBybitWalletAndPositions, configureIsolatedAndLeverage, closeVerifiedLivePosition
} = require('./bybitLiveClient');
const { redisCmd, appendJournalEntry, getBotFilters } = require('./securityAndState');
const { sendTelegramAlert } = require('./telegramNotifier');

// #3 High-Liquidity Scalping Whitelist (tightest spreads on Bybit Linear)
const DEFAULT_SV_COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE'];

function getSvCoins() {
  const raw = String(process.env.SV_COINS || '').trim();
  if (!raw) return DEFAULT_SV_COINS;
  const list = raw.split(',').map(s => s.trim().toUpperCase().replace(/USDT$/, '')).filter(Boolean);
  return list.length ? list : DEFAULT_SV_COINS;
}

// #1 & #40: SV-ONLY Mode Activation Check (Defaults ON; disable via SV_MODE=false or Telegram /sv_off)
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

function getUtcDay() {
  return new Date().toISOString().slice(0, 10);
}

function getUtcHourKey() {
  return new Date().toISOString().slice(0, 13);
}

// #2 1m & 3m Closed Candle Fetcher
async function fetchSvKlines(coin, interval = '1', limit = 60) {
  const sym = `${String(coin).toUpperCase().replace(/USDT$/, '')}USDT`;
  const j = await fetchBybitPublicJson(
    `/v5/market/kline?category=linear&symbol=${sym}&interval=${interval}&limit=${limit}`,
    3000
  );
  const raw = (j?.result?.list || []).slice(1).reverse().map(k => [
    Number(k[0]), Number(k[1]), Number(k[2]), Number(k[3]), Number(k[4]), Number(k[5] || 0)
  ]);
  return raw;
}

// #21 Heikin Ashi 1m Trend Smoothing
function computeHeikinAshi(candles) {
  const ha = [];
  for (let i = 0; i < candles.length; i++) {
    const [ts, o, h, l, c] = candles[i];
    const haClose = (o + h + l + c) / 4;
    const haOpen = i === 0 ? (o + c) / 2 : (ha[i - 1].open + ha[i - 1].close) / 2;
    const haHigh = Math.max(h, haOpen, haClose);
    const haLow = Math.min(l, haOpen, haClose);
    ha.push({ ts, open: haOpen, high: haHigh, low: haLow, close: haClose, bullish: haClose > haOpen });
  }
  return ha;
}

// #5 VWAP on 1m candles
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

// #6 Stochastic RSI (Fast 7)
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

// #22 Bollinger Band (20, 2) Mean-Reversion Scalp
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

// #23 Micro-FVG (1m Fair Value Gap) Tap Entry
function detectMicroFvgTap(candles, direction) {
  if (candles.length < 6) return false;
  const last = candles[candles.length - 1];
  for (let i = candles.length - 2; i >= Math.max(2, candles.length - 7); i--) {
    const prev2 = candles[i - 2];
    const curr = candles[i];
    if (direction === 'LONG' && curr[3] > prev2[2]) {
      if (last[3] <= curr[3] && last[4] >= prev2[2]) return true;
    }
    if (direction === 'SHORT' && curr[2] < prev2[3]) {
      if (last[2] >= curr[2] && last[4] <= prev2[3]) return true;
    }
  }
  return false;
}

// #25 Wick-Rejection Exhaustion Filter
function hasExhaustionWick(candle, direction) {
  const [, o, h, l, c] = candle;
  const body = Math.max(1e-8, Math.abs(c - o));
  const upperWick = h - Math.max(o, c);
  const lowerWick = Math.min(o, c) - l;
  if (direction === 'LONG' && upperWick >= body * 2.0) return true;
  if (direction === 'SHORT' && lowerWick >= body * 2.0) return true;
  return false;
}

// #32 Funding-Time Blackout (5m before 00:00 / 08:00 / 16:00 UTC)
function isFundingBlackout(nowMs = Date.now()) {
  const d = new Date(nowMs);
  const minsSinceDay = d.getUTCHours() * 60 + d.getUTCMinutes();
  const minsToNext = 480 - (minsSinceDay % 480);
  return minsToNext <= 5;
}

// #37 Best-Session SV Turbo Mode (optional SV_SESSION_ONLY=true)
function isSvSessionAllowed(nowMs = Date.now()) {
  if (String(process.env.SV_SESSION_ONLY || '').trim().toLowerCase() !== 'true') return true;
  const h = new Date(nowMs).getUTCHours();
  return h >= 7 && h < 21;
}

// #26 & #31: Auto Balance-Tier + Volatility-Scaled Profit Target
function computeSvTargetUsdt(availBal, atrPct = 0.12) {
  const explicit = Number(process.env.SV_PROFIT_TARGET_USDT || 0);
  let base = explicit > 0 ? explicit : 0.10;

  // #31 Auto Balance-Tier Scaling (when user hasn't locked a fixed target)
  if (explicit <= 0) {
    if (availBal >= 200) base = 0.50;
    else if (availBal >= 75) base = 0.25;
    else if (availBal >= 25) base = 0.15;
    else base = 0.10;
  }

  // #26 Volatility-Scaled Profit Target (scale up 1.5x in fast 1m moves)
  const volMult = atrPct >= 0.28 ? 1.5 : (atrPct >= 0.18 ? 1.25 : 1.0);
  return +(base * volMult).toFixed(3);
}

// #19: 100% Auto Leverage & Auto Margin (with optional env overrides)
function computeSvAutoSizing({ availBal, entryPrice, atrPct, coin, spec, targetUsdt }) {
  const envLev = Number(process.env.SV_LEVERAGE || 0);
  const envMargin = Number(process.env.SV_MARGIN_USDT || 0);
  const maxLevSpec = Math.min(20, Number(spec.maxLeverage || 10));
  const coinCap = (coin === 'BTC' || coin === 'ETH') ? 8 : 6;

  // Auto Leverage (3x - 8x based on 1m volatility)
  let leverage = envLev > 0
    ? Math.min(maxLevSpec, Math.max(2, Math.round(envLev)))
    : (atrPct > 0.30 ? 3 : atrPct > 0.20 ? 5 : atrPct > 0.12 ? 6 : 8);
  leverage = Math.min(maxLevSpec, coinCap, Math.max(2, leverage));

  // Auto Margin (18% of available balance, safely floored so notional >= minNotionalValue)
  const minNotional = Math.max(5.2, Number(spec.minNotionalValue || 5));
  const minMarginNeeded = (minNotional / leverage) * 1.05;
  let marginUsdt = envMargin > 0 ? Math.min(availBal * 0.90, envMargin) : Math.max(minMarginNeeded, availBal * 0.18);
  marginUsdt = Math.min(availBal * 0.85, marginUsdt);

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

  // #11 & #35: Net-of-Fee calculation & Auto-Fee-Ratio Guard
  const makerEntry = String(process.env.SV_MAKER_ENTRY || '').trim().toLowerCase() === 'true';
  const roundTripFeeRate = makerEntry ? 0.0005 : 0.0011;
  const estFeeUsdt = +(actualNotional * roundTripFeeRate).toFixed(4);
  if (estFeeUsdt > targetUsdt * 0.40) {
    return { ok: false, reason: `SV Fee-Ratio Guard: est fee ($${estFeeUsdt}) > 40% of target ($${targetUsdt})` };
  }

  return {
    ok: true,
    leverage,
    marginUsdt: +(actualNotional / leverage).toFixed(2),
    notional: +actualNotional.toFixed(2),
    qty,
    estFeeUsdt,
    grossTargetUsdt: +(targetUsdt + estFeeUsdt).toFixed(4)
  };
}

// ============================================================
// REDIS STATE HELPERS (#14, #16, #17, #18, #33, #36, #38, #39)
// ============================================================
async function getSvDailyStats() {
  const key = `bybit_bot:sv_stats:${getUtcDay()}`;
  const r = await redisCmd('GET', key);
  if (r.ok && r.result) {
    try { return JSON.parse(r.result); } catch (e) {}
  }
  return { trades: 0, wins: 0, losses: 0, netPnl: 0, cuts: 0, consecutiveLosses: 0, coinStats: {} };
}

async function recordSvTradeResult(symbol, pnlUsdt, isProfitCut = false) {
  const key = `bybit_bot:sv_stats:${getUtcDay()}`;
  const stats = await getSvDailyStats();
  const pnl = Number(pnlUsdt || 0);
  stats.trades += 1;
  stats.netPnl = +(stats.netPnl + pnl).toFixed(4);
  if (pnl >= 0) {
    stats.wins += 1;
    stats.consecutiveLosses = 0;
    if (isProfitCut) stats.cuts += 1;
  } else {
    stats.losses += 1;
    stats.consecutiveLosses = (stats.consecutiveLosses || 0) + 1;
    // #16 Same-Coin Cooldown (5 minutes)
    await redisCmd('SET', `bybit_bot:sv_cd:${symbol}`, '1', 'EX', '300');
    // #17 SV Consecutive-Loss Brake (3 losses -> 30 min pause)
    if (stats.consecutiveLosses >= 3) {
      const until = Date.now() + 30 * 60 * 1000;
      await redisCmd('SET', 'bybit_bot:sv_pause_until', String(until), 'EX', '1800');
      await sendTelegramAlert(`🛑 <b>SV MODE LOSS BRAKE (30m PAUSE)</b>\n3 consecutive SV losses detected. Pausing SV Engine for 30 minutes.`);
    }
  }
  // #36 Coin Leaderboard stats
  const cs = stats.coinStats[symbol] || { trades: 0, wins: 0, netPnl: 0 };
  cs.trades += 1;
  if (pnl >= 0) cs.wins += 1;
  cs.netPnl = +(cs.netPnl + pnl).toFixed(4);
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

// #38 SV Hourly Profit Digest
async function maybeSendHourlySvDigest(stats) {
  if (!stats || stats.trades === 0) return;
  const key = `bybit_bot:sv_digest:${getUtcHourKey()}`;
  const r = await redisCmd('GET', key);
  if (r.ok && r.result === '1') return;
  if (new Date().getUTCMinutes() < 50) return;
  await redisCmd('SET', key, '1', 'EX', '7200');
  const wr = stats.trades ? ((stats.wins / stats.trades) * 100).toFixed(1) : '0.0';
  await sendTelegramAlert(
    `⚡ <b>SV MODE HOURLY DIGEST</b>\n` +
    `Today Trades: <b>${stats.trades}</b> (${stats.wins}W / ${stats.losses}L · WR ${wr}%)\n` +
    `Profit Cuts: <b>${stats.cuts}</b> | Net PnL: <b>${stats.netPnl >= 0 ? '+' : ''}$${stats.netPnl.toFixed(3)}</b>`
  );
}

// ============================================================
// CORE SV SIGNAL SCANNER (#2, #3, #5-#10, #21-#25, #36)
// ============================================================
async function evaluateSvCandidate({ coin, ticker, spec, btc1mMovePct, coinStats = {} }) {
  const symbol = `${coin}USDT`;

  // #9 Micro-Spread Guard (< 0.03%)
  const maxSpread = Number(process.env.SV_MAX_SPREAD_PCT || 0.03);
  const spreadPct = ticker.bid1 > 0 ? ((ticker.ask1 - ticker.bid1) / ticker.bid1) * 100 : 0.05;
  if (spreadPct > maxSpread) return null;

  // #16 Cooldown check & #36 Auto-mute poorly performing coin
  if (await isCoinOnCooldown(symbol)) return null;
  const cs = coinStats[symbol];
  if (cs && cs.trades >= 4 && (cs.wins / cs.trades) < 0.25 && cs.netPnl < 0) return null;

  const [c1m, c3m, obiRaw] = await Promise.all([
    fetchSvKlines(coin, '1', 50).catch(() => []),
    fetchSvKlines(coin, '3', 35).catch(() => []),
    fetchOrderBookImbalance(symbol, 5).catch(() => ({ ok: false, obi: 0 }))
  ]);

  if (c1m.length < 25 || c3m.length < 22) return null;

  const closes1m = c1m.map(c => c[4]);
  const highs1m = c1m.map(c => c[2]);
  const lows1m = c1m.map(c => c[3]);
  const vols1m = c1m.map(c => c[5]);
  const closes3m = c3m.map(c => c[4]);

  const last = c1m[c1m.length - 1];
  const price = ticker.lastPrice || last[4];

  // #24 Trade Velocity / Dead-Market Filter
  const avgVol20 = vols1m.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  const volRatio = avgVol20 > 0 ? last[5] / avgVol20 : 1;
  const range5 = (Math.max(...highs1m.slice(-5)) - Math.min(...lows1m.slice(-5))) / Math.max(1e-8, price) * 100;
  if (range5 < 0.04 || volRatio < 0.35) return null;

  // #5 EMA 9/21 + VWAP
  const ema9_1m = calcEMA(closes1m, 9);
  const ema21_1m = calcEMA(closes1m, 21);
  const ema9_3m = calcEMA(closes3m, 9);
  const ema21_3m = calcEMA(closes3m, 21);
  const vwap = calcMicroVwap(c1m, 30);

  // #6 Fast RSI(7) + StochRSI
  const { rsi7, stochK } = calcFastStochRsi(closes1m, 7, 7);

  // #21 Heikin Ashi 1m smoothing
  const ha = computeHeikinAshi(c1m);
  const haLast = ha[ha.length - 1];
  const haPrev = ha[ha.length - 2];

  // #22 Bollinger Bounce
  const bb = detectBollingerBounce(c1m, 20);

  // Direction Scoring
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
    if (stochK <= 45) { score += 8; reasons.push('Pullback Turn'); }
    if (bb.bounce === 'LONG') { score += 12; reasons.push('BB Lower Bounce'); }
  } else if (bearTrend || bb.bounce === 'SHORT') {
    direction = 'SHORT';
    if (ema9_1m < ema21_1m) { score += 22; reasons.push('1m EMA9<21'); }
    if (ema9_3m < ema21_3m) { score += 16; reasons.push('3m Bear'); }
    if (price < vwap) { score += 14; reasons.push('Below VWAP'); }
    if (!haLast.bullish && !haPrev.bullish) { score += 12; reasons.push('HA Bear'); }
    if (rsi7 >= 32 && rsi7 <= 58) { score += 10; reasons.push(`RSI7 ${rsi7}`); }
    if (stochK >= 55) { score += 8; reasons.push('Pullback Turn'); }
    if (bb.bounce === 'SHORT') { score += 12; reasons.push('BB Upper Bounce'); }
  } else {
    return null;
  }

  // #10 BTC 1m Micro-Pulse Sync
  if (coin !== 'BTC') {
    if (direction === 'LONG' && btc1mMovePct <= -0.25) return null;
    if (direction === 'SHORT' && btc1mMovePct >= 0.25) return null;
  }

  // #25 Wick-Rejection Exhaustion Filter
  if (hasExhaustionWick(last, direction)) return null;

  // #7 OBI Micro-Burst
  const obi = Number(obiRaw?.obi || 0);
  if (direction === 'LONG' && obi < -0.40) return null;
  if (direction === 'SHORT' && obi > 0.40) return null;
  if ((direction === 'LONG' && obi >= 0.20) || (direction === 'SHORT' && obi <= -0.20)) {
    score += 10;
    reasons.push(`OBI ${(obi * 100).toFixed(0)}%`);
  }

  // #8 Volume Spike Confirmation (1.8x+)
  if (volRatio >= 1.8) {
    score += 10;
    reasons.push(`Vol ${volRatio.toFixed(1)}x`);
  }

  // #23 Micro-FVG Tap
  if (detectMicroFvgTap(c1m, direction)) {
    score += 8;
    reasons.push('1m FVG Tap');
  }

  // #36 Leaderboard bonus for winning coins
  if (cs && cs.trades >= 2 && (cs.wins / cs.trades) >= 0.65 && cs.netPnl > 0) {
    score += 6;
    reasons.push('Top SV Coin');
  }

  const atr = calcWilderATR(highs1m, lows1m, closes1m, 14) || (price * 0.0015);
  const atrPct = (atr / Math.max(1e-8, price)) * 100;

  return {
    coin,
    symbol,
    direction,
    price,
    bid1: ticker.bid1,
    ask1: ticker.ask1,
    spreadPct: +spreadPct.toFixed(4),
    atr,
    atrPct: +atrPct.toFixed(4),
    rsi7,
    volRatio: +volRatio.toFixed(2),
    score: Math.min(100, score),
    reasons,
    spec
  };
}

// ============================================================
// #39 SV PAPER-TEST SANDBOX (Virtual Execution on Live 1m Data)
// ============================================================
async function runSvPaperCycle(mkt, btc1mMovePct) {
  const key = 'bybit_bot:sv_paper_state';
  const r = await redisCmd('GET', key);
  let state = { balance: 100, position: null, wins: 0, losses: 0, netPnl: 0 };
  if (r.ok && r.result) {
    try { state = JSON.parse(r.result); } catch (e) {}
  }

  const actions = [];
  if (state.position) {
    const pos = state.position;
    const t = mkt.tickers[pos.symbol];
    const mark = t ? t.lastPrice : pos.entry;
    const pnl = pos.direction === 'LONG'
      ? (mark - pos.entry) * pos.qty - pos.estFeeUsdt
      : (pos.entry - mark) * pos.qty - pos.estFeeUsdt;

    const ageMin = (Date.now() - pos.openedAt) / 60000;
    if (pnl >= pos.targetUsdt || pnl <= -pos.maxSlUsdt || ageMin >= 15) {
      state.balance = +(state.balance + pnl).toFixed(4);
      state.netPnl = +(state.netPnl + pnl).toFixed(4);
      if (pnl >= 0) state.wins += 1;
      else state.losses += 1;
      actions.push({ type: 'PAPER_CLOSE', symbol: pos.symbol, pnl: +pnl.toFixed(4), balance: state.balance });
      state.position = null;
    }
  }

  if (!state.position) {
    const coins = getSvCoins();
    const cands = (await Promise.all(
      coins.map(coin => mkt.tickers[`${coin}USDT`] && mkt.instMap[`${coin}USDT`]
        ? evaluateSvCandidate({ coin, ticker: mkt.tickers[`${coin}USDT`], spec: mkt.instMap[`${coin}USDT`], btc1mMovePct })
        : null)
    )).filter(Boolean).sort((a, b) => b.score - a.score);

    const best = cands[0];
    if (best && best.score >= 62) {
      const targetUsdt = computeSvTargetUsdt(state.balance, best.atrPct);
      const sz = computeSvAutoSizing({ availBal: state.balance, entryPrice: best.price, atrPct: best.atrPct, coin: best.coin, spec: best.spec, targetUsdt });
      if (sz.ok) {
        state.position = {
          symbol: best.symbol, direction: best.direction, entry: best.price, qty: sz.qty,
          leverage: sz.leverage, targetUsdt, maxSlUsdt: Math.max(0.25, targetUsdt * 2.5),
          estFeeUsdt: sz.estFeeUsdt, openedAt: Date.now()
        };
        actions.push({ type: 'PAPER_OPEN', ...state.position, score: best.score });
      }
    }
  }

  await redisCmd('SET', key, JSON.stringify(state), 'EX', '604800');
  return { ok: true, mode: 'SV_PAPER', state, actions };
}

// ============================================================
// MAIN STANDALONE SV ENGINE CYCLE (Called exclusively when SV_MODE is ON)
// ============================================================
async function runSvCycle({ halted = false, autoExecute = false, liveAuthorized = false } = {}) {
  const mkt = await getBybitMarketData();

  // Fetch BTC 1m pulse (#10 & #34)
  const btc1m = await fetchSvKlines('BTC', '1', 5).catch(() => []);
  let btc1mMovePct = 0;
  if (btc1m.length >= 1) {
    const bLast = btc1m[btc1m.length - 1];
    btc1mMovePct = bLast[1] > 0 ? ((bLast[4] - bLast[1]) / bLast[1]) * 100 : 0;
  }

  // #39 Paper Mode Sandbox
  if (isSvPaperMode()) {
    return runSvPaperCycle(mkt, btc1mMovePct);
  }

  const acct = await fetchBybitWalletAndPositions();
  const stats = await getSvDailyStats();
  const actions = [];
  let flipCandidateSymbol = null;

  // #34 BTC Flash-Move Emergency Exit (>= 0.60% in 1m)
  if (Math.abs(btc1mMovePct) >= 0.60 && acct.positions.length > 0) {
    for (const pos of acct.positions) {
      if (pos.symbol === 'BTCUSDT') continue;
      const closeRes = await closeVerifiedLivePosition(pos.symbol).catch(e => ({ closed: false, reason: e.message }));
      if (closeRes.closed) {
        await recordSvTradeResult(pos.symbol, Number(pos.unrealisedPnl || 0), false);
        actions.push({ action: 'BTC_FLASH_EMERGENCY_EXIT', symbol: pos.symbol, btc1mMovePct: +btc1mMovePct.toFixed(2) });
        await sendTelegramAlert(`🚨 <b>SV BTC FLASH EXIT</b>\nBTC 1m moved ${btc1mMovePct.toFixed(2)}%. Closed <b>${pos.symbol}</b> (uPnL $${Number(pos.unrealisedPnl || 0).toFixed(3)}).`);
      }
    }
    return { ok: true, mode: 'SV_STANDALONE', halted, actions, stats, wallet: acct.wallet };
  }

  // Manage existing SV positions (#11, #14, #15, #27, #28)
  let cutHappened = false;
  const maxHoldMin = Number(process.env.SV_MAX_HOLD_MIN || 15);
  const partialRunnerOn = String(process.env.SV_PARTIAL_RUNNER || '').trim().toLowerCase() === 'true';

  for (const pos of acct.positions) {
    const meta = await getSvPositionMeta(pos.symbol);
    const uPnl = Number(pos.unrealisedPnl || 0);
    const size = Number(pos.size || 0);
    const entry = Number(pos.avgPrice || 0);
    const isLong = pos.side === 'Buy';
    const spec = mkt.instMap[pos.symbol] || { tickSize: 0.0001, qtyStep: 0.01, minOrderQty: 0.01 };

    const targetUsdt = Number(meta?.targetUsdt || computeSvTargetUsdt(acct.wallet.availableBalance, 0.12));
    const estFeeUsdt = Number(meta?.estFeeUsdt || (size * entry * 0.0011));
    const grossTarget = targetUsdt + estFeeUsdt; // #11 Net-of-Fee target

    // 1. #11 Net-of-Fee Profit Cut (or #27 Partial 70%/30% Runner)
    if (uPnl >= grossTarget) {
      const partQty = formatBybitQty(size * 0.70, spec.qtyStep);
      const remQty = formatBybitQty(size - partQty, spec.qtyStep);
      if (partialRunnerOn && !meta?.partialDone && partQty >= spec.minOrderQty && remQty >= spec.minOrderQty) {
        const closeSide = isLong ? 'Sell' : 'Buy';
        await bybitV5Req('POST', '/v5/order/create', {
          category: 'linear', symbol: pos.symbol, side: closeSide,
          orderType: 'Market', qty: String(partQty), reduceOnly: true, positionIdx: 0
        });
        const beSl = formatBybitPrice(isLong ? entry * 1.0006 : entry * 0.9994, spec.tickSize);
        await bybitV5Req('POST', '/v5/position/trading-stop', {
          category: 'linear', symbol: pos.symbol, stopLoss: String(beSl), positionIdx: 0
        }).catch(() => {});
        await saveSvPositionMeta(pos.symbol, { ...meta, partialDone: true });
        await recordSvTradeResult(pos.symbol, uPnl * 0.70, true);
        actions.push({ action: 'SV_PARTIAL_70_CUT', symbol: pos.symbol, uPnl: +uPnl.toFixed(4) });
        await sendTelegramAlert(`⚡ <b>SV 70% PROFIT CUT (+$${uPnl.toFixed(3)})</b>\n<b>${pos.symbol}</b> · 30% free runner active with BE SL.`);
      } else {
        const cutRes = await closeVerifiedLivePosition(pos.symbol);
        if (cutRes.closed) {
          cutHappened = true;
          flipCandidateSymbol = pos.symbol;
          const netPnl = +(uPnl - estFeeUsdt).toFixed(4);
          await recordSvTradeResult(pos.symbol, netPnl, true);
          await appendJournalEntry({ type: 'SV_PROFIT_CUT', symbol: pos.symbol, uPnl: +uPnl.toFixed(4), netPnl, targetUsdt });
          actions.push({ action: 'SV_PROFIT_CUT', symbol: pos.symbol, uPnl: +uPnl.toFixed(4), netPnl });
          await sendTelegramAlert(
            `⚡ <b>SV CUT (+$${netPnl.toFixed(3)} net)</b>\n` +
            `Closed: <b>${pos.symbol}</b> (Target $${targetUsdt.toFixed(2)} + fee)\n` +
            `🔄 Scanning next entry immediately...`
          );
        }
      }
      continue;
    }

    // 2. #28 Momentum-Fade Early Exit (uPnl >= 60% of target & 1m RSI7 reverses)
    if (uPnl >= grossTarget * 0.60) {
      const c1 = await fetchSvKlines(pos.symbol.replace(/USDT$/, ''), '1', 20).catch(() => []);
      if (c1.length >= 12) {
        const rsi7 = calcRSI(c1.map(x => x[4]), 7);
        const fading = (isLong && rsi7 < 42) || (!isLong && rsi7 > 58);
        if (fading) {
          const cutRes = await closeVerifiedLivePosition(pos.symbol);
          if (cutRes.closed) {
            cutHappened = true;
            await recordSvTradeResult(pos.symbol, uPnl - estFeeUsdt, true);
            actions.push({ action: 'SV_MOMENTUM_FADE_EXIT', symbol: pos.symbol, uPnl: +uPnl.toFixed(4), rsi7 });
            await sendTelegramAlert(`⚡ <b>SV FADE EXIT (+$${uPnl.toFixed(3)})</b>\n<b>${pos.symbol}</b> momentum faded (RSI7 ${rsi7}). Banked profit!`);
            continue;
          }
        }
      }
    }

    // 3. #15 Micro-Trailing Profit Lock (at >= 75% of target, move SL to lock +$0.02)
    if (uPnl >= grossTarget * 0.75 && !meta?.microTrailSet && size > 0) {
      const lockDelta = (0.02 + estFeeUsdt) / size;
      const lockSl = formatBybitPrice(isLong ? entry + lockDelta : entry - lockDelta, spec.tickSize);
      const validSl = isLong ? (lockSl > entry && lockSl < Number(pos.markPrice || 0)) : (lockSl < entry && lockSl > Number(pos.markPrice || 0));
      if (validSl) {
        await bybitV5Req('POST', '/v5/position/trading-stop', {
          category: 'linear', symbol: pos.symbol, stopLoss: String(lockSl), positionIdx: 0
        }).catch(() => {});
        await saveSvPositionMeta(pos.symbol, { ...meta, microTrailSet: true });
        actions.push({ action: 'SV_MICRO_TRAIL_LOCKED', symbol: pos.symbol, lockSl });
      }
    }

    // 4. #14 Time-Stop Auto Exit (15m max hold if stagnant)
    if (meta && meta.openedAt) {
      const ageMin = (Date.now() - Number(meta.openedAt)) / 60000;
      if (ageMin >= maxHoldMin && uPnl >= -0.02) {
        const cutRes = await closeVerifiedLivePosition(pos.symbol);
        if (cutRes.closed) {
          cutHappened = true;
          await recordSvTradeResult(pos.symbol, uPnl - estFeeUsdt, uPnl > 0);
          actions.push({ action: 'SV_TIME_STOP_EXIT', symbol: pos.symbol, ageMin: Math.round(ageMin), uPnl: +uPnl.toFixed(4) });
          await sendTelegramAlert(`⏱️ <b>SV TIME-STOP (${Math.round(ageMin)}m)</b>\nClosed stagnant <b>${pos.symbol}</b> (uPnL $${uPnl.toFixed(3)}).`);
        }
      }
    }
  }

  // #4 Zero-Delay Refresh after cut so new trade opens in the same minute
  let latestAcct = acct;
  if (cutHappened) {
    latestAcct = await fetchBybitWalletAndPositions().catch(() => acct);
  }

  // Entry Guards (#1, #17, #18, #32, #33, #37)
  const latestStats = await getSvDailyStats();
  await maybeSendHourlySvDigest(latestStats);

  const dailyTarget = Number(process.env.SV_DAILY_TARGET_USDT || 2.0);
  const pauseState = await isSvPaused();
  const maxPerHour = Number(process.env.SV_MAX_TRADES_PER_HOUR || 8);
  const hourCount = await getHourlyTradeCount();

  let entrySkippedReason = null;
  if (halted) entrySkippedReason = 'Trading is HALTED';
  else if (!liveAuthorized || !autoExecute) entrySkippedReason = 'ALLOW_LIVE_TRADING or AUTO_EXECUTE is OFF';
  else if (latestAcct.positions.length >= 1) entrySkippedReason = 'SV position already open (max 1 concurrent scalp)';
  else if (pauseState.paused) entrySkippedReason = `SV Consecutive-Loss Brake active (${pauseState.minsLeft}m left)`;
  else if (latestStats.netPnl >= dailyTarget) entrySkippedReason = `SV Daily Target reached (+$${latestStats.netPnl.toFixed(2)} / $${dailyTarget.toFixed(2)})`;
  else if (isFundingBlackout()) entrySkippedReason = 'SV Funding-Time Blackout (within 5m of funding)';
  else if (!isSvSessionAllowed()) entrySkippedReason = 'SV Session-Only filter active (outside London/NY)';
  else if (hourCount >= maxPerHour) entrySkippedReason = `SV Max Trades-Per-Hour cap reached (${hourCount}/${maxPerHour})`;

  let openedTrade = null;
  if (!entrySkippedReason) {
    const coins = getSvCoins();
    const candidates = (await Promise.all(
      coins.map(coin => {
        const sym = `${coin}USDT`;
        const ticker = mkt.tickers[sym];
        const spec = mkt.instMap[sym];
        if (!ticker || !spec) return null;
        return evaluateSvCandidate({ coin, ticker, spec, btc1mMovePct, coinStats: latestStats.coinStats });
      })
    )).filter(Boolean).sort((a, b) => b.score - a.score);

    // #30 Instant SV Flip-on-Reversal priority if same coin has strong score >= 78
    let pick = candidates.find(c => c.symbol === flipCandidateSymbol && c.score >= 78) || candidates[0];

    const minScore = Number(process.env.SV_MIN_SCORE || 62);
    if (pick && pick.score >= minScore) {
      const availBal = Number(latestAcct.wallet.availableBalance || 0);
      const targetUsdt = computeSvTargetUsdt(availBal, pick.atrPct);
      const sz = computeSvAutoSizing({
        availBal, entryPrice: pick.price, atrPct: pick.atrPct,
        coin: pick.coin, spec: pick.spec, targetUsdt
      });

      if (sz.ok) {
        const isLong = pick.direction === 'LONG';
        const side = isLong ? 'Buy' : 'Sell';
        const makerEntry = String(process.env.SV_MAKER_ENTRY || '').trim().toLowerCase() === 'true';

        // #12 Exchange-Level Auto Take-Profit Price (Net-of-Fee target)
        const tpDelta = sz.grossTargetUsdt / sz.qty;
        const tpPrice = formatBybitPrice(isLong ? pick.price + tpDelta : pick.price - tpDelta, pick.spec.tickSize);

        // #13 Tight Micro-SL Guard (max loss = max($0.25, 2.5x target) or 0.45% price move)
        const maxSlUsdt = Math.max(0.25, targetUsdt * 2.5);
        const slDelta = Math.min(maxSlUsdt / sz.qty, pick.price * 0.0045);
        const slPrice = formatBybitPrice(isLong ? pick.price - slDelta : pick.price + slDelta, pick.spec.tickSize);

        await configureIsolatedAndLeverage(pick.symbol, sz.leverage);

        const orderPayload = {
          category: 'linear',
          symbol: pick.symbol,
          side,
          orderType: makerEntry ? 'Limit' : 'Market',
          qty: String(sz.qty),
          timeInForce: makerEntry ? 'PostOnly' : 'IOC',
          stopLoss: String(slPrice),
          takeProfit: String(tpPrice),
          positionIdx: 0
        };
        if (makerEntry) {
          const limitPx = isLong ? pick.bid1 : pick.ask1;
          orderPayload.price = String(formatBybitPrice(limitPx, pick.spec.tickSize));
        }

        const orderRes = await bybitV5Req('POST', '/v5/order/create', orderPayload);
        await incrementHourlyTradeCount();
        await saveSvPositionMeta(pick.symbol, {
          entry: pick.price,
          direction: pick.direction,
          qty: sz.qty,
          leverage: sz.leverage,
          targetUsdt,
          estFeeUsdt: sz.estFeeUsdt,
          tpPrice,
          slPrice
        });

        await appendJournalEntry({
          type: 'SV_SCALP_OPEN',
          symbol: pick.symbol,
          direction: pick.direction,
          qty: sz.qty,
          leverage: sz.leverage,
          margin: sz.marginUsdt,
          entry: pick.price,
          tp: tpPrice,
          sl: slPrice,
          targetUsdt,
          score: pick.score,
          reasons: pick.reasons.join(', '),
          orderId: orderRes?.orderId || null
        });

        await sendTelegramAlert(
          `⚡ <b>SV SCALP ${pick.direction} (${pick.symbol})</b>\n` +
          `Entry: <code>${pick.price}</code> | Qty: ${sz.qty} (${sz.leverage}x Auto · $${sz.marginUsdt})\n` +
          `Auto TP (+$${targetUsdt.toFixed(2)} net): <code>${tpPrice}</code> | Tight SL: <code>${slPrice}</code>\n` +
          `Score: <b>${pick.score}/100</b> | ${pick.reasons.join(' · ')}`
        );

        openedTrade = { symbol: pick.symbol, direction: pick.direction, qty: sz.qty, leverage: sz.leverage, tpPrice, slPrice, orderId: orderRes?.orderId || null };
      } else {
        entrySkippedReason = sz.reason;
      }
    } else {
      entrySkippedReason = pick ? `Best SV setup ${pick.symbol} score ${pick.score} < ${minScore}` : 'No clean 1m/3m SV scalp setup right now';
    }
  }

  return {
    ok: true,
    mode: 'SV_STANDALONE',
    btc1mMovePct: +btc1mMovePct.toFixed(3),
    actions,
    openedTrade,
    entrySkippedReason,
    stats: latestStats,
    wallet: latestAcct.wallet,
    positions: latestAcct.positions
  };
}

// #20 Dedicated SV Telegram Mini-Summary
async function getSvStatusSummary() {
  const [filters, stats, pauseState, hrCount] = await Promise.all([
    getBotFilters().catch(() => ({})),
    getSvDailyStats(),
    isSvPaused(),
    getHourlyTradeCount()
  ]);
  const active = isSvModeActive(filters);
  const paper = isSvPaperMode();
  const wr = stats.trades ? ((stats.wins / stats.trades) * 100).toFixed(1) : '0.0';
  const maxHr = Number(process.env.SV_MAX_TRADES_PER_HOUR || 8);
  const dailyTgt = Number(process.env.SV_DAILY_TARGET_USDT || 2.0);
  const envLock = String(process.env.SV_MODE || '').trim();

  return (
    `⚡ *SV STANDALONE ENGINE STATUS*\n` +
    `State: *${active ? 'ON 🟢 (Exclusive Mode)' : 'OFF ⚪'}*${envLock ? ` _(Vercel Env: ${envLock})_` : ''}\n` +
    `Mode: *${paper ? 'PAPER SANDBOX' : 'LIVE AUTO'}* | Leverage/Margin: *100% AUTO*\n` +
    `Today Trades: *${stats.trades}* (${stats.wins}W / ${stats.losses}L · WR *${wr}%*)\n` +
    `Profit Cuts: *${stats.cuts}* | Net PnL: *$${stats.netPnl.toFixed(3)}* / $${dailyTgt.toFixed(2)}\n` +
    `Hourly Cap: *${hrCount}/${maxHr}* | Brake: *${pauseState.paused ? `PAUSED (${pauseState.minsLeft}m)` : 'OK'}*`
  );
}

module.exports = {
  isSvModeActive,
  isSvPaperMode,
  runSvCycle,
  getSvStatusSummary,
  getSvDailyStats
};
