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
// Safety net: stop fetching before Hobby's 60s hard limit and persist progress.
const RUN_BUDGET_MS = 50_000;

// ┌───────────────────────────────────────────────────────────────────────────┐
// │ Universe is now a small WATCHLIST (data/watchlist.json, ~16 tickers) — the │
// │ 517-ticker index universe and its day-batching workaround are gone.        │
// │                                                                             │
// │ ⚠ TWELVE DATA FREE TIER = 8 credits/min (1 per symbol). So ~16 tickers need │
// │ ~2 min of credits — more than one 60s run holds. RUN_BUDGET_MS stops a run  │
// │ at ~6 fetched symbols. But because already-fresh-today symbols are SKIPPED  │
// │ (0 credits), running the scan again advances to the next un-fetched batch — │
// │ so 2–3 runs a few minutes apart cover the whole watchlist the same day.     │
// │ For a guaranteed single run with no stoppedEarly, keep the watchlist ≤ ~6   │
// │ tickers, or upgrade Twelve Data (credits/min ≥ watchlist size).             │
// └───────────────────────────────────────────────────────────────────────────┘

function utcDateKey(offsetDays = 0): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
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

  // Scan the whole watchlist in order. Already-fresh symbols are skipped cheaply,
  // so successive runs advance through the list (no day-slicing needed).
  const symbols = UNIVERSE;

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
  };

  await setLatestAlerts(payload);

  return NextResponse.json({
    ok: true,
    scanned,
    failed,
    alerts: alerts.length,
    universeSize: UNIVERSE.length,
    // true = hit RUN_BUDGET_MS before finishing the watchlist; run again to continue
    // (already-fresh symbols are skipped, so it advances to the rest).
    stoppedEarly,
    generatedAt: payload.generatedAt,
  });
}
