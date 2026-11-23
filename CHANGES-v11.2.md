# v11.2.0 – Loss-reduction fixes

1. api/futures-agent.js – coin scan no longer chases pumped coins (MAX_CHASE_24H_PCT, default 10) and ranks by healthy move x liquidity.
2. api/futures-agent.js – no blind default LONG; no clear MTF direction = NO_TRADE.
3. api/futures-agent.js – counter-trend mean-reversion flip OFF by default (ALLOW_MEAN_REVERSION_FLIP=true to enable).
4. riskAndValidation.js – leverage lowered: auto 3x-10x, coin caps 8/6/4x, hard cap MAX_LEVERAGE_CAP (default 8).
5. riskAndValidation.js – no position size-up after win streaks / best hours (only size down after losses).
6. riskAndValidation.js – risk budget (MAX_RISK_PER_TRADE_PCT) now enforced in Wallet % mode too.
7. riskAndValidation.js – final TP is 3R (was 8R); TP1 partial unchanged.
8. api/futures-agent.js – autopilot min score 80 (70 in balanced); MIN_AUTO_SCORE env can raise it.
9. tests/run-tests.js – 2 tests updated for the new limits. 19/19 pass.

New optional env vars: MAX_CHASE_24H_PCT, ALLOW_MEAN_REVERSION_FLIP, MAX_LEVERAGE_CAP, MIN_AUTO_SCORE.
Keep BYBIT_TESTNET=true and AUTO_EXECUTE=false until the backtest shows positive out-of-sample results.
