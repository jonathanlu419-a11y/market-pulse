# Market Pulse

Two small market tools in one Next.js app:

1. **Earnings Countdown** (`/`) — upcoming earnings dates for a curated watchlist, sorted by a live countdown (soonest first). Search by ticker/name; rows within 3 days are highlighted.
2. **RSI Crossover Alerts** (`/alerts`) — a daily scan that flags watchlist names where daily **RSI6 crosses above both RSI12 and RSI24** (Futu's default 6/12/24 periods, Wilder smoothing).

Built with **Next.js (App Router) + TypeScript + Tailwind CSS**, deploy-ready for Vercel.

![status](https://img.shields.io/badge/status-deploy--ready-brightgreen)

---

## Data sources (two, split by feature)

| Feature | Provider | Endpoint | Free-tier limit |
|---------|----------|----------|-----------------|
| Earnings countdown | **Finnhub** | `/calendar/earnings` | 60 calls/min |
| RSI alerts | **Twelve Data** | `/time_series` (`interval=1day`) | 8 credits/min, 800/day |

Both are filtered to a small curated **watchlist** ([`data/watchlist.json`](data/watchlist.json), 16 tickers). Edit that JSON to change the universe (`{ symbol, name, sector }` per entry).

## How the earnings countdown works

- `/api/earnings` makes **one** Finnhub `/calendar/earnings` call for a rolling **today → +90 day** window (the whole market), then filters to the watchlist server-side.
- Response is **cached 6 hours** so the free tier is never rate-limited; the homepage recomputes the countdown every minute client-side (reports within 48h show hours + minutes).
- On any upstream failure the route returns `200` with `rows: []` and an `error` string, so the UI degrades gracefully.

## How the RSI alerts work

- A **Vercel Cron** (`vercel.json`) hits `/api/cron/rsi-scan`, which incrementally updates a per-symbol price cache in **Render Postgres**, computes RSI, detects today-only crossovers, and writes the alert list.
- `/alerts` reads that precomputed list via `/api/alerts/rsi-cross` (fast cache read, no live compute).
- ⚠️ Twelve Data's free tier is **8 credits/min** (1 credit/symbol), so ~6 symbols fetch per cron run; already-fresh symbols are skipped, so running the scan a few times covers the watchlist. See `app/api/cron/rsi-scan/route.ts`.

---

## Run locally

```bash
npm install
cp .env.example .env.local     # then fill in the keys below
npm run dev                     # http://localhost:3000
```

`.env.local` is git-ignored, so your keys are never committed.

## Environment variables

| Var | For | How to get it |
|-----|-----|---------------|
| `FINNHUB_API_KEY` | Earnings countdown | Sign up at [finnhub.io](https://finnhub.io) → Dashboard |
| `TWELVE_DATA_API_KEY` | RSI alerts | Sign up at [twelvedata.com](https://twelvedata.com) → Dashboard |
| `MARKET_PULSE_DATABASE_URL` | RSI alerts cache | A Postgres DB (use the **pooled** connection string). Run [`migrations/001_init_rsi_cache.sql`](migrations/001_init_rsi_cache.sql) against it. |
| `CRON_SECRET` | Protects the cron route | Any long random string |

The earnings page works with just `FINNHUB_API_KEY`. The alerts page needs the Twelve Data key + database.

## Deploy to Vercel

1. Push to GitHub and import the repo in [Vercel](https://vercel.com).
2. **Settings → Environment Variables** → add the vars above (Production).
3. Deploy. Trigger the first RSI scan manually:
   ```bash
   curl -H "Authorization: Bearer $CRON_SECRET" https://<your-app>/api/cron/rsi-scan
   ```

## Project structure

```
app/
  page.tsx                     # earnings countdown homepage
  alerts/page.tsx              # RSI alerts table
  api/earnings/route.ts        # Finnhub /calendar/earnings + watchlist filter + 6h cache
  api/cron/rsi-scan/route.ts   # daily RSI scan → Render Postgres
  api/alerts/rsi-cross/route.ts# fast Postgres read for /alerts
lib/
  universe.ts                  # builds the alerts universe from watchlist.json
  rsi.ts                       # Wilder RSI + crossover detection
  twelvedata-history.ts        # Twelve Data daily-close fetch
  db.ts                        # Render Postgres cache (graceful when unconfigured)
  types.ts                     # shared types
data/
  watchlist.json               # curated watchlist (edit this)
  sp500.json / nasdaq100.json  # index membership → S&P500/Nasdaq100 badges
migrations/
  001_init_rsi_cache.sql       # price_history + rsi_alerts_latest tables
```

## API endpoint

`GET /api/earnings`:

```jsonc
{
  "rows": [
    {
      "symbol": "NVDA",
      "name": "Nvidia",
      "sector": "Information Technology",
      "earningsDate": "2026-08-25",
      "time": "amc",          // "bmo" | "amc" | null
      "daysRemaining": 55,
      "epsEstimated": 2.12
    }
  ],
  "count": 1,
  "generatedAt": "2026-07-01T12:00:00.000Z"
}
```
