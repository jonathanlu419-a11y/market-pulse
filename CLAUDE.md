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
- **Vercel KV** (Upstash Redis) — cache for price history + computed alerts
- **Vercel Cron** — triggers the daily RSI scan
- **Financial Modeling Prep (FMP)** — market data source (free tier)

## Layout
```
app/
  page.tsx                     # earnings countdown homepage (client)
  alerts/page.tsx              # RSI alerts table (client)
  api/earnings/route.ts        # FMP earnings-calendar, 6h cache, S&P500 cross-ref
  api/cron/rsi-scan/route.ts   # daily scan: fetch → RSI → crossover → write KV
  api/alerts/rsi-cross/route.ts# fast KV read for the /alerts page
lib/
  universe.ts                  # merges sp500 + nasdaq100 → deduped universe
  rsi.ts                       # Wilder RSI + crossover detection
  fmp-history.ts               # FMP daily close fetch (incremental)
  kv.ts                        # Vercel KV wrapper (graceful when unconfigured)
  types.ts                     # shared types
data/
  sp500.json                   # S&P 500 constituents (symbol, name, sector)
  nasdaq100.json               # Nasdaq 100 constituents
vercel.json                    # cron schedule (22:30 UTC)
```

## Key architecture decisions
- **Ticker universe**: `data/sp500.json` (503) + `data/nasdaq100.json` (101) merged **at runtime** in `lib/universe.ts`, deduped by symbol, sorted → **517 tickers** total. Each carries `indices: ("S&P500"|"Nasdaq100")[]` (both if overlapping). No build step.
- **FMP historical endpoint**: use **`/stable/historical-price-eod/light?symbol=&from=&to=`** (returns `{date, price, volume}`).
  - ⚠️ **Trap**: `/api/v3/historical-price-full/...` is a **dead "Legacy Endpoint"** on this key (accounts created after 2025-08-31). The hyphenated `/stable/historical-price-eod-full` **404s**. Only the `.../light` (or `.../full` with a slash) path returns data. See [fmp-history.ts](lib/fmp-history.ts).
- **RSI**: Wilder's smoothing in [lib/rsi.ts](lib/rsi.ts). Validated against the canonical 14-period reference: **70.46 / 66.25 / 37.79**. Periods 6/12/24 match Futu's default RSI1/RSI2/RSI3.
- **Crossover definition** (`detectCrossover`): RSI6 crosses **above BOTH** RSI12 and RSI24 on the **current trading day only** — i.e. today `RSI6 > RSI12 && RSI6 > RSI24`, and yesterday it was **not** already above both. This is a **"today only" event**, not a persistent "currently above" state.
- **KV cache keys**:
  - `price-history:{symbol}` → last ~90 daily `{date, close}` bars
  - `rsi-alerts:latest` → most recent computed alert list + metadata
- **Graceful KV degradation**: [lib/kv.ts](lib/kv.ts) returns empty/null instead of throwing when `KV_REST_API_URL` / `KV_REST_API_TOKEN` are absent. The `/alerts` page then shows a friendly "not available yet" state rather than erroring. Builds work without KV.
- **Incremental fetch**: cron appends only new days to cached history when possible (1 FMP call/ticker steady state), full backfill only on first run per symbol.

## Known constraints
- **⚠️ FMP free tier = 250 calls/day, universe = 517 tickers.** `RSI_BATCH_COUNT` (intended value **3**) splits the scan across N days by day-of-year. **Real limitation, not just a note:** on free tier only **~1/3 of the universe is scanned each day**, so a same-day crossover in an unscanned batch is **MISSED — there is no catch-up mechanism.** If the alerts feature needs to be reliable, **upgrade the FMP tier** and set `RSI_BATCH_COUNT=1`.
- **Vercel Hobby cron `maxDuration` = 60s.** The scan route sets `maxDuration = 60`. At ~150ms/call, a batch of ~172 fits; growing the universe or batch size risks timeouts. Raising it requires a Pro plan.

## Env vars required
| Var | Purpose |
|-----|---------|
| `FMP_API_KEY` | FMP data source. **Only ever via `process.env`, never hardcoded.** |
| `KV_REST_API_URL` | Vercel KV endpoint (auto-set by the KV integration). |
| `KV_REST_API_TOKEN` | Vercel KV token (auto-set by the KV integration). |
| `CRON_SECRET` | Guards `/api/cron/rsi-scan`; sent by Vercel Cron as `Authorization: Bearer <value>`. |
| `RSI_BATCH_COUNT` | Splits the universe across N days (free-tier workaround; use `3`, or `1` on a paid FMP plan). |
| `RSI_SCAN_DELAY_MS` | Optional; gap between FMP calls (default 150). |

Local dev: copy `.env.example` → `.env.local` (git-ignored) and fill in values.

## Deployment
- **GitHub**: `jonathanlu419-a11y/market-pulse` (public).
- **Vercel (primary)**: project **`market-pulse`** (team `eastlink`) → https://market-pulse-mu-nine.vercel.app
  - **Auto-deploy on push to `main`** once the Vercel project is git-connected (see Open items — git connect not yet completed; CLI can't do the GitHub App OAuth).
  - Local dir is linked to this project (`.vercel/project.json` → `market-pulse`).
- **Vercel (prior/parallel, NOT primary, NOT deleted)**: project **`traderpwa-pro`** → https://traderpwa-pro.vercel.app — an earlier parallel deployment of this same codebase. Left as-is and unmanaged; do not deploy to it or change it.
- CLI deploy to market-pulse (works today, from this non-standard dir):
  ```bash
  npx vercel --cwd "C:\Users\Jonathan Lu\trader-pwa" --prod --scope eastlink
  ```
- Before "done": run `npx next build` and `npx eslint app lib`.

## GitHub account note
- `gh` CLI on this machine has **two accounts**:
  - ✅ **`jonathanlu419-a11y`** — valid token, `repo` scope, **owns this repo**. Use this.
  - ❌ `jonathanluyukho-dev` — marked "default" but its token is **invalid**.
- The repo remote is **HTTPS** (SSH failed host-key verification on this machine; HTTPS + `gh` credential helper works). Don't assume the "default" account or SSH.

## Open items / next steps
- **Env vars on `market-pulse`**: none set yet. Must add all in the dashboard: `FMP_API_KEY`, `KV_REST_API_URL`, `KV_REST_API_TOKEN`, `CRON_SECRET`, `RSI_BATCH_COUNT`. (traderpwa-pro only ever had `FMP_API_KEY`.)
- **KV not yet provisioned** (never was, on either project): add storage under the **`market-pulse`** project. Vercel KV is deprecated → use the **Upstash Redis** integration from the Vercel Marketplace (still sets `KV_REST_API_URL` / `KV_REST_API_TOKEN`, compatible with `@vercel/kv`). KV is **per-project** — it does not carry over from any other project. Until set, `/alerts` shows the graceful empty state.
- **First cron run** must be triggered **manually once** after KV + `CRON_SECRET` are set:
  ```bash
  curl -H "Authorization: Bearer <CRON_SECRET>" https://market-pulse-mu-nine.vercel.app/api/cron/rsi-scan
  ```
- **Git connect (blocked via CLI)**: `vercel git connect` fails headlessly (Vercel GitHub App OAuth can't complete without a browser). Connect via dashboard: **market-pulse → Settings → Git → Connect Git Repository → authorize the Vercel GitHub App for `jonathanlu419-a11y` → select `jonathanlu419-a11y/market-pulse`**. After connecting, push-to-`main` auto-deploys.
- **Russell index deliberately excluded** from the alert universe for now (S&P 500 + Nasdaq 100 only).

@AGENTS.md
