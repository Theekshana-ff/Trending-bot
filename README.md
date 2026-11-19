# Bybit V5 Live Trading Bot (Standalone)

6-Stage Quant Pipeline (`Scanner -> Safety Gate -> Sizer -> Live Bybit Executor -> Logger -> Real Equity`).
**Live Bybit V5 Linear only** — no paper trading mode.

## Deploy to Vercel
1. Create a new GitHub repository (e.g. `bybit-trading-bot`) and upload all files from this ZIP.
2. Import the repository into Vercel.
3. Add these Environment Variables in **Vercel -> Settings -> Environment Variables**:
   - `AGENT_SECRET` (your dashboard login password)
   - `ALLOW_LIVE_TRADING` = `true`
   - `BYBIT_API_KEY`
   - `BYBIT_API_SECRET`
   - `UPSTASH_REDIS_REST_URL` (optional)
   - `UPSTASH_REDIS_REST_TOKEN` (optional)
4. Redeploy and open your Vercel URL.
