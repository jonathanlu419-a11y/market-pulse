/**
 * RSI-alert ticker universe.
 *
 * Currently **Nasdaq 100 ONLY** (provisional). S&P 500 was removed from the
 * alert scan because many S&P mid-cap names return FMP HTTP 402 (Payment
 * Required) on the free tier's historical endpoint, whereas large-cap
 * Nasdaq-100 names are expected to have better free-tier coverage. We're
 * testing the fail rate. `data/sp500.json` is untouched and still powers the
 * earnings countdown — this change is scoped to the alerts feature.
 *
 * To restore the combined universe, re-add the sp500 import + its add() loop.
 */
import nasdaq100 from '@/data/nasdaq100.json';

export type IndexName = 'S&P500' | 'Nasdaq100';

export interface UniverseCompany {
  symbol: string;
  name: string;
  sector: string;
  /** Which indices this symbol belongs to, e.g. ["S&P500"], ["Nasdaq100"], or both */
  indices: IndexName[];
}

interface RawCompany {
  symbol: string;
  name: string;
  sector: string;
}

function buildUniverse(): UniverseCompany[] {
  const map = new Map<string, UniverseCompany>();

  const add = (c: RawCompany, index: IndexName) => {
    const existing = map.get(c.symbol);
    if (existing) {
      if (!existing.indices.includes(index)) existing.indices.push(index);
    } else {
      map.set(c.symbol, {
        symbol: c.symbol,
        name: c.name,
        sector: c.sector,
        indices: [index],
      });
    }
  };

  for (const c of nasdaq100 as RawCompany[]) add(c, 'Nasdaq100');

  // Stable, deterministic ordering by symbol so batch slicing is reproducible across runs
  return [...map.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
}

export const UNIVERSE: UniverseCompany[] = buildUniverse();

const bySymbol = new Map(UNIVERSE.map((c) => [c.symbol, c]));
export const getCompany = (symbol: string): UniverseCompany | undefined => bySymbol.get(symbol);
