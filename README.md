# Bybit V5 — SV ULTRA PRO Bot (v16.0)

**SV Mode Only — Ultra Pro v16.0** (`$2 Margin × 18x Leverage → $0.10 Net Cut` default Pro preset)

## Ultra Pro v16.0 Upgrades
1. **High-Speed Auto-Leverage Ladder (`12x–18x`)** — Auto-adjusts by 1m volatility.
2. **Smart Maker-First Entry (`SV_MAKER_ENTRY=true`)** — PostOnly Limit order at Best Bid/Ask (saves ~60% fees) with instant Market IOC fallback.
3. **One-Tap Power Presets (`/sv_preset` & Dashboard):**
   - `🐢 Safe` ($1.5 / 6x–10x / $0.10 net)
   - `⚡ Pro` ($2.0 / 12x–18x / $0.10 net — Default)
   - `🔥 Turbo` ($3.0 / 14x–20x / $0.12 net)
4. **Step-Trailing Profit Lock:** `+$0.06` → SL to BE (`+$0.01`); `+$0.09` → SL to `+$0.05`.
5. **Anti-Wick Liquidation Shield:** Hard Exchange SL within `1.0%–1.2%` & max `$0.35` (Pro).
6. **Smart Recovery Leverage:** Drops to `10x` after a loss, returns to `18x` on win.
7. **Auto-Compounding SV Margin:** Scales `$2` margin up automatically as balance grows.
8. **Live SV 1m Coin Heatmap** on Dashboard & Telegram (`/heatmap`).
9. **Daily Gross vs Fees vs Net Report** in `/sv_status` & end-of-day Telegram alert.
10. **1-Minute Turbo Cron Optimization** (20s lock TTL for `cron-job.org` 1m triggers).
