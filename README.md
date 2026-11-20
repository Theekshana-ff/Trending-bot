# Bybit V5 Live Trading Bot v3 (Hardened Live-Only Architecture)

Standalone **Bybit V5 Linear Live-Only** 6-Stage Quant Pipeline with 20 modular engines, Singapore (`sin1`) Vercel deployment, strict server-side security, and automated tests.

## Quick Verification
```bash
npm run check
npm test
```

## Required Vercel Environment Variables
- `AGENT_SECRET`
- `CRON_SECRET`
- `ALLOW_LIVE_TRADING=true`
- `BYBIT_API_KEY` (Read-Write Contract Orders & Positions, No IP restriction)
- `BYBIT_API_SECRET`
- `UPSTASH_REDIS_REST_URL` & `UPSTASH_REDIS_REST_TOKEN` (recommended)

## GitHub Actions Cron Guardian Secrets
Add `BOT_BASE_URL` (e.g. `https://your-app.vercel.app`) and `CRON_SECRET` in **GitHub Repo → Settings → Secrets and variables → Actions**.
