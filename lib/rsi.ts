/**
 * RSI (Relative Strength Index) using Wilder's smoothing — matches the standard
 * RSI6 / RSI12 / RSI24 shown in Futu (RSI1/RSI2/RSI3 default periods 6/12/24).
 */

/**
 * Compute an RSI series aligned index-for-index with `closes`.
 * Positions before enough data exists are NaN. The first defined value is at
 * index `period` (simple average seed), then Wilder-smoothed thereafter.
 */
export function calculateRSI(closes: number[], period: number): number[] {
  const rsi = new Array<number>(closes.length).fill(NaN);
  if (closes.length <= period) return rsi;

  // Seed: simple average of the first `period` gains/losses
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change >= 0) gain += change;
    else loss -= change;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  // Wilder smoothing for the rest
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const g = change > 0 ? change : 0;
    const l = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }

  return rsi;
}

export interface CrossoverResult {
  rsi6: number;
  rsi12: number;
  rsi24: number;
}

/**
 * Detect an RSI6-crosses-above-both crossover event on the MOST RECENT bar.
 *
 * Event (today only — not "currently above"):
 *   Today:     RSI6 > RSI12  AND  RSI6 > RSI24
 *   Yesterday: RSI6 <= RSI12  OR   RSI6 <= RSI24   (wasn't already above both)
 *
 * Returns the today RSI triple if it just crossed, otherwise null.
 */
export function detectCrossover(closes: number[]): CrossoverResult | null {
  if (closes.length < 26) return null; // need at least a couple bars past RSI24 seed

  const rsi6 = calculateRSI(closes, 6);
  const rsi12 = calculateRSI(closes, 12);
  const rsi24 = calculateRSI(closes, 24);

  const t = closes.length - 1; // today
  const y = closes.length - 2; // yesterday

  const t6 = rsi6[t], t12 = rsi12[t], t24 = rsi24[t];
  const y6 = rsi6[y], y12 = rsi12[y], y24 = rsi24[y];

  if ([t6, t12, t24, y6, y12, y24].some((v) => Number.isNaN(v))) return null;

  const todayAboveBoth = t6 > t12 && t6 > t24;
  const yesterdayAboveBoth = y6 > y12 && y6 > y24;

  if (todayAboveBoth && !yesterdayAboveBoth) {
    return {
      rsi6: Math.round(t6 * 100) / 100,
      rsi12: Math.round(t12 * 100) / 100,
      rsi24: Math.round(t24 * 100) / 100,
    };
  }
  return null;
}
