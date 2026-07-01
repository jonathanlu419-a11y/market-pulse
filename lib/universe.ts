/**
 * RSI-alert ticker universe: a small, curated **watchlist** (data/watchlist.json —
 * currently 16 tickers: Mag 7 + common high-volume/momentum names), NOT the full
 * S&P 500 + Nasdaq 100 index universe.
 *
 * Why: the ~517-ticker index universe can't be scanned within Twelve Data's free
 * tier (8 credits/min). A short watchlist fits comfortably, so the day-batching /
 * rotation machinery is no longer needed. Edit the watchlist by editing
 * `data/watchlist.json` (just `{ symbol, name, sector }` per entry).
 *
 * `indices` (S&P500 / Nasdaq100 badges shown on /alerts) is derived at runtime by
 * cross-referencing the index files — those imports are for badge tagging ONLY,
 * not universe membership. `data/sp500.json` also still powers the earnings feature.
 */
import watchlist from '@/data/watchlist.json';
import sp500 from '@/data/sp500.json';
import nasdaq100 from '@/data/nasdaq100.json';

export type IndexName = 'S&P500' | 'Nasdaq100';

export interface UniverseCompany {
  symbol: string;
  name: string;
  sector: string;
  /** Index membership badges, e.g. ["S&P500"], ["Nasdaq100"], both, or [] if neither */
  indices: IndexName[];
}

interface RawCompany {
  symbol: string;
  name: string;
  sector: string;
}

function buildUniverse(): UniverseCompany[] {
  const inSP500 = new Set((sp500 as RawCompany[]).map((c) => c.symbol));
  const inNasdaq = new Set((nasdaq100 as RawCompany[]).map((c) => c.symbol));

  return (watchlist as RawCompany[]).map((c) => {
    const indices: IndexName[] = [];
    if (inSP500.has(c.symbol)) indices.push('S&P500');
    if (inNasdaq.has(c.symbol)) indices.push('Nasdaq100');
    return { symbol: c.symbol, name: c.name, sector: c.sector, indices };
  });
}

export const UNIVERSE: UniverseCompany[] = buildUniverse();

const bySymbol = new Map(UNIVERSE.map((c) => [c.symbol, c]));
export const getCompany = (symbol: string): UniverseCompany | undefined => bySymbol.get(symbol);
