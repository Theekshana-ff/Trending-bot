# ⚡ Bybit SV Ultra Pro v18.1 — Drop-In Upgrade (`Trending-bot`)

මේ ZIP file එක හදලා තියෙන්නේ ඔයාගේ **පරණ `Trending-bot` GitHub Repo එකට කෙළින්ම upload කරලා overwrite කරන්න** පුළුවන් විදියටයි — මොකුත් delete කරන්න ඕනේ නැහැ!

## Drop-in ගැළපෙන විදිය:
1. **`index.html` (Root):** පරණ `index.html` එක කෙළින්ම replace වෙනවා.
2. **`api/futures-agent.js` & `api/telegram.js`:** ඔයාගේ පරණ Telegram bot menu buttons (`History`, `Daily PnL`, `Resume`, `Emergency Stop`, `SV Status`, `Run SV Now`, `SV Mode`, `Wallet & Positions`, `Coin Heatmap`) ඔක්කොම එහෙමම වැඩ කරනවා + අලුත් Preset Switcher (`FAST $2/12x` / `TURBO $2/15x` / `SAFE $2/5x`) එකතු වෙලා තියෙනවා.
3. **`lib/securityAndState.js`:** පරණ file name එකම පාවිච්චි කරලා Upstash Redis / Vercel KV දෙකටම support වෙනවා.
4. **පරණ Vercel Environment Variables ඔක්කොම Support:** `SV_COINS`, `SV_MODE`, `SV_PROFIT_TARGET_USDT`, `BYBIT_API_KEY`, `BYBIT_API_SECRET`, `CRON_SECRET`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.
   - Testnet වල test කරන්න ඕනේ නම් විතරක් `BYBIT_TESTNET=true` දාන්න.
