import { NextResponse } from 'next/server';
import watchlist from '@/data/watchlist.json';
import type { EarningsRow, EarningsResponse } from '@/lib/types';

export const runtime = 'nodejs';
// Revalidate the route's static generation every 6 hours
export const revalidate = 21600;

const FINNHUB_BASE = 'https://finnhub.io/api/v1';
const WINDOW_DAYS = 90;
const CACHE_SECONDS = 21600; // 6 hours

/** Raw shape from Finnhub /calendar/earnings (verified against a live response) */
interface FinnhubEarning {
  symbol: string;
  date: string; // YYYY-MM-DD
  hour?: string; // 'bmo' | 'amc' | 'dmh' | '' (empty when unknown)
  epsEstimate: number | null;
  epsActual: number | null;
  revenueEstimate: number | null;
  revenueActual: number | null;
  quarter?: number;
  year?: number;
}

interface WatchlistCompany {
  symbol: string;
  name: string;
  sector: string;
}

const WATCHLIST = watchlist as WatchlistCompany[];

/** UTC date string N days from now, YYYY-MM-DD */
function dateKey(offsetDays = 0): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

/** Whole calendar days between two YYYY-MM-DD dates (b - a) */
function dayDiff(a: string, b: string): number {
  const da = Date.parse(a + 'T00:00:00Z');
  const db = Date.parse(b + 'T00:00:00Z');
  return Math.round((db - da) / 86_400_000);
}

/** Finnhub `hour` → our before/after-market marker */
function normalizeTime(h: string | undefined): 'bmo' | 'amc' | null {
  if (!h) return null;
  const s = h.toLowerCase();
  if (s.includes('bmo') || s.includes('before')) return 'bmo';
  if (s.includes('amc') || s.includes('after')) return 'amc';
  return null; // 'dmh' (during market hours) / '' → unknown
}

export async function GET() {
  const apiKey = process.env.FINNHUB_API_KEY;
  const today = dateKey(0);

  const empty = (error: string): NextResponse =>
    NextResponse.json<EarningsResponse>(
      { rows: [], generatedAt: new Date().toISOString(), count: 0, error },
      { status: 200 }
    );

  if (!apiKey) return empty('FINNHUB_API_KEY is not set');

  const from = today;
  const to = dateKey(WINDOW_DAYS);
  // One call covers the whole market for the date range; we filter to the watchlist below.
  const url = `${FINNHUB_BASE}/calendar/earnings?from=${from}&to=${to}&token=${apiKey}`;

  let raw: FinnhubEarning[];
  try {
    const res = await fetch(url, { next: { revalidate: CACHE_SECONDS } });
    if (!res.ok) return empty(`Finnhub HTTP ${res.status}`);
    const data = await res.json();
    const calendar = (data as { earningsCalendar?: unknown })?.earningsCalendar;
    if (!Array.isArray(calendar)) return empty('Unexpected Finnhub response');
    raw = calendar as FinnhubEarning[];
  } catch (e) {
    return empty(String(e));
  }

  // Index the watchlist for O(1) lookup — Finnhub returns the whole market.
  const index = new Map<string, WatchlistCompany>();
  for (const c of WATCHLIST) index.set(c.symbol, c);

  // Keep the earliest UPCOMING (not-yet-reported) earnings date per watchlist symbol
  const earliest = new Map<string, FinnhubEarning>();
  for (const item of raw) {
    const company = index.get(item.symbol);
    if (!company) continue; // not in the watchlist → omit
    if (item.date < today) continue; // already past
    if (item.epsActual !== null && item.epsActual !== undefined) continue; // already reported
    const existing = earliest.get(item.symbol);
    if (!existing || item.date < existing.date) earliest.set(item.symbol, item);
  }

  const rows: EarningsRow[] = [];
  for (const [symbol, item] of earliest) {
    const company = index.get(symbol)!;
    rows.push({
      symbol,
      name: company.name, // Finnhub omits company name → fall back to the watchlist
      sector: company.sector,
      earningsDate: item.date,
      time: normalizeTime(item.hour),
      daysRemaining: dayDiff(today, item.date),
      epsEstimated: item.epsEstimate ?? null,
    });
  }

  rows.sort((a, b) => a.earningsDate.localeCompare(b.earningsDate) || a.symbol.localeCompare(b.symbol));

  return NextResponse.json<EarningsResponse>(
    { rows, generatedAt: new Date().toISOString(), count: rows.length },
    {
      status: 200,
      headers: {
        'Cache-Control': `public, s-maxage=${CACHE_SECONDS}, stale-while-revalidate=1800`,
      },
    }
  );
}
