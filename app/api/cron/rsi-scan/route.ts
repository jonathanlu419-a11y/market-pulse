import { NextResponse } from 'next/server';
import { UNIVERSE } from '@/lib/universe';
import { detectCrossover } from '@/lib/rsi';
import { fetchDailyCloses, TD_FREE_DELAY_MS, type Bar } from '@/lib/twelvedata-history';
import { getPriceHistory, setPriceHistory, setLatestAlerts, isDBConfigured } from '@/lib/db';
import type { RsiAlert, RsiAlertsPayload } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Hobby caps function duration at 60s. At ~7.5s/symbol (Twelve Data free tier)
// only ~6 symbols fit per run — see RUN_BUDGET_MS and the rate-limit note below.
export const maxDuration = 60;

const LOOKBACK_CALENDAR_DAYS = 190; // ≈130 trading days — ample seed for a stable Wilder RSI24
const KEEP_BARS = 90; // trim cached history to the last ~90 trading days
const DEFAULT_DELAY_MS = TD_FREE_DELAY_MS; // 7500ms — respect Twelve Data free tier (8 credits/min)
// Below this size a universe *could* fit under a data provider's limit in one run,
// so batching auto-disables. Kept as a dormant safety valve (see rate-limit note).
const BATCH_THRESHOLD = 200;
// Stop fetching before Hobby's 60s hard limit and persist progress cleanly.
const RUN_BUDGET_MS = 50_000;

// ┌───────────────────────────────────────────────────────────────────────────┐
// │ ⚠ TWELVE DATA FREE-TIER RATE LIMIT (data source for RSI alerts)            │
// │ Basic/free plan = 8 API credits/MINUTE, 800/day. /time_series = 1 credit   │
// │ per symbol, and the per-minute cap is CREDITS (batching doesn't help).     │
// │ ⇒ ~8 symbols/minute max; each call is paced DEFAULT_DELAY_MS (7.5s) apart. │
// │                                                                             │
// │ A Vercel cron function can't stay alive long enough to fetch a large       │
// │ universe: ~517 symbols ≈ 65 min, ~101 ≈ 13 min, both ≫ the 60s limit. So   │
// │ RUN_BUDGET_MS stops each run early (~6 symbols) and persists what it did.  │
// │                                                                             │
// │ To cover a large universe on the free tier, set RSI_BATCH_COUNT high       │
// │ (≈ ceil(universe / 6)) so each day scans a rotating 1/N slice by           │
// │ day-of-year — but that means a symbol is only refreshed every N days, so   │
// │ "today's crossover" is really N-days-stale. For reliable daily full-       │
// │ universe scans, UPGRADE Twelve Data (credits/min ≥ universe → one batch    │
// │ call in seconds) or keep the universe ≤ ~6 symbols.                        │
// └───────────────────────────────────────────────────────────────────────────┘

function utcDateKey(offsetDays = 0): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

function dayOfYearUTC(): number {
  const now = new Date();
  const start = Date.UTC(now.getUTCFullYear(), 0, 0);
  const diff = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - start;
  return Math.floor(diff / 86_400_000);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Merge new bars into cached bars, dedupe by date, sort ascending, keep last N */
function mergeBars(cached: Bar[], fresh: Bar[]): Bar[] {
  const byDate = new Map<string, number>();
  for (const b of cached) byDate.set(b.date, b.close);
  for (const b of fresh) byDate.set(b.date, b.close); // fresh overwrites (revisions)
  return [...byDate.entries()]
    .map(([date, close]) => ({ date, close }))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-KEEP_BARS);
}

export async function GET(request: Request) {
  // ─── Auth: only Vercel Cron (Bearer CRON_SECRET) or a manual ?secret= may run ───
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const { searchParams } = new URL(request.url);
    const header = request.headers.get('authorization');
    const qs = searchParams.get('secret');
    if (header !== `Bearer ${secret}` && qs !== secret) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  if (!isDBConfigured()) {
    return NextResponse.json(
      { error: 'Database not configured (MARKET_PULSE_DATABASE_URL missing)' },
      { status: 503 }
    );
  }
  if (!process.env.TWELVE_DATA_API_KEY) {
    return NextResponse.json({ error: 'TWELVE_DATA_API_KEY is not set' }, { status: 503 });
  }

  const delayMs = Number(process.env.RSI_SCAN_DELAY_MS) || DEFAULT_DELAY_MS;
  const requestedBatchCount = Math.max(1, parseInt(process.env.RSI_BATCH_COUNT || '1', 10) || 1);
  // Auto-disable batching for small universes — they fit under the free tier in one run.
  const batchCount = UNIVERSE.length < BATCH_THRESHOLD ? 1 : requestedBatchCount;
  const batchIndex = batchCount > 1 ? dayOfYearUTC() % batchCount : 0;

  // Deterministic slice of the (symbol-sorted) universe for today's batch
  const symbols = UNIVERSE.filter((_, i) => batchCount === 1 || i % batchCount === batchIndex);

  const today = utcDateKey(0);
  const backfillFrom = utcDateKey(-LOOKBACK_CALENDAR_DAYS);

  const alerts: RsiAlert[] = [];
  let scanned = 0;
  let failed = 0;
  let stoppedEarly = false;
  const startedAt = Date.now();

  for (const company of symbols) {
    // Stop before the serverless time limit and persist what we have.
    if (Date.now() - startedAt > RUN_BUDGET_MS) {
      stoppedEarly = true;
      break;
    }
    const { symbol } = company;
    try {
      const cached = (await getPriceHistory(symbol)) ?? [];
      const lastDate = cached.length ? cached[cached.length - 1].date : null;

      let bars: Bar[];
      if (lastDate && lastDate >= today) {
        // Already fresh for today — recompute from cache, no Twelve Data call
        bars = cached;
      } else {
        // Incremental if we have history, otherwise a one-time full backfill
        const from = lastDate ?? backfillFrom;
        const fresh = await fetchDailyCloses(symbol, from, today);
        bars = mergeBars(cached, fresh);
        if (bars.length) await setPriceHistory(symbol, bars);
        await sleep(delayMs);
      }

      scanned++;

      const closes = bars.map((b) => b.close);
      const cross = detectCrossover(closes);
      if (cross) {
        alerts.push({
          symbol,
          name: company.name,
          sector: company.sector,
          indices: company.indices,
          rsi6: cross.rsi6,
          rsi12: cross.rsi12,
          rsi24: cross.rsi24,
          crossoverDate: bars[bars.length - 1].date,
        });
      }
    } catch (e) {
      // One bad symbol must not fail the whole run
      failed++;
      console.error(`[rsi-scan] ${symbol} failed:`, e instanceof Error ? e.message : e);
    }
  }

  alerts.sort((a, b) => a.symbol.localeCompare(b.symbol));

  const payload: RsiAlertsPayload = {
    alerts,
    generatedAt: new Date().toISOString(),
    scanned,
    universeSize: UNIVERSE.length,
    ...(batchCount > 1 ? { batch: { index: batchIndex, count: batchCount } } : {}),
  };

  await setLatestAlerts(payload);

  return NextResponse.json({
    ok: true,
    scanned,
    failed,
    alerts: alerts.length,
    universeSize: UNIVERSE.length,
    sliceSize: symbols.length,
    stoppedEarly, // true = hit RUN_BUDGET_MS before finishing this slice (free-tier limit)
    batch: batchCount > 1 ? { index: batchIndex, count: batchCount } : null,
    generatedAt: payload.generatedAt,
  });
}
