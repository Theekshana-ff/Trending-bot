// lib/riskGuardian.js — Exchange Closed-PnL Sync, Daily Shields, Auto-Blacklist & Auto-Breakeven

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

export async function syncExchangeClosedPnl(bybit, store) {
  const day = todayKey();
  const syncedKey = `v18:synced:${day}`;
  const res = await bybit.getClosedPnL(20);
  const list = res?.result?.list || [];
  const alreadySynced = new Set((await store.smembers(syncedKey)) || []);

  const dayStartMs = Date.parse(`${day}T00:00:00.000Z`);
  let newTrades = 0;
  let newWins = 0;
  let newLosses = 0;
  let newNetPnl = 0;

  const fresh = [...list].reverse().filter((item) => {
    const id = String(item.orderId || item.updatedTime);
    const ts = Number(item.updatedTime || 0);
    return ts >= dayStartMs && !alreadySynced.has(id);
  });

  for (const item of fresh) {
    const id = String(item.orderId || item.updatedTime);
    const pnl = Number(item.closedPnl || 0);
    const sym = item.symbol;
    await store.sadd(syncedKey, id);

    newTrades += 1;
    newNetPnl += pnl;

    if (pnl > 0) {
      newWins += 1;
      await store.set(`v18:consec_losses:${day}`, '0', 86400);
    } else if (pnl < 0) {
      newLosses += 1;
      await store.incrby(`v18:consec_losses:${day}`, 1);
      const coinLosses = await store.incrby(`v18:coin_losses:${day}:${sym}`, 1);
      if (Number(coinLosses) >= 2) {
        await store.sadd(`v18:blacklist:${day}`, sym);
      }
    }
  }

  if (newTrades > 0) {
    await store.incrby(`v18:trades:${day}`, newTrades);
    await store.incrby(`v18:wins:${day}`, newWins);
    await store.incrby(`v18:losses:${day}`, newLosses);
    await store.incrbyfloat(`v18:pnl:${day}`, newNetPnl);
  }

  return getDailyStats(store);
}

export async function getDailyStats(store) {
  const day = todayKey();
  const trades = Number((await store.get(`v18:trades:${day}`)) || 0);
  const wins = Number((await store.get(`v18:wins:${day}`)) || 0);
  const losses = Number((await store.get(`v18:losses:${day}`)) || 0);
  const netPnl = Number((await store.get(`v18:pnl:${day}`)) || 0);
  const consecLosses = Number((await store.get(`v18:consec_losses:${day}`)) || 0);
  const blacklist = (await store.smembers(`v18:blacklist:${day}`)) || [];
  const winRate = trades > 0 ? Number(((wins / trades) * 100).toFixed(1)) : 0;

  return {
    day,
    trades,
    wins,
    losses,
    winRate,
    netPnl: Number(netPnl.toFixed(4)),
    consecLosses,
    blacklist,
  };
}

export function checkRiskShields(stats, config) {
  if (stats.netPnl <= -Math.abs(config.maxDailyLossUsdt)) {
    return {
      allowed: false,
      reason: `DAILY_MAX_LOSS_SHIELD (${stats.netPnl.toFixed(3)} <= -${config.maxDailyLossUsdt})`,
    };
  }
  if (stats.consecLosses >= config.maxConsecutiveLosses) {
    return {
      allowed: false,
      reason: `CONSECUTIVE_LOSS_SHIELD (${stats.consecLosses}/${config.maxConsecutiveLosses} losses today)`,
    };
  }
  return { allowed: true, reason: 'OK' };
}

export async function isCoinBlocked(store, symbol) {
  const day = todayKey();
  const bl = (await store.smembers(`v18:blacklist:${day}`)) || [];
  if (bl.includes(symbol)) return { blocked: true, reason: 'AUTO_BLACKLISTED_TODAY' };
  const cd = await store.get(`v18:cooldown:${symbol}`);
  if (cd) return { blocked: true, reason: 'COOLDOWN_ACTIVE' };
  return { blocked: false };
}

export async function setCoinCooldown(store, symbol, minutes = 3) {
  await store.set(`v18:cooldown:${symbol}`, '1', Math.max(60, Math.round(minutes * 60)));
}

export async function protectOpenPosition(bybit, store, position) {
  const size = Number(position.size || 0);
  if (size <= 0) return { action: 'NONE' };

  const symbol = position.symbol;
  const entry = Number(position.avgPrice || 0);
  const mark = Number(position.markPrice || 0);
  const tp = Number(position.takeProfit || 0);
  const sl = Number(position.stopLoss || 0);
  const isLong = position.side === 'Buy';

  if (!entry || !mark || !tp) return { action: 'NO_TP_SET' };

  const progress = isLong
    ? (mark - entry) / (tp - entry)
    : (entry - mark) / (entry - tp);

  const beKey = `v18:be_moved:${symbol}:${entry}`;
  const alreadyMoved = await store.get(beKey);

  if (progress >= 0.55 && !alreadyMoved) {
    const bePrice = isLong ? entry * 1.0014 : entry * 0.9986;
    const improvesSl = !sl || (isLong ? bePrice > sl : bePrice < sl);

    if (improvesSl) {
      const decimals = String(entry).split('.')[1]?.length || 4;
      const formatted = Number(bePrice.toFixed(decimals));
      await bybit.setTradingStop({ symbol, stopLoss: formatted });
      await store.set(beKey, '1', 86400);
      return { action: 'MOVED_SL_TO_BE', symbol, bePrice: formatted, progressPct: Math.round(progress * 100) };
    }
  }

  return { action: 'HOLDING', progressPct: Math.round(progress * 100) };
}

export async function recordEquityPoint(store, equityUsdt, maxPoints = 60) {
  if (!equityUsdt || Number.isNaN(Number(equityUsdt))) return;
  const point = JSON.stringify({
    t: new Date().toISOString().slice(11, 16),
    v: Number(Number(equityUsdt).toFixed(3)),
  });
  await store.rpush('v18:equity_curve', point);
  await store.ltrim('v18:equity_curve', -maxPoints, -1);
}

export async function getEquityCurve(store) {
  const raw = (await store.lrange('v18:equity_curve', 0, -1)) || [];
  return raw
    .map((item) => {
      try { return typeof item === 'string' ? JSON.parse(item) : item; }
      catch { return null; }
    })
    .filter(Boolean);
}
