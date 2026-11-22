// File: api/futures-agent.js (v12.4 — Fixed Qty Invalid + EA Mode ON/OFF Gate)
const {
  getTradingHalted,
  getBotFilters,
  appendJournalEntry
} = require('../lib/modules/securityAndState');
const bybitClient = require('../lib/modules/bybitLiveClient');
const bybitEaHelpers = require('../lib/modules/bybitEaHelpers');
const { evaluateBeforeTrade } = require('../lib/modules/eaTradeGate');
const {
  alertTradeOpened,
  alertMarginWarning,
  alertSystemError
} = require('../lib/modules/telegramAlerts');

const DEFAULT_SYMBOLS = ['SOLUSDT', 'ETHUSDT', 'BTCUSDT'];

async function getSimpleNormalSignal(symbol) {
  const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=15&limit=30`;
  const resp = await fetch(url);
  if (!resp.ok) return { signal: 'HOLD', price: 0 };
  const data = await resp.json();
  const list = (data?.result?.list || []).slice(1).reverse();
  if (list.length < 22) return { signal: 'HOLD', price: 0 };

  const closes = list.map(c => Number(c[4]));
  const lastPrice = closes[closes.length - 1];
  const sma7 = closes.slice(-7).reduce((a, b) => a + b, 0) / 7;
  const sma21 = closes.slice(-21).reduce((a, b) => a + b, 0) / 21;

  if (sma7 > sma21 * 1.001) return { signal: 'BUY', price: lastPrice };
  if (sma7 < sma21 * 0.999) return { signal: 'SELL', price: lastPrice };
  return { signal: 'HOLD', price: lastPrice };
}

module.exports = async (req, res) => {
  try {
    const halted = await getTradingHalted();
    if (halted && halted.halted) {
      return res.status(200).json({ ok: true, skipped: true, reason: 'Trading is HALTED' });
    }

    const filters = (await getBotFilters()) || {};
    const eaMode = Boolean(filters.eaMode);
    const riskPct = Number(filters.riskPct || 2);
    const leverage = Number(filters.leverage || 5);
    const symbols = Array.isArray(filters.symbols) && filters.symbols.length
      ? filters.symbols
      : DEFAULT_SYMBOLS;

    const acct = await bybitClient.fetchBybitWalletAndPositions();
    const avail = Number(acct?.wallet?.availableBalance || 0);
    const equity = Number(acct?.wallet?.totalEquity || 0);
    const openPositions = acct?.positions || [];

    if (equity > 0 && avail / equity < 0.15) {
      await alertMarginWarning(avail, equity);
    }

    if (openPositions.length >= 2) {
      return res.status(200).json({
        ok: true,
        skipped: true,
        reason: `Max open positions reached (${openPositions.length})`
      });
    }

    const openSymbols = new Set(openPositions.map(p => String(p.symbol).toUpperCase()));
    const results = [];

    for (const sym of symbols) {
      if (openSymbols.has(sym)) continue;

      let chosenSide = 'HOLD';
      let entryPrice = 0;
      let sl = null;
      let tp = null;
      let eaScore = null;

      if (eaMode) {
        const gate = await evaluateBeforeTrade(sym, null, 65);
        if (!gate.allow) {
          results.push({ symbol: sym, action: 'SKIPPED', mode: 'EA', reason: gate.reason });
          continue;
        }
        chosenSide = gate.signal;
        entryPrice = gate.ea.price;
        sl = gate.ea.suggestedSL;
        tp = gate.ea.suggestedTP;
        eaScore = gate.ea.qualityScore;
      } else {
        const normal = await getSimpleNormalSignal(sym);
        if (normal.signal === 'HOLD') {
          results.push({ symbol: sym, action: 'HOLD', mode: 'NORMAL' });
          continue;
        }
        chosenSide = normal.signal;
        entryPrice = normal.price;
        sl = chosenSide === 'BUY'
          ? Number((entryPrice * 0.99).toFixed(4))
          : Number((entryPrice * 1.01).toFixed(4));
        tp = chosenSide === 'BUY'
          ? Number((entryPrice * 1.02).toFixed(4))
          : Number((entryPrice * 0.98).toFixed(4));
      }

      // Position sizing + exact Bybit qtyStep formatting
      const marginToUse = Math.max(5, avail * (riskPct / 100));
      const notional = marginToUse * leverage;
      const rawQty = entryPrice > 0 ? notional / entryPrice : 0;
      const qtyCheck = await bybitEaHelpers.formatValidBybitQty(sym, rawQty);

      if (!qtyCheck.valid) {
        results.push({ symbol: sym, action: 'SKIPPED', reason: `Invalid qty (${qtyCheck.qty})` });
        continue;
      }

      const bybitSide = chosenSide === 'BUY' ? 'Buy' : 'Sell';
      let orderRes;
      if (typeof bybitClient.openVerifiedLivePosition === 'function') {
        orderRes = await bybitClient.openVerifiedLivePosition({
          symbol: sym,
          side: bybitSide,
          qty: Number(qtyCheck.qty),
          leverage,
          stopLoss: sl,
          takeProfit: tp
        });
      } else {
        orderRes = await bybitEaHelpers.placeMarketOrder({
          symbol: sym,
          side: bybitSide,
          qty: qtyCheck.qty,
          stopLoss: sl,
          takeProfit: tp
        });
      }

      await appendJournalEntry({
        type: eaMode ? 'EA_TRADE_OPENED' : 'NORMAL_TRADE_OPENED',
        symbol: sym,
        side: bybitSide,
        qty: qtyCheck.qty,
        entryPrice,
        sl,
        tp,
        eaScore
      });

      await alertTradeOpened({
        symbol: sym,
        side: bybitSide,
        qty: qtyCheck.qty,
        entryPrice,
        leverage,
        sl,
        tp,
        eaScore
      });

      results.push({ symbol: sym, action: 'OPENED', mode: eaMode ? 'EA' : 'NORMAL', side: bybitSide, qty: qtyCheck.qty, orderRes });
      break;
    }

    return res.status(200).json({ ok: true, eaMode, results });
  } catch (err) {
    console.error('[FUTURES_AGENT_ERR]', err.message);
    await alertSystemError('futures-agent', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
