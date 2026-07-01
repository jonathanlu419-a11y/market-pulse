import { NextResponse } from 'next/server';
import sp500 from '@/data/sp500.json';
import type { EarningsRow, EarningsResponse } from '@/lib/types';

export const runtime = 'nodejs';
// Revalidate the route's static generation every 6 hours
export const revalidate = 21600;

const FMP_BASE = 'https://financialmodelingprep.com/stable';
const WINDOW_DAYS = 90;
const CACHE_SECONDS = 21600; // 6 hours

/** Raw shape from FMP /stable/earnings-calendar */
interface FMPEarning {
  symbol: string;
  date: string;
  epsActual: number | null;
  epsEstimated: number | null;
  revenueActual: number | null;
  revenueEstimated: number | null;
  time?: string; // may be absent on the stable endpoint
  lastUpdated?: string;
}

interface SP500Company {
  symbol: string;
  name: string;
  sector: string;
}

const SP500 = sp500 as SP500Company[];

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

function normalizeTime(t: string | undefined): 'bmo' | 'amc' | null {
  if (!t) return null;
  const s = t.toLowerCase();
  if (s.includes('bmo') || s.includes('before')) return 'bmo';
  if (s.includes('amc') || s.includes('after')) return 'amc';
  return null;
}

export async function GET() {
  const apiKey = process.env.FMP_API_KEY;
  const today = dateKey(0);

  const empty = (error: string): NextResponse =>
    NextResponse.json<EarningsResponse>(
      { rows: [], generatedAt: new Date().toISOString(), count: 0, error },
      { status: 200 }
    );

  if (!apiKey) return empty('FMP_API_KEY is not set');

  const from = today;
  const to = dateKey(WINDOW_DAYS);
  const url = `${FMP_BASE}/earnings-calendar?from=${from}&to=${to}&apikey=${apiKey}`;

  let raw: FMPEarning[];
  try {
    const res = await fetch(url, { next: { revalidate: CACHE_SECONDS } });
    if (!res.ok) return empty(`FMP HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data)) {
      const msg =
        data && typeof data === 'object' && 'Error Message' in data
          ? String((data as Record<string, unknown>)['Error Message'])
          : 'Unexpected FMP response';
      return empty(msg);
    }
    raw = data as FMPEarning[];
  } catch (e) {
    return empty(String(e));
  }

  // Index the S&P 500 constituents for O(1) lookup
  const index = new Map<string, SP500Company>();
  for (const c of SP500) index.set(c.symbol, c);

  // Keep the earliest UPCOMING (not-yet-reported) earnings date per S&P 500 symbol
  const earliest = new Map<string, FMPEarning>();
  for (const item of raw) {
    const company = index.get(item.symbol);
    if (!company) continue; // not in the S&P 500 → omit
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
      name: company.name,
      sector: company.sector,
      earningsDate: item.date,
      time: normalizeTime(item.time),
      daysRemaining: dayDiff(today, item.date),
      epsEstimated: item.epsEstimated ?? null,
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
