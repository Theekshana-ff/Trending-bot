# v12.0.0 – Update 25 (builds on v11.2.0 fixes)

Corrections to v11.2.0:
- Final TP restored to 8R. The real exits are the 2R / 4R partial ladder + ATR runner; a 3R exchange TP would have cut the runner.

New in Update 25:
- Limit-order chasing is OFF by default (ENABLE_LIMIT_CHASE=true to re-enable): chasing entered late with the old SL.
- Stale unfilled limit orders cancel after 30 min (was 45; LIMIT_MAX_AGE_MIN).
- Node engine 26.x -> 22.x (package.json + CI) for Vercel compatibility.
- healthyMoveScore moved to riskAndValidation.js and unit-tested.
- New test covering: no size-up on wins, size-down on losses, leverage cap, chase OFF, coin ranking.

Still NOT done: no out-of-sample backtest has been run; profit is not guaranteed. Keep BYBIT_TESTNET=true / AUTO_EXECUTE=false until validated.

# v12.1.0 – Update 26 (full code scan)
Security
- Telegram webhook now verifies X-Telegram-Bot-Api-Secret-Token (TELEGRAM_WEBHOOK_SECRET). Before, anyone who knew the chat id could forge /stop /resume /nexttrade. Fail-closed if unset.
- Secret comparison no longer leaks length (SHA-256 + timingSafeEqual).
- Failed AGENT_SECRET / CRON_SECRET attempts throttled (8 fails -> 10 min block per IP).
- In-memory rate-limit map no longer grows forever.
- Dashboard escapes server data before innerHTML; nonce uses crypto.getRandomValues.
- /price symbol sanitized.
Logic
- Partial TP: position size kept accurate within the same tick (TP2 / dead-trade / pyramid).
- Split order #2 failure is now reported (Telegram + API result) instead of swallowed.
Tests: 21 pass.
