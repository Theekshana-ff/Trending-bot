# Bybit V5 Live Trading Bot (v8.3.0 Hardened)


මෙය **Bybit V5 Linear Futures** සඳහා සකස් කළ 6-Stage Quant Trading Bot එකකි. Singapore (`sin1`) Vercel server එකේ deploy වන අතර, **Groq AI Live News Auto-VETO**, **Redis Safety Locks**, සහ **Automated Tests** සමඟ ක්‍රියා කරයි.

---

## පියවර 1: GitHub Setup

### 1.1 Update කළ යුතු Files (v8.3.0)
`Trending-bot-v8.3-hardened.zip` එක extract කර පහත files 9 ඔයාගේ GitHub repo එකේ replace කර **Commit** කරන්න:
- `api/futures-agent.js`
- `lib/modules/aiAgent.js`
- `lib/modules/aiBrainAndBacktest.js`
- `lib/modules/bybitLiveClient.js`
- `lib/modules/riskAndValidation.js`
- `lib/modules/securityAndState.js`
- `lib/modules/structureSmc.js`
- `tests/run-tests.js`
- `package.json`

### 1.2 GitHub Actions Secrets
**GitHub Repo → Settings → Secrets and variables → Actions** වෙත ගොස් පහත secrets 2 add කරන්න:
| Secret Name | දාන්න ඕනේ Value එක |
| :--- | :--- |
| `BOT_BASE_URL` | ඔයාගේ Vercel link එක (උදා: `https://trending0bot.vercel.app`) |
| `CRON_SECRET` | Vercel එකේ දාන `CRON_SECRET` password එකම |

---

## පියවර 2: Vercel Environment Variables

**Vercel Dashboard → Project → Settings → Environment Variables** වෙත ගොස් පහත keys ටික add කරන්න:

### A. අනිවාර්ය Keys (Core)
| Variable Name | විස්තරය |
| :--- | :--- |
| `AGENT_SECRET` | Dashboard එකට login වෙන Agent Password එක |
| `CRON_SECRET` | GitHub Actions Cron Guardian එකට දුන්න secret එකම |
| `BYBIT_API_KEY` | Bybit V5 API Key (Read-Write Contract Orders & Positions, No IP restriction) |
| `BYBIT_API_SECRET` | Bybit V5 API Secret |
| `UPSTASH_REDIS_REST_URL` | Upstash Redis URL (Live locks, nonces, halt state සඳහා අනිවාර්යයි) |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis Token |

### B. AI & Trading Controls
| Variable Name | දාන්න ඕනේ Value එක | විස්තරය |
| :--- | :--- | :--- |
| `GROQ_API_KEY` | `gsk_...` | `console.groq.com` වෙතින් ගත් නොමිලේ Groq API key එක |
| `AI_FAIL_CLOSED` | `true` | Groq AI down වුණොත් trade එක auto-block කරයි |
| `BYBIT_TESTNET` | `true` | මුලින් Testnet එකේ test කරන්න (Mainnet යද්දී `false` කරන්න) |
| `ALLOW_LIVE_TRADING` | `true` | Server-side live trading gate එක |
| `AUTO_EXECUTE` | `false` | මුලින් manual test කරන්න (Testnet pass වුණාම `true` කරන්න) |

### C. Risk Limits & Telegram (අවශ්‍ය නම්)
| Variable Name | Default Value | විස්තරය |
| :--- | :--- | :--- |
| `MAX_RISK_PER_TRADE_PCT` | `0.02` | එක trade එකකට උපරිම risk එක (2%) |
| `MAX_MARGIN_PCT` | `0.20` | එක trade එකකට උපරිම margin එක (20%) |
| `MAX_DAILY_LOSS_PCT` | `5` | දවසකට උපරිම loss සීමාව (5%) |
| `DAILY_PROFIT_TARGET_PCT` | `10` | දවසක profit lock සීමාව (10%) |
| `TELEGRAM_BOT_TOKEN` | *(optional)* | Telegram Bot Token එක |
| `TELEGRAM_CHAT_ID` | *(optional)* | Telegram Chat ID එක |

> **වැදගත්:** Vercel Environment Variables වෙනස් කළාට පස්සේ **Deployments → Redeploy** කරන්න.
>
> අලුත් Optional Vercel Environment Variables (අවශ්‍ය නම් පමණක්):
|`ENABLE_PYRAMIDING`| =true (Pyramiding ON කරන්න නම් — default false)
> |`DEAD_TRADE_HOURS`|=6 (Dead Trade Killer පැය ගණන — default 6)
> |`MACRO_BLACKOUT_WINDOWS`|=FOMC|2026-12-16T19:00:00Z (Macro news blackout times)
---

## පියවර 3: Test & Go-Live Checklist
1. **Code & Tests Check**:
   ```bash
   npm run check
   npm test
