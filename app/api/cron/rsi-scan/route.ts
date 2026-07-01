import { NextResponse } from 'next/server';
import { UNIVERSE } from '@/lib/universe';
import { detectCrossover } from '@/lib/rsi';
import { fetchDailyCloses, type Bar } from '@/lib/fmp-history';
import { getPriceHistory, setPriceHistory, setLatestAlerts, isDBConfigured } from '@/lib/db';
import type { RsiAlert, RsiAlertsPayload } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Hobby plan caps function duration at 60s. With ~517 tickers @ ~150ms each the
// FULL universe won't fit in one run — that's why batch mode exists (below).
export const maxDuration = 60;

const LOOKBACK_CALENDAR_DAYS = 190; // ≈130 trading days — ample seed for a stable Wilder RSI24
const KEEP_BARS = 90; // trim cached history to the last ~90 trading days
const DEFAULT_DELAY_MS = 150; // polite gap between FMP calls to avoid bursting

// ┌─────────────────────────────────────────────────────────────────────────┐
// │ ⚠ FMP RATE LIMIT                                                          │
// │ The combined S&P 500 + Nasdaq 100 universe is ~517 tickers. Steady state │
// │ is ~1 FMP call per ticker per day (incremental append), i.e. ~517/day.   │
// │ The FMP FREE tier allows only 250 calls/day, so a single daily full scan │
// │ WILL hit the limit and later symbols will be skipped.                    │
// │                                                                           │
// │ FALLBACK: set RSI_BATCH_COUNT=2 (or 3 to stay comfortably under 250) to  │
// │ split the universe across alternating days. Each run scans 1/N of the    │
// │ universe, chosen by day-of-year, so every symbol is refreshed every N    │
// │ days. In batch mode the alert list reflects only the symbols scanned     │
// │ that day (crossovers are a "today only" event, so this is acceptable).   │
// └─────────────────────────────────────────────────────────────────────────┘

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
  if (!process.env.FMP_API_KEY) {
    return NextResponse.json({ error: 'FMP_API_KEY is not set' }, { status: 503 });
  }

  const delayMs = Number(process.env.RSI_SCAN_DELAY_MS) || DEFAULT_DELAY_MS;
  const batchCount = Math.max(1, parseInt(process.env.RSI_BATCH_COUNT || '1', 10) || 1);
  const batchIndex = batchCount > 1 ? dayOfYearUTC() % batchCount : 0;

  // Deterministic slice of the (symbol-sorted) universe for today's batch
  const symbols = UNIVERSE.filter((_, i) => batchCount === 1 || i % batchCount === batchIndex);

  const today = utcDateKey(0);
  const backfillFrom = utcDateKey(-LOOKBACK_CALENDAR_DAYS);

  const alerts: RsiAlert[] = [];
  let scanned = 0;
  let failed = 0;

  for (const company of symbols) {
    const { symbol } = company;
    try {
      const cached = (await getPriceHistory(symbol)) ?? [];
      const lastDate = cached.length ? cached[cached.length - 1].date : null;

      let bars: Bar[];
      if (lastDate && lastDate >= today) {
        // Already fresh for today — recompute from cache, no FMP call
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
    batch: batchCount > 1 ? { index: batchIndex, count: batchCount } : null,
    generatedAt: payload.generatedAt,
  });
}
