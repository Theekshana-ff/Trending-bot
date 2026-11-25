# Bybit V5 — SV MODE ONLY Bot (v15.0)

මෙය **Bybit V5 Linear Futures** සඳහා **SV Mode පමණක්** ක්‍රියාත්මක වන පිරිසිදු **Standalone 1m/3m Micro-Scalping Bot** එකකි.
අනෙකුත් සියලුම modes (Normal v6, EA Mode, Ultra Pro, Groq AI) සම්පූර්ණයෙන්ම ඉවත් කර ඇති නිසා කිසිදු mode conflict එකක් ඇති නොවේ.

---

## ප්‍රධාන විශේෂාංග (SV Mode Only)
- **100% Auto Leverage & Auto Margin:** Balance එක සහ 1m volatility අනුව ඉබේම ආරක්ෂිත leverage (`3x–8x`) සහ margin ගණනය වේ.
- **Net-of-Fee Profit Cut (`$0.10`+):** Bybit fees කැපුණාට පසු ශුද්ධ `$0.10` (හෝ balance-scaled target) ලැබෙන ගාණටම Exchange-level Auto TP තබයි; profit cut වූ වහාම ඊළඟ හොඳම trade එක open කරයි.
- **All 40 SV Micro-Scalping Updates:** 1m/3m EMA 9/21 + VWAP, Fast RSI(7) + StochRSI, Heikin Ashi smoothing, Bollinger Bounce, 1m FVG Tap, OBI Micro-Burst, Micro-Spread Guard, BTC 1m Pulse Sync, BTC Flash Emergency Exit, 5m Same-Coin Cooldown, 3-Loss 30m Brake, Daily Target Lock, සහ Telegram Control Panel.

---

## Vercel Environment Variables

**Vercel Dashboard → Project → Settings → Environment Variables** වෙත ගොස් පහත keys set කර **Redeploy** කරන්න:

### A. අනිවාර්ය Keys (Core)
| Variable Name | විස්තරය |
| :--- | :--- |
| `AGENT_SECRET` | Dashboard login password එක |
| `CRON_SECRET` | GitHub Actions / cron-job.org secret එක |
| `BYBIT_API_KEY` | Bybit V5 API Key (Contract Orders & Positions) |
| `BYBIT_API_SECRET` | Bybit V5 API Secret |
| `UPSTASH_REDIS_REST_URL` | Upstash Redis URL |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis Token |
| `ALLOW_LIVE_TRADING` | `true` (Live trading gate) |
| `AUTO_EXECUTE` | `true` (Auto scalping ON කිරීමට) |
| `BYBIT_TESTNET` | `false` (Mainnet) හෝ `true` (Testnet) |

### B. Telegram Keys
| Variable Name | විස්තරය |
| :--- | :--- |
| `TELEGRAM_BOT_TOKEN` | Telegram Bot Token එක |
| `TELEGRAM_CHAT_ID` | ඔයාගේ Telegram Chat ID එක |
| `TELEGRAM_WEBHOOK_SECRET` | Webhook security secret token එක (Fail-closed) |

### C. SV Mode Controls (Optional)
| Variable Name | Default | විස්තරය |
| :--- | :--- | :--- |
| `SV_MODE` | *(unset = ON)* | `true` හෝ `false` (මෙය නොදැම්මොත් Telegram `⚡ SV Mode` button එකෙන් ON/OFF කළ හැක) |
| `SV_PROFIT_TARGET_USDT` | `0.10` | Fixed profit cut target (USDT). Unset නම් balance අනුව auto scale වේ |
| `SV_DAILY_TARGET_USDT` | `2.0` | දවසේ profit lock සීමාව |
| `SV_PAPER_MODE` | `false` | `true` දැම්මොත් `$100` virtual balance එකක paper test කළ හැක |
| `SV_MAX_TRADES_PER_HOUR` | `8` | පැයකට උපරිම trades ගණන |
| `SV_MAX_HOLD_MIN` | `15` | Stagnant trade එකක් auto-close වන විනාඩි ගණන |
| `SV_COINS` | `BTC,ETH,SOL,XRP,DOGE` | Scan කරන high-liquidity coins |

---

## Telegram Webhook Register කිරීම
```text
https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://<YOUR_VERCEL_DOMAIN>/api/telegram-webhook&secret_token=<TELEGRAM_WEBHOOK_SECRET>
```
