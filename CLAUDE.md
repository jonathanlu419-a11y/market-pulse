# CLAUDE.md — Market Pulse

Reference for future Claude Code sessions. Keep it current.

## Project overview
- **Market Pulse** — a personal web app with two features:
  1. **Earnings countdown** (`/`) — upcoming **S&P 500** earnings, sorted by live countdown (soonest first), searchable.
  2. **RSI crossover alerts** (`/alerts`) — daily scan of the combined **S&P 500 + Nasdaq 100** universe for an RSI6-over-RSI12/24 crossover signal.
- **Audience**: Jonathan only — solo personal project, not a team/product.

## Tech stack
- **Next.js 14+ App Router** + **TypeScript**
- **Tailwind CSS** (v4)
- **Render Postgres** (`pg`) — cache for price history + computed alerts. A **separate `market_pulse` database within the same Render Postgres instance** used by the finance-app (NOT shared tables). Replaced the former Vercel KV / Redis backend.
- **Vercel Cron** — triggers the daily RSI scan
- **Data sources (two, split by feature)**: **Twelve Data** — daily prices for the RSI **alerts** (`/time_series`, free tier). **Finnhub** — the earnings **countdown** only (`/calendar/earnings`, free tier 60 calls/min). They're independent; a key for one doesn't affect the other. (FMP was used for earnings previously but hit HTTP 429 rate limits — replaced by Finnhub.)

## Layout
```
app/
  page.tsx                     # earnings countdown homepage (client)
  alerts/page.tsx              # RSI alerts table (client)
  api/earnings/route.ts        # Finnhub /calendar/earnings, 6h cache, watchlist filter
  api/cron/rsi-scan/route.ts   # daily scan: fetch → RSI → crossover → write Postgres
  api/alerts/rsi-cross/route.ts# fast Postgres read for the /alerts page
lib/
  universe.ts                  # alerts universe = data/watchlist.json (indices tagged from index files)
  rsi.ts                       # Wilder RSI + crossover detection
  twelvedata-history.ts        # Twelve Data daily close fetch (incremental) — alerts
  db.ts                        # Render Postgres cache (graceful when unconfigured)
  types.ts                     # shared types
data/
  watchlist.json               # curated watchlist — RSI alerts AND earnings filter (symbol, name, sector) — EDIT THIS
  sp500.json                   # S&P 500 constituents — index badges only
  nasdaq100.json               # Nasdaq 100 constituents — index badges only
migrations/
  001_init_rsi_cache.sql       # price_history + rsi_alerts_latest tables
vercel.json                    # cron schedule (22:30 UTC)
```

## Key architecture decisions
- **Ticker universe (alerts)**: a small curated **watchlist** — `data/watchlist.json` (currently **16 tickers**: Mag 7 + common high-volume/momentum names), NOT the full index universe. **Edit the watchlist by editing that JSON file** (`{ symbol, name, sector }` per entry; keep it small — see the rate-limit constraint below). `lib/universe.ts` builds the universe from it and tags each with S&P500/Nasdaq100 `indices` by cross-referencing the index files (badges only). The full ~517 index universe was dropped because Twelve Data's free tier (8 credits/min) can't scan it in a serverless cron; the earlier day-batching workaround is gone.
- **Alerts data source = Twelve Data** ([lib/twelvedata-history.ts](lib/twelvedata-history.ts)): `GET https://api.twelvedata.com/time_series?symbol=&interval=1day&order=asc&start_date=|outputsize=&apikey=`. Response `{ meta, values:[{datetime,open,high,low,close,volume}], status }` — values are **strings** (parsed to numbers); errors come back as HTTP 200 `{status:"error",...}`.
  - ⚠️ **Free "Basic" tier = 8 credits/min, 800/day**; `/time_series` = **1 credit per symbol**, per-minute cap is **credits not requests** (so batching doesn't dodge it). Verified at twelvedata.com/pricing + /docs. See the big rate-limit note in the cron route.
  - **Why FMP was dropped for alerts**: its free tier returned HTTP 402 for a large, market-cap-independent fraction of symbols on the historical endpoint — unusable for a broad scan regardless of universe choice.
- **RSI**: Wilder's smoothing in [lib/rsi.ts](lib/rsi.ts). Validated against the canonical 14-period reference: **70.46 / 66.25 / 37.79**. Periods 6/12/24 match Futu's default RSI1/RSI2/RSI3.
- **Crossover definition** (`detectCrossover`): RSI6 crosses **above BOTH** RSI12 and RSI24 on the **current trading day only** — i.e. today `RSI6 > RSI12 && RSI6 > RSI24`, and yesterday it was **not** already above both. This is a **"today only" event**, not a persistent "currently above" state.
- **Postgres cache** ([lib/db.ts](lib/db.ts), schema [migrations/001_init_rsi_cache.sql](migrations/001_init_rsi_cache.sql)):
  - `price_history` table (PK `symbol`, JSONB `data`) → last ~90 daily `{date, close}` bars per symbol
  - `rsi_alerts_latest` table (single row `id=1`, JSONB `alerts`) → stores the **full** `RsiAlertsPayload` (array + scanned/universeSize/generatedAt) so the UI keeps all fields
  - ⚠️ **Use the POOLED (PgBouncer) connection string** for `MARKET_PULSE_DATABASE_URL`, not the direct one — serverless opens many short-lived connections and can exhaust `max_connections`. Pool is a module-level singleton (`max: 3`), SSL `rejectUnauthorized: false` (Render requires SSL).
- **Graceful DB degradation**: [lib/db.ts](lib/db.ts) returns null/false instead of throwing when `MARKET_PULSE_DATABASE_URL` is absent or a query fails. The `/alerts` page then shows a friendly "not available yet" state. Builds work without the DB.
- **Incremental fetch**: cron appends only new days to cached history when possible (1 Twelve Data call/ticker), full backfill only on first run per symbol; symbols already fresh for today are skipped (0 credits).

## Known constraints
- **⚠️ Twelve Data free tier = 8 credits/min (800/day).** `/time_series` is 1 credit/symbol → **max ~8 symbols/minute**. The cron paces calls **7.5s apart** and stops at **`RUN_BUDGET_MS` (50s)**, so **one run fetches ~6 symbols**. The 16-ticker watchlist therefore needs ~2 min of credits — more than one 60s run. **Cross-run progress is automatic**: already-fresh-today symbols are skipped (0 credits), so running the scan again advances to the next un-fetched symbols → **2–3 runs a few minutes apart cover the whole watchlist the same day** (`stoppedEarly:true` until it's caught up). Note: on a strictly *daily* Hobby cron, freshness resets each day and fixed order restarts, so for same-day full coverage either trigger the scan 2–3× manually, run the cron more often (Pro), keep the watchlist **≤ ~6 tickers** (true one-run, no `stoppedEarly`), or upgrade Twelve Data (credits/min ≥ watchlist size).
- **Day-batching removed**: the `RSI_BATCH_COUNT` / day-of-year slicing and `BATCH_THRESHOLD` are gone (they were a 517-ticker workaround). `RSI_BATCH_COUNT` is now **ignored**.
- **Vercel Hobby cron `maxDuration` = 60s.** The scan route sets `maxDuration = 60` and self-limits via `RUN_BUDGET_MS`.

## Env vars required
| Var | Purpose |
|-----|---------|
| `TWELVE_DATA_API_KEY` | Twelve Data key — **RSI alerts** data source. Free tier 8 credits/min, 800/day. **Only ever via `process.env`.** |
| `FINNHUB_API_KEY` | Finnhub key — **earnings countdown** only (`/calendar/earnings`, free tier 60 calls/min). **Only ever via `process.env`.** Coexists with the Twelve Data key. Replaced `FMP_API_KEY`. |
| `MARKET_PULSE_DATABASE_URL` | Render Postgres connection string for the `market_pulse` DB. **Use the POOLED/PgBouncer variant.** Separate DB in the same instance as the finance-app (not shared tables). |
| `CRON_SECRET` | Guards `/api/cron/rsi-scan`; sent by Vercel Cron as `Authorization: Bearer <value>`. |
| `RSI_BATCH_COUNT` | **Obsolete / ignored** — day-batching was removed with the switch to a small watchlist. Safe to leave unset. |
| `RSI_SCAN_DELAY_MS` | Optional; ms between symbol fetches (default 7500 = Twelve Data 8/min). |
| `RSI_SCAN_DELAY_MS` | Optional; ms between Twelve Data calls (default 7500 = 8/min). |

Local dev: copy `.env.example` → `.env.local` (git-ignored) and fill in values.

## Deployment
- **GitHub**: `jonathanlu419-a11y/market-pulse` (public).
- **Vercel (primary)**: project **`market-pulse`** under the **personal account `jonathanlu419-a11ys-projects`** (whoami `jonathanlu419-a11y`) → **https://market-pulse-tau-ten.vercel.app**
  - Dashboard: https://vercel.com/jonathanlu419-a11ys-projects/market-pulse
  - **GitHub repo IS connected** → **auto-deploy on push to `main`** works (the repo owner and this Vercel account match, so the GitHub App authorized automatically).
  - Local `.vercel/project.json` → this project (`orgId` `team_XgiPD58dVJuIqKfE0X9zTknd`).
- **Vercel (orphaned, DO NOT USE / DO NOT TOUCH)**: a **second `market-pulse` under the `eastlink` team** (https://market-pulse-mu-nine.vercel.app, orgId `team_I6oU9JiLfI7AjEGb5EnyqXaQ`) was created there by accident. Unused, left alone intentionally.
- **Vercel (prior/parallel, NOT primary, NOT deleted)**: project **`traderpwa-pro`** (also under `eastlink`) → https://traderpwa-pro.vercel.app — an earlier parallel deployment of this same codebase. Left as-is and unmanaged.
- ⚠️ **CLI account/config gotcha (critical for this machine)**: Git Bash resolves the Vercel CLI config to `AppData/Roaming/xdg.data/com.vercel.cli` (a **stale** login → `hoho2000419-6459`, whose only scope is `eastlink`). The real/personal login lives in the native path `AppData/Local/com.vercel.cli`. So from Git Bash you MUST pass `--global-config` to hit the right account:
  ```bash
  GC="C:/Users/Jonathan Lu/AppData/Local/com.vercel.cli"
  vercel whoami --global-config "$GC"        # → jonathanlu419-a11y (NOT hoho2000419-6459)
  vercel --prod   --global-config "$GC"      # deploy to personal market-pulse
  ```
  Without `--global-config`, `vercel` silently uses the wrong account and can relink to the eastlink project. Always verify `whoami` first.
- Before "done": run `npx next build` and `npx eslint app lib`.

## GitHub account note
- `gh` CLI on this machine has **two accounts**:
  - ✅ **`jonathanlu419-a11y`** — valid token, `repo` scope, **owns this repo**. Use this.
  - ❌ `jonathanluyukho-dev` — marked "default" but its token is **invalid**.
- The repo remote is **HTTPS** (SSH failed host-key verification on this machine; HTTPS + `gh` credential helper works). Don't assume the "default" account or SSH.

## Open items / next steps
- **Git connect**: ✅ DONE — repo is connected, push-to-`main` auto-deploys to the personal `market-pulse`.
- **Env vars on the personal `market-pulse`**: none set yet. Add in the dashboard (Settings → Environment Variables): `TWELVE_DATA_API_KEY` (alerts data source), `FINNHUB_API_KEY` (earnings countdown — sign up at finnhub.io), `MARKET_PULSE_DATABASE_URL` (the **pooled** Render Postgres string), `CRON_SECRET` (new random string). `RSI_BATCH_COUNT` is no longer needed (day-batching removed). `FMP_API_KEY` is no longer used anywhere.
- **Render Postgres DB not yet provisioned**: create a **separate `market_pulse` database** within the existing Render Postgres instance (same one the finance-app uses — NOT shared tables), run `migrations/001_init_rsi_cache.sql` against it, and put the **pooled** connection string in `MARKET_PULSE_DATABASE_URL`. Until set, `/alerts` shows the graceful empty state.
- **First cron run** must be triggered **manually** after the DB + `TWELVE_DATA_API_KEY` + `CRON_SECRET` are set:
  ```bash
  curl -H "Authorization: Bearer <CRON_SECRET>" https://market-pulse-tau-ten.vercel.app/api/cron/rsi-scan
  ```
  The JSON reports `scanned`, `failed`, `stoppedEarly`. With the 16-ticker watchlist expect `stoppedEarly:true` on the first run (~6 fetched); **run it 2–3× a few minutes apart** to cover the rest (already-fresh symbols are skipped, so it advances).
- **Alert universe = curated watchlist** (`data/watchlist.json`, 16 tickers) — edit that JSON to change it. Kept small to fit Twelve Data's free-tier 8-credits/min. Full S&P 500 + Nasdaq 100 index scan was dropped as infeasible on free tier.

@AGENTS.md
