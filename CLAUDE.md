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
- **Financial Modeling Prep (FMP)** — market data source (free tier)

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
  fmp-history.ts               # FMP daily close fetch (incremental)
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
- **Ticker universe (alerts)**: currently **Nasdaq 100 ONLY** (~100 tickers) — built in `lib/universe.ts` from `data/nasdaq100.json`, deduped, sorted. **Provisional**: S&P 500 was removed from the alert scan because testing showed many S&P mid-cap names return **FMP HTTP 402 (Payment Required)** on the free tier's historical endpoint, while large-cap Nasdaq-100 names are expected to have better free-tier coverage — pending the fail-rate test. `data/sp500.json` is **untouched** and still powers the earnings countdown (which imports it directly, not via `UNIVERSE`). To restore the combined ~517-ticker universe, re-add the `sp500` import + `add()` loop in `lib/universe.ts`.
- **FMP historical endpoint**: use **`/stable/historical-price-eod/light?symbol=&from=&to=`** (returns `{date, price, volume}`).
  - ⚠️ **Trap**: `/api/v3/historical-price-full/...` is a **dead "Legacy Endpoint"** on this key (accounts created after 2025-08-31). The hyphenated `/stable/historical-price-eod-full` **404s**. Only the `.../light` (or `.../full` with a slash) path returns data. See [fmp-history.ts](lib/fmp-history.ts).
- **RSI**: Wilder's smoothing in [lib/rsi.ts](lib/rsi.ts). Validated against the canonical 14-period reference: **70.46 / 66.25 / 37.79**. Periods 6/12/24 match Futu's default RSI1/RSI2/RSI3.
- **Crossover definition** (`detectCrossover`): RSI6 crosses **above BOTH** RSI12 and RSI24 on the **current trading day only** — i.e. today `RSI6 > RSI12 && RSI6 > RSI24`, and yesterday it was **not** already above both. This is a **"today only" event**, not a persistent "currently above" state.
- **Postgres cache** ([lib/db.ts](lib/db.ts), schema [migrations/001_init_rsi_cache.sql](migrations/001_init_rsi_cache.sql)):
  - `price_history` table (PK `symbol`, JSONB `data`) → last ~90 daily `{date, close}` bars per symbol
  - `rsi_alerts_latest` table (single row `id=1`, JSONB `alerts`) → stores the **full** `RsiAlertsPayload` (array + scanned/universeSize/batch/generatedAt) so the UI keeps all fields
  - ⚠️ **Use the POOLED (PgBouncer) connection string** for `MARKET_PULSE_DATABASE_URL`, not the direct one — serverless opens many short-lived connections and can exhaust `max_connections`. Pool is a module-level singleton (`max: 3`), SSL `rejectUnauthorized: false` (Render requires SSL).
- **Graceful DB degradation**: [lib/db.ts](lib/db.ts) returns null/false instead of throwing when `MARKET_PULSE_DATABASE_URL` is absent or a query fails. The `/alerts` page then shows a friendly "not available yet" state. Builds work without the DB.
- **Incremental fetch**: cron appends only new days to cached history when possible (1 FMP call/ticker steady state), full backfill only on first run per symbol.

## Known constraints
- **FMP free tier = 250 calls/day.** With the current **Nasdaq-100-only (~100)** universe, a full daily scan fits comfortably under the limit, so **batching is auto-disabled**: the cron route forces `batchCount = 1` when `UNIVERSE.length < BATCH_THRESHOLD` (200), regardless of `RSI_BATCH_COUNT`. If the universe grows back over ~250 (e.g. re-adding S&P 500 → ~517), set `RSI_BATCH_COUNT=2/3` — but note batch mode only scans 1/N of the universe per day (same-day crossovers in unscanned batches are missed, no catch-up), so a paid FMP tier is better for reliability.
- **Vercel Hobby cron `maxDuration` = 60s.** The scan route sets `maxDuration = 60`. Nasdaq-100 (~100 @ ~150ms ≈ 15s) fits easily; a much larger universe or batch risks timeouts (raising it requires Pro).

## Env vars required
| Var | Purpose |
|-----|---------|
| `FMP_API_KEY` | FMP data source. **Only ever via `process.env`, never hardcoded.** |
| `MARKET_PULSE_DATABASE_URL` | Render Postgres connection string for the `market_pulse` DB. **Use the POOLED/PgBouncer variant.** Separate DB in the same instance as the finance-app (not shared tables). |
| `CRON_SECRET` | Guards `/api/cron/rsi-scan`; sent by Vercel Cron as `Authorization: Bearer <value>`. |
| `RSI_BATCH_COUNT` | Splits the universe across N days (free-tier workaround). **Currently a no-op** — batching auto-disables for the small Nasdaq-100 universe; set to `1`. Only relevant if S&P 500 is re-added (~517). |
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
- **Env vars on the personal `market-pulse`**: none set yet. Add all in the dashboard (Settings → Environment Variables): `FMP_API_KEY` (copy the value from traderpwa-pro), `MARKET_PULSE_DATABASE_URL` (the **pooled** Render Postgres string), `CRON_SECRET` (new random string), `RSI_BATCH_COUNT=1` (Nasdaq-100-only universe — batching auto-disabled anyway).
- **Render Postgres DB not yet provisioned**: create a **separate `market_pulse` database** within the existing Render Postgres instance (same one the finance-app uses — NOT shared tables), run `migrations/001_init_rsi_cache.sql` against it, and put the **pooled** connection string in `MARKET_PULSE_DATABASE_URL`. Until set, `/alerts` shows the graceful empty state.
- **First cron run** must be triggered **manually once** after the DB + `CRON_SECRET` are set:
  ```bash
  curl -H "Authorization: Bearer <CRON_SECRET>" https://market-pulse-tau-ten.vercel.app/api/cron/rsi-scan
  ```
- **Alert universe = Nasdaq 100 only** (provisional; S&P 500 removed to dodge free-tier HTTP 402s — see Key architecture decisions). Russell also excluded.

@AGENTS.md
