/**
 * FMP daily close-price fetch for RSI.
 *
 * Uses the FREE-tier-compatible lightweight endpoint:
 *   GET /stable/historical-price-eod/light?symbol=AAPL&from=YYYY-MM-DD&to=YYYY-MM-DD
 * which returns [{ symbol, date, price, volume }] newest-first.
 *
 * NOTE: the older /api/v3/historical-price-full path referenced in some docs is a
 * dead "Legacy Endpoint" on accounts created after 2025-08-31, and the newer
 * /stable/historical-price-eod-full path 404s — the ".../light" path is the one
 * that actually returns data on this key's tier.
 */

export interface Bar {
  date: string; // YYYY-MM-DD
  close: number;
}

interface FMPLightBar {
  symbol: string;
  date: string;
  price: number;
  volume: number;
}

const BASE = 'https://financialmodelingprep.com/stable';

/**
 * Fetch daily closes for a symbol in [from, to] (inclusive), chronological order
 * (oldest first). Throws on HTTP / API errors so callers can try/catch per symbol.
 */
export async function fetchDailyCloses(
  symbol: string,
  from: string,
  to: string
): Promise<Bar[]> {
  const apiKey = process.env.FMP_API_KEY;
  if (!apiKey) throw new Error('FMP_API_KEY is not set');

  const url = `${BASE}/historical-price-eod/light?symbol=${encodeURIComponent(
    symbol
  )}&from=${from}&to=${to}&apikey=${apiKey}`;

  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`FMP HTTP ${res.status} for ${symbol}`);

  const data: unknown = await res.json();
  if (!Array.isArray(data)) {
    const msg =
      data && typeof data === 'object' && 'Error Message' in data
        ? String((data as Record<string, unknown>)['Error Message'])
        : 'Unexpected FMP response';
    throw new Error(`${symbol}: ${msg}`);
  }

  return (data as FMPLightBar[])
    .filter((b) => typeof b.price === 'number' && b.date)
    .map((b) => ({ date: b.date, close: b.price }))
    .sort((a, b) => a.date.localeCompare(b.date)); // oldest first
}
