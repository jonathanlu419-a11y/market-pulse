/**
 * Combined S&P 500 + Nasdaq 100 ticker universe, deduplicated by symbol.
 * Merged at runtime from the two static source files — no build step needed.
 */
import sp500 from '@/data/sp500.json';
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

  for (const c of sp500 as RawCompany[]) add(c, 'S&P500');
  for (const c of nasdaq100 as RawCompany[]) add(c, 'Nasdaq100');

  // Stable, deterministic ordering by symbol so batch slicing is reproducible across runs
  return [...map.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
}

export const UNIVERSE: UniverseCompany[] = buildUniverse();

const bySymbol = new Map(UNIVERSE.map((c) => [c.symbol, c]));
export const getCompany = (symbol: string): UniverseCompany | undefined => bySymbol.get(symbol);
