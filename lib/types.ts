/** Shape returned by GET /api/earnings */
export interface EarningsRow {
  symbol: string;
  name: string;
  sector: string;
  /** Earnings date, YYYY-MM-DD (US market date) */
  earningsDate: string;
  /** 'bmo' (before market open) | 'amc' (after market close) | null if unknown */
  time: 'bmo' | 'amc' | null;
  /** Whole calendar days from server "today" to the earnings date (client recomputes live) */
  daysRemaining: number;
  /** Analyst EPS estimate, if provided by FMP */
  epsEstimated: number | null;
}

export interface EarningsResponse {
  rows: EarningsRow[];
  /** ISO timestamp the data was assembled server-side */
  generatedAt: string;
  count: number;
  /** Present when the upstream fetch failed / no key — rows will be empty */
  error?: string;
}

// ─── RSI crossover alerts ───────────────────────────────────────────────────

import type { IndexName } from './universe';

/** One RSI6-crosses-above-both alert (see lib/rsi.ts for the exact condition) */
export interface RsiAlert {
  symbol: string;
  name: string;
  sector: string;
  indices: IndexName[];
  rsi6: number;
  rsi12: number;
  rsi24: number;
  /** The trading date the crossover occurred (YYYY-MM-DD) */
  crossoverDate: string;
}

/** Value stored at rsi-alerts:latest and returned by GET /api/alerts/rsi-cross */
export interface RsiAlertsPayload {
  alerts: RsiAlert[];
  /** ISO timestamp the scan completed */
  generatedAt: string;
  /** How many symbols were actually scanned in the run that produced this list */
  scanned: number;
  /** Total size of the combined ticker universe */
  universeSize: number;
  /** Present when the universe was split across days for rate-limit reasons */
  batch?: { index: number; count: number };
  /** Present when KV isn't configured or another problem occurred */
  error?: string;
}
