# S&P 500 Earnings Countdown

A single-page web app that tracks **upcoming earnings report dates for S&P 500 companies**, sorted by a live countdown (soonest first). Search by ticker or company name, and rows reporting within 3 days are highlighted.

Built with **Next.js (App Router) + TypeScript + Tailwind CSS**, deploy-ready for Vercel.

![Sorted earnings list with live countdown](https://img.shields.io/badge/status-deploy--ready-brightgreen)

---

## How it works

- A server-side API route (`/api/earnings`) calls Financial Modeling Prep's earnings-calendar endpoint for a rolling **today → +90 day** window.
- Returned symbols are cross-referenced against a static S&P 500 constituent list ([`data/sp500.json`](data/sp500.json)) — companies not in the index, or with no upcoming date, are omitted.
- The response is **cached for 6 hours** (Next.js fetch cache) so the free FMP tier is never rate-limited.
- The homepage fetches that JSON once, then **recomputes the countdown every minute** on the client so it stays live without re-hitting the API. Reports within 48 hours show hours + minutes.
- The FMP API key stays server-side and is never exposed to the browser.

---

## 1. Get a free FMP API key

1. Go to **[financialmodelingprep.com](https://financialmodelingprep.com)** and sign up (free).
2. Open your **Dashboard → API Keys**.
3. Copy your key.

The free plan (250 requests/day) is more than enough — this app makes at most one FMP call every 6 hours.

## 2. Run locally

```bash
npm install

# create your local env file and paste your key
cp .env.example .env.local
# then edit .env.local:  FMP_API_KEY=your_key_here

npm run dev
```

Open <http://localhost:3000>.

> `.env.local` is git-ignored (see `.gitignore`) so your key is never committed.

## 3. Deploy to Vercel

1. Push this repo to GitHub.
2. In [Vercel](https://vercel.com), click **Add New → Project** and import the repo.
3. Go to **Settings → Environment Variables** and add:
   - **Name:** `FMP_API_KEY`
   - **Value:** your FMP key
   - **Environments:** Production (and Preview, if you want)
4. Click **Deploy**. (If you added the variable after the first deploy, trigger a **Redeploy** so it takes effect.)

---

## RSI Crossover Alerts (`/alerts`)

A second page scans the **combined S&P 500 + Nasdaq 100 universe** (~517 tickers, deduplicated) for a daily **RSI6-crosses-above-both-RSI12-and-RSI24** signal (Futu's default 6/12/24 periods, Wilder smoothing).

**How it runs**
- A daily **Vercel Cron** (`vercel.json`, 22:30 UTC — after US close + buffer for FMP data) hits `/api/cron/rsi-scan`.
- That route incrementally updates a per-symbol price-history cache in **Vercel KV** (fetches only new days when possible), computes RSI6/12/24, detects today-only crossovers, and writes the alert list to `rsi-alerts:latest`.
- The page reads that cached list via `/api/alerts/rsi-cross` — a fast cache read, no live computation.

**⚠️ FMP rate limit — important**
The universe is ~517 tickers ≈ 517 FMP calls/day at steady state, but the **free tier allows only 250/day**. Set **`RSI_BATCH_COUNT=3`** to split the universe across days (~172 calls/run, every symbol refreshed every 3 days) and stay under the limit. Leave it unset (`=1`, full daily scan) only on a paid FMP plan. This is documented in a comment at the top of `app/api/cron/rsi-scan/route.ts`.

**Extra setup for this feature**
1. In Vercel: **Storage → Create → KV** and connect it to the project (auto-sets `KV_REST_API_URL` / `KV_REST_API_TOKEN`).
2. Add **`CRON_SECRET`** (any long random string) in Environment Variables — the cron route rejects requests without it.
3. (Free FMP tier) Add **`RSI_BATCH_COUNT=3`**.
4. Redeploy. Trigger the first scan manually: `curl -H "Authorization: Bearer $CRON_SECRET" https://<your-app>/api/cron/rsi-scan`.

Until KV is configured, `/alerts` shows a graceful "alerts aren't available yet" state — the earnings homepage is unaffected.

## Project structure

```
app/
  api/earnings/route.ts   # server-side FMP fetch + S&P 500 cross-reference + 6h cache
  page.tsx                # homepage: sorted list, search, live countdown
  layout.tsx
  globals.css
data/
  sp500.json              # static S&P 500 constituents (symbol, name, sector)
lib/
  types.ts                # shared EarningsRow / EarningsResponse types
```

## Updating the S&P 500 list

`data/sp500.json` is a static snapshot sourced from the public
[datasets/s-and-p-500-companies](https://github.com/datasets/s-and-p-500-companies) dataset.
To refresh it, download the latest `constituents.csv` and convert the
`Symbol`, `Security`, and `GICS Sector` columns into
`{ "symbol", "name", "sector" }` objects.

## API endpoint

`GET /api/earnings` returns:

```jsonc
{
  "rows": [
    {
      "symbol": "DAL",
      "name": "Delta Air Lines",
      "sector": "Industrials",
      "earningsDate": "2026-07-09",
      "time": null,            // "bmo" | "amc" | null (stable endpoint often omits time)
      "daysRemaining": 9,
      "epsEstimated": 1.49
    }
  ],
  "count": 1,
  "generatedAt": "2026-06-30T12:00:00.000Z"
}
```

On any upstream failure the route returns `200` with `rows: []` and an `error` string, so the UI degrades gracefully instead of crashing.
