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
- **Data sources (two, split by feature)**: **Twelve Data** — daily prices for the RSI **alerts** (`/time_series`, free tier). **FMP (Financial Modeling Prep)** — the earnings **countdown** only. They're independent; a key for one doesn't affect the other.

## Layout
```
app/
  page.tsx                     # earnings countdown homepage (client)
  alerts/page.tsx              # RSI alerts table (client)
  api/earnings/route.ts        # FMP earnings-calendar, 6h cache, S&P500 cross-ref
  api/cron/rsi-scan/route.ts   # daily scan: fetch → RSI → crossover → write Postgres
  api/alerts/rsi-cross/route.ts# fast Postgres read for the /alerts page
lib/
  universe.ts                  # merges sp500 + nasdaq100 → deduped universe
  rsi.ts                       # Wilder RSI + crossover detection
  twelvedata-history.ts        # Twelve Data daily close fetch (incremental) — alerts
  db.ts                        # Render Postgres cache (graceful when unconfigured)
  types.ts                     # shared types
data/
  sp500.json                   # S&P 500 constituents (symbol, name, sector)
  nasdaq100.json               # Nasdaq 100 constituents
migrations/
  001_init_rsi_cache.sql       # price_history + rsi_alerts_latest tables
vercel.json                    # cron schedule (22:30 UTC)
```

## Key architecture decisions
- **Ticker universe (alerts)**: **S&P 500 + Nasdaq 100 combined** (~517), merged/deduped at runtime in `lib/universe.ts`. **Provisional** — restored after switching the alerts data source to Twelve Data. It had been narrowed to Nasdaq-100-only to dodge **FMP's** free-tier per-symbol HTTP 402s, which turned out **not to correlate with market cap or index membership** (both the full S&P 500 and the Nasdaq-100-only sets showed similarly high FMP failure rates) — that was an FMP problem, hence the provider switch. Pending a fail-rate test on Twelve Data; scale back to Nasdaq-100-only (drop the `sp500` import + `add()` loop in `lib/universe.ts`) if needed.
- **Alerts data source = Twelve Data** ([lib/twelvedata-history.ts](lib/twelvedata-history.ts)): `GET https://api.twelvedata.com/time_series?symbol=&interval=1day&order=asc&start_date=|outputsize=&apikey=`. Response `{ meta, values:[{datetime,open,high,low,close,volume}], status }` — values are **strings** (parsed to numbers); errors come back as HTTP 200 `{status:"error",...}`.
  - ⚠️ **Free "Basic" tier = 8 credits/min, 800/day**; `/time_series` = **1 credit per symbol**, per-minute cap is **credits not requests** (so batching doesn't dodge it). Verified at twelvedata.com/pricing + /docs. See the big rate-limit note in the cron route.
  - **Why FMP was dropped for alerts**: its free tier returned HTTP 402 for a large, market-cap-independent fraction of symbols on the historical endpoint — unusable for a broad scan regardless of universe choice.
- **RSI**: Wilder's smoothing in [lib/rsi.ts](lib/rsi.ts). Validated against the canonical 14-period reference: **70.46 / 66.25 / 37.79**. Periods 6/12/24 match Futu's default RSI1/RSI2/RSI3.
- **Crossover definition** (`detectCrossover`): RSI6 crosses **above BOTH** RSI12 and RSI24 on the **current trading day only** — i.e. today `RSI6 > RSI12 && RSI6 > RSI24`, and yesterday it was **not** already above both. This is a **"today only" event**, not a persistent "currently above" state.
- **Postgres cache** ([lib/db.ts](lib/db.ts), schema [migrations/001_init_rsi_cache.sql](migrations/001_init_rsi_cache.sql)):
  - `price_history` table (PK `symbol`, JSONB `data`) → last ~90 daily `{date, close}` bars per symbol
  - `rsi_alerts_latest` table (single row `id=1`, JSONB `alerts`) → stores the **full** `RsiAlertsPayload` (array + scanned/universeSize/batch/generatedAt) so the UI keeps all fields
  - ⚠️ **Use the POOLED (PgBouncer) connection string** for `MARKET_PULSE_DATABASE_URL`, not the direct one — serverless opens many short-lived connections and can exhaust `max_connections`. Pool is a module-level singleton (`max: 3`), SSL `rejectUnauthorized: false` (Render requires SSL).
- **Graceful DB degradation**: [lib/db.ts](lib/db.ts) returns null/false instead of throwing when `MARKET_PULSE_DATABASE_URL` is absent or a query fails. The `/alerts` page then shows a friendly "not available yet" state. Builds work without the DB.
- **Incremental fetch**: cron appends only new days to cached history when possible (1 Twelve Data call/ticker), full backfill only on first run per symbol; symbols already fresh for today are skipped (0 credits).

## Known constraints
- **⚠️ Twelve Data free tier = 8 credits/min (800/day) — the real blocker.** `/time_series` is 1 credit/symbol, so **max ~8 symbols/minute**. A Vercel cron function can't stay alive long enough to fetch a large universe (~517 ≈ 65 min, ~101 ≈ 13 min ≫ the 60s limit). The cron route paces calls **7.5s apart** and stops each run at **`RUN_BUDGET_MS` (50s)** — so **one run only covers ~6 symbols**. Full coverage of a large universe on the free tier requires setting `RSI_BATCH_COUNT` high (≈ `ceil(universe/6)`) so each day scans a rotating 1/N slice by day-of-year — but then a symbol is only refreshed every N days, making "today's crossover" N-days-stale. **For reliable daily full-universe alerts: upgrade Twelve Data** (a plan with credits/min ≥ universe size lets one batch call fetch everyone in seconds) **or keep the universe ≤ ~6 symbols.** `BATCH_THRESHOLD` (200) still auto-disables batching for small universes.
- **Vercel Hobby cron `maxDuration` = 60s.** The scan route sets `maxDuration = 60` and self-limits via `RUN_BUDGET_MS`. Raising the ceiling requires Pro — but that alone won't fix the 8-credits/min throughput wall above.

## Env vars required
| Var | Purpose |
|-----|---------|
| `TWELVE_DATA_API_KEY` | Twelve Data key — **RSI alerts** data source. Free tier 8 credits/min, 800/day. **Only ever via `process.env`.** |
| `FMP_API_KEY` | FMP key — **earnings countdown** only (no longer used by alerts). **Only ever via `process.env`.** Coexists with the Twelve Data key. |
| `MARKET_PULSE_DATABASE_URL` | Render Postgres connection string for the `market_pulse` DB. **Use the POOLED/PgBouncer variant.** Separate DB in the same instance as the finance-app (not shared tables). |
| `CRON_SECRET` | Guards `/api/cron/rsi-scan`; sent by Vercel Cron as `Authorization: Bearer <value>`. |
| `RSI_BATCH_COUNT` | Splits the ~517 universe across N days by day-of-year (Twelve-Data free-tier workaround). Set ≈ `ceil(universe/6)` on free tier; `1` on a paid plan whose credits/min ≥ universe size. |
| `RSI_SCAN_DELAY_MS` | Optional; gap between FMP calls (default 150). |

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
- **Env vars on the personal `market-pulse`**: none set yet. Add in the dashboard (Settings → Environment Variables): `TWELVE_DATA_API_KEY` (alerts data source), `FMP_API_KEY` (earnings; copy the value from traderpwa-pro), `MARKET_PULSE_DATABASE_URL` (the **pooled** Render Postgres string), `CRON_SECRET` (new random string), and — because the universe is back to ~517 on the Twelve Data free tier — `RSI_BATCH_COUNT` ≈ `ceil(517/6) ≈ 87` (or `1` on a paid TD plan).
- **Render Postgres DB not yet provisioned**: create a **separate `market_pulse` database** within the existing Render Postgres instance (same one the finance-app uses — NOT shared tables), run `migrations/001_init_rsi_cache.sql` against it, and put the **pooled** connection string in `MARKET_PULSE_DATABASE_URL`. Until set, `/alerts` shows the graceful empty state.
- **First cron run** must be triggered **manually once** after the DB + `TWELVE_DATA_API_KEY` + `CRON_SECRET` are set:
  ```bash
  curl -H "Authorization: Bearer <CRON_SECRET>" https://market-pulse-tau-ten.vercel.app/api/cron/rsi-scan
  ```
  The JSON reports `scanned`, `failed`, `sliceSize`, `stoppedEarly` — use these to measure the Twelve Data fail rate on the full universe.
- **Alert universe = S&P 500 + Nasdaq 100 (~517), provisional** — restored after the Twelve Data switch; pending a fail-rate test (see Key architecture decisions). ⚠️ Free-tier throughput (8 credits/min) makes a same-day full scan infeasible — see Known constraints. Russell still excluded.

@AGENTS.md
