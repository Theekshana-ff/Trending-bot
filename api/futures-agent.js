// File: api/futures-agent.js (v15.0 — SV MODE ONLY EDITION)
// All other modes (Normal v6, EA Mode, Ultra Pro, Groq AI) have been removed for maximum stability.

const {
  safeCompareSecret, isAuthBlocked, recordAuthFailure, clearAuthFailures,
  acquireLock, releaseLock, requireVerifiedRedis,
  getTradingHalted, setTradingHalted, getBotFilters, setBotFilters,
  appendJournalEntry, getJournalEntries, recordEquitySnapshot
} = require('../lib/modules/securityAndState');
const {
  fetchBybitWalletAndPositions, closeVerifiedLivePosition, executeLiveEmergencyStop,
  fetchBybitClosedPnlStats
} = require('../lib/modules/bybitLiveClient');
const svEngine = require('../lib/modules/svScalpEngine');
const { sendTelegramAlert } = require('../lib/modules/telegramNotifier');

const ENGINE_VERSION = 'v15.0-SV-ONLY';

function makeResponse(ok, payload = {}, meta = {}) {
  return {
    ok,
    engineVersion: ENGINE_VERSION,
    timestamp: new Date().toISOString(),
    ...meta,
    ...payload
  };
}

function isServerLiveAuthorized() {
  return String(process.env.ALLOW_LIVE_TRADING || '').trim().toLowerCase() === 'true';
}

function isAutoExecuteEnabled() {
  return String(process.env.AUTO_EXECUTE || '').trim().toLowerCase() === 'true';
}

function getClientIp(req) {
  const fwd = req.headers?.['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return String(req.socket?.remoteAddress || 'unknown');
}

function verifyAgentSecret(req) {
  const expected = (process.env.AGENT_SECRET || '').trim();
  const provided = String(
    req.headers?.['x-agent-secret'] ||
    req.body?.agentSecret ||
    req.query?.agentSecret || ''
  ).trim();
  if (!expected) return { ok: false, reason: 'AGENT_SECRET not configured on server.' };
  if (!safeCompareSecret(provided, expected)) return { ok: false, reason: 'Invalid AGENT_SECRET.' };
  return { ok: true };
}

module.exports = async (req, res) => {
  try {
    res.setHeader('Content-Type', 'application/json');
    const clientIp = getClientIp(req);
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const action = String(req.query?.action || body.action || 'health').trim().toLowerCase();

    // 1. Public Health Check (used by GitHub Actions)
    if (action === 'health') {
      const redisOk = (await requireVerifiedRedis()).ok;
      return res.status(200).json(makeResponse(true, {
        status: 'SV_ONLY_ONLINE',
        mode: 'SV_STANDALONE',
        redisOk,
        svPaperMode: svEngine.isSvPaperMode(),
        autoExecute: isAutoExecuteEnabled(),
        liveAuthorized: isServerLiveAuthorized()
      }));
    }

    // 2. Cron Guardian Tick (GitHub Actions / cron-job.org)
    if (action === 'cron_tick') {
      if (isAuthBlocked(clientIp)) {
        return res.status(429).json(makeResponse(false, { error: 'Too many failed auth attempts.' }, { errorCode: 'RATE_LIMITED' }));
      }
      const expectedCron = (process.env.CRON_SECRET || '').trim();
      const providedCron = String(
        req.headers?.['x-cron-secret'] ||
        req.headers?.authorization?.replace(/^Bearer\s+/i, '') || ''
      ).trim();

      if (!expectedCron || !safeCompareSecret(providedCron, expectedCron)) {
        recordAuthFailure(clientIp);
        return res.status(401).json(makeResponse(false, { error: 'Unauthorized: Valid CRON_SECRET required.' }, { errorCode: 'CRON_UNAUTHORIZED' }));
      }
      clearAuthFailures(clientIp);

      const lock = await acquireLock('bybit_sv_cron_lock', 35000);
      if (!lock.acquired) {
        return res.status(409).json(makeResponse(false, { error: lock.reason }, { errorCode: 'CRON_LOCKED' }));
      }

      try {
        const [filters, haltedState] = await Promise.all([
          getBotFilters().catch(() => ({})),
          getTradingHalted()
        ]);

        if (!svEngine.isSvModeActive(filters)) {
          return res.status(200).json(makeResponse(true, {
            svEngine: { ok: true, skipped: true, reason: 'SV_MODE is OFF' }
          }));
        }

        const svRes = await svEngine.runSvCycle({
          halted: Boolean(haltedState.halted),
          autoExecute: isAutoExecuteEnabled(),
          liveAuthorized: isServerLiveAuthorized()
        });

        if (svRes?.wallet?.totalEquity != null) {
          await recordEquitySnapshot(svRes.wallet.totalEquity).catch(() => {});
        }

        return res.status(200).json(makeResponse(true, { svEngine: svRes }));
      } finally {
        await releaseLock('bybit_sv_cron_lock', lock.token).catch(() => {});
      }
    }

    // 3. Dashboard / Manual Protected Actions (Require AGENT_SECRET)
    if (isAuthBlocked(clientIp)) {
      return res.status(429).json(makeResponse(false, { error: 'Too many failed auth attempts. Try again in 10 minutes.' }, { errorCode: 'RATE_LIMITED' }));
    }
    const auth = verifyAgentSecret(req);
    if (!auth.ok) {
      recordAuthFailure(clientIp);
      return res.status(401).json(makeResponse(false, { error: auth.reason }, { errorCode: 'UNAUTHORIZED' }));
    }
    clearAuthFailures(clientIp);

    if (action === 'status') {
      const [acct, filters, halted, svStats, pnlStats, journal] = await Promise.all([
        fetchBybitWalletAndPositions(),
        getBotFilters().catch(() => ({})),
        getTradingHalted(),
        svEngine.getSvDailyStats(),
        fetchBybitClosedPnlStats(30).catch(() => ({ recent: [], winRate: 0, wins: 0, losses: 0, netPnl: 0 })),
        getJournalEntries().catch(() => [])
      ]);

      return res.status(200).json(makeResponse(true, {
        svActive: svEngine.isSvModeActive(filters),
        svPaperMode: svEngine.isSvPaperMode(),
        svEnvLock: String(process.env.SV_MODE || '').trim() || null,
        autoExecute: isAutoExecuteEnabled(),
        liveAuthorized: isServerLiveAuthorized(),
        halted: Boolean(halted.halted),
        svStats,
        pnlStats,
        journal: (journal || []).slice(-25).reverse(),
        ...acct
      }));
    }

    if (action === 'run_sv_now') {
      const lock = await acquireLock('bybit_sv_cron_lock', 35000);
      if (!lock.acquired) {
        return res.status(409).json(makeResponse(false, { error: lock.reason }));
      }
      try {
        const [filters, haltedState] = await Promise.all([
          getBotFilters().catch(() => ({})),
          getTradingHalted()
        ]);
        if (!svEngine.isSvModeActive(filters)) {
          return res.status(200).json(makeResponse(false, { error: 'SV_MODE is OFF. Enable SV_MODE first.' }));
        }
        const svRes = await svEngine.runSvCycle({
          halted: Boolean(haltedState.halted),
          autoExecute: isAutoExecuteEnabled(),
          liveAuthorized: isServerLiveAuthorized()
        });
        return res.status(200).json(makeResponse(true, { svEngine: svRes }));
      } finally {
        await releaseLock('bybit_sv_cron_lock', lock.token).catch(() => {});
      }
    }

    if (action === 'toggle_sv_mode') {
      const envLock = String(process.env.SV_MODE || '').trim().toLowerCase();
      if (envLock === 'true' || envLock === 'false') {
        return res.status(400).json(makeResponse(false, {
          error: `SV_MODE is locked to ${envLock.toUpperCase()} via Vercel Environment Variables.`
        }));
      }
      const current = (await getBotFilters().catch(() => ({}))) || {};
      const nextVal = typeof body.svMode === 'boolean' ? body.svMode : !svEngine.isSvModeActive(current);
      await setBotFilters({ ...current, svMode: nextVal });
      await appendJournalEntry({ type: 'UI_SV_MODE_TOGGLE', svMode: nextVal });
      return res.status(200).json(makeResponse(true, { svActive: nextVal }));
    }

    if (action === 'emergency_stop') {
      await setTradingHalted(true);
      const stopRes = await executeLiveEmergencyStop();
      await appendJournalEntry({ type: 'UI_EMERGENCY_STOP', ...stopRes });
      await sendTelegramAlert(`🚨 <b>SV EMERGENCY STOP (Dashboard)</b>\nClosed ${stopRes.closedCount} positions. Trading HALTED.`);
      return res.status(200).json(makeResponse(true, { halted: true, ...stopRes }));
    }

    if (action === 'resume_trading') {
      await setTradingHalted(false);
      await appendJournalEntry({ type: 'UI_RESUME_TRADING' });
      return res.status(200).json(makeResponse(true, { halted: false }));
    }

    if (action === 'close_position' && body.symbol) {
      const sym = String(body.symbol).toUpperCase().replace(/[^A-Z0-9]/g, '');
      const closeRes = await closeVerifiedLivePosition(sym);
      await appendJournalEntry({ type: 'UI_MANUAL_CLOSE', symbol: sym, ...closeRes });
      return res.status(200).json(makeResponse(true, { closeRes }));
    }

    return res.status(400).json(makeResponse(false, { error: `Unknown action: ${action}` }));
  } catch (err) {
    console.error('[SV_AGENT_ERR]', err.message);
    return res.status(500).json(makeResponse(false, { error: err.message }));
  }
};
