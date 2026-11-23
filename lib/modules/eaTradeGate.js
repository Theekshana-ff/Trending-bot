// File: lib/modules/eaTradeGate.js (v14.1 — Vercel Env EA_MODE ON/OFF support)
const { getBotFilters } = require('./securityAndState');
const { runEAAnalysis } = require('./eaStrategyEngine');
const { sendTelegramAlert } = require('./telegramAlerts');

function isEaModeEnabled(filters) {
  const envVal = String(process.env.EA_MODE || '').trim().toLowerCase();
  if (envVal === 'true') return true;
  if (envVal === 'false') return false;
  return Boolean(filters && filters.eaMode === true);
}

async function evaluateBeforeTrade(symbol, intendedSide = null, minScore = 65) {
  const filters = await getBotFilters();

  if (!isEaModeEnabled(filters)) {
    return { allow: true, mode: 'NORMAL', ea: null };
  }

  const ea = await runEAAnalysis(symbol);
  const sideNorm = intendedSide ? String(intendedSide).toUpperCase() : null;
  const expectedSignal =
    sideNorm === 'LONG' || sideNorm === 'BUY' ? 'BUY'
    : sideNorm === 'SHORT' || sideNorm === 'SELL' ? 'SELL'
    : null;

  if (ea.signal === 'HOLD' || ea.qualityScore < minScore) {
    return {
      allow: false,
      mode: 'EA',
      reason: `EA filtered out (${ea.signal}, Score ${ea.qualityScore}/100)`,
      ea
    };
  }

  if (expectedSignal && ea.signal !== expectedSignal) {
    return {
      allow: false,
      mode: 'EA',
      reason: `EA direction mismatch: EA=${ea.signal} vs Bot=${expectedSignal}`,
      ea
    };
  }

  await sendTelegramAlert(
    `🧠 *EA CONFIRMED ${ea.signal} (${ea.symbol})*\n` +
    `Quality Score: *${ea.qualityScore}/100*\n` +
    `MTF: 5M *${ea.mtf['5M']}* | 15M *${ea.mtf['15M']}* | 1H *${ea.mtf['1H']}* | 4H *${ea.mtf['4H']}*\n` +
    `Suggested SL: *$${ea.suggestedSL}* | TP: *$${ea.suggestedTP}*\n` +
    `Reasons: ${ea.reasons.join(', ')}`
  );

  return { allow: true, mode: 'EA', signal: ea.signal, ea };
}

module.exports = { evaluateBeforeTrade, isEaModeEnabled };
