/**
 * Twelve Data daily close-price fetch for the RSI ALERTS feature.
 * Replaces lib/fmp-history.ts for alerts only — the earnings countdown keeps
 * using FMP directly (see app/api/earnings/route.ts), untouched.
 *
 * Endpoint (verified against twelvedata.com/docs):
 *   GET https://api.twelvedata.com/time_series
 *       ?symbol=AAPL&interval=1day&order=asc
 *       &start_date=YYYY-MM-DD   (incremental)  OR  &outputsize=N  (backfill)
 *       &apikey=...
 * Response: { meta, values: [{ datetime, open, high, low, close, volume }], status: "ok" }
 *   - `values` fields are STRINGS; we parse close→number, datetime→YYYY-MM-DD.
 *   - On a bad symbol / rate limit, TD returns HTTP 200 with { status:"error", code, message }.
 *
 * ⚠️ FREE-TIER RATE LIMIT (Basic plan — confirmed at twelvedata.com/pricing):
 *   **8 API credits / minute, 800 / day** (reset midnight UTC). /time_series costs
 *   **1 credit per symbol**, and the per-minute cap is measured in CREDITS, not
 *   requests — so a batched N-symbol call still costs N credits and a >8-symbol
 *   call 429s immediately. Net: you can fetch at most ~8 symbols/minute on free tier.
 *   The cron route paces calls TD_FREE_DELAY_MS apart and uses a per-run time budget.
 */
export interface Bar {
  date: string; // YYYY-MM-DD
  close: number;
}

const BASE = 'https://api.twelvedata.com';

/** Basic/free plan: 8 credits per minute; /time_series = 1 credit per symbol. */
export const TD_FREE_CREDITS_PER_MIN = 8;
/** Even spacing to stay within the per-minute credit cap (60000 / 8 = 7500 ms). */
export const TD_FREE_DELAY_MS = Math.ceil(60_000 / TD_FREE_CREDITS_PER_MIN);

interface TDValue {
  datetime: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}
interface TDResponse {
  status?: string;
  message?: string;
  code?: number;
  values?: TDValue[];
}

/**
 * Fetch daily closes for a symbol, chronological order (oldest first).
 * - `startDate` set → request only bars on/after it (incremental append).
 * - `startDate` absent → fetch a fresh `outputsize`-bar window (one-time backfill).
 * Signature mirrors the old FMP helper so the cron loop is unchanged; `endDate`
 * is accepted for compatibility but unused (TD returns up to the latest close).
 * Throws on HTTP / API errors so the caller can try/catch and skip per-symbol.
 */
export async function fetchDailyCloses(
  symbol: string,
  startDate?: string,
  _endDate?: string,
  outputsize = 130 // ≈90 trading days — ample seed for a stable Wilder RSI24
): Promise<Bar[]> {
  const apiKey = process.env.TWELVE_DATA_API_KEY;
  if (!apiKey) throw new Error('TWELVE_DATA_API_KEY is not set');

  const url = new URL(`${BASE}/time_series`);
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('interval', '1day');
  url.searchParams.set('order', 'asc');
  url.searchParams.set('apikey', apiKey);
  if (startDate) url.searchParams.set('start_date', startDate);
  else url.searchParams.set('outputsize', String(outputsize));

  const res = await fetch(url.toString(), { cache: 'no-store' });
  if (!res.ok) throw new Error(`Twelve Data HTTP ${res.status} for ${symbol}`);

  const data = (await res.json()) as TDResponse;
  // TD signals bad symbol / out-of-credits via { status:"error", code, message } at HTTP 200.
  if (data.status === 'error' || !Array.isArray(data.values)) {
    throw new Error(`${symbol}: ${data.message ?? 'Twelve Data returned no values'}`);
  }

  return data.values
    .map((v) => ({ date: String(v.datetime).slice(0, 10), close: Number(v.close) }))
    .filter((b) => b.date.length === 10 && Number.isFinite(b.close))
    .sort((a, b) => a.date.localeCompare(b.date));
}
