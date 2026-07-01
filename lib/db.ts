/**
 * Render Postgres cache layer for the RSI alerts feature.
 * Replaces the previous Vercel KV backend — same functional shape
 * (get/set price history per symbol, get/set the latest alert payload),
 * so the cron route and the /alerts API only swap call names.
 *
 * Degrades gracefully: if MARKET_PULSE_DATABASE_URL is unset or a query
 * fails, reads return null and writes return false (never throws), so the
 * build and the /alerts page keep working before the DB is provisioned.
 *
 * ⚠️ CONNECTION STRING: use the **pooled** (PgBouncer / "External"/"Pooler")
 * connection string from Render, NOT the direct one. Serverless functions
 * open many short-lived connections and can exhaust Postgres `max_connections`
 * fast; the pooled endpoint multiplexes them. Grab it from the Render
 * dashboard → your Postgres instance → Connections → "Pooled connection".
 */
import { Pool } from 'pg';
import type { Bar } from './fmp-history';
import type { RsiAlertsPayload } from './types';

let pool: Pool | null = null;
let initialized = false;

function getPool(): Pool | null {
  if (pool) return pool;
  if (initialized) return null; // already tried and failed / not configured
  initialized = true;

  const connectionString = process.env.MARKET_PULSE_DATABASE_URL;
  if (!connectionString) return null;

  pool = new Pool({
    connectionString,
    // Render Postgres requires SSL; its cert chain isn't in the default store.
    ssl: { rejectUnauthorized: false },
    // Keep low for serverless — even with the pooled endpoint, don't hoard.
    max: 3,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
  });
  // Prevent an unexpected idle-client error from crashing the process.
  pool.on('error', (err) => console.error('[db] idle client error:', err.message));
  return pool;
}

export function isDBConfigured(): boolean {
  return !!process.env.MARKET_PULSE_DATABASE_URL;
}

// ─── price_history ────────────────────────────────────────────────────────────

/** Cached daily closes for a symbol (chronological), or null if none/unavailable. */
export async function getPriceHistory(symbol: string): Promise<Bar[] | null> {
  const p = getPool();
  if (!p) return null;
  try {
    const { rows } = await p.query('SELECT data FROM price_history WHERE symbol = $1', [symbol]);
    if (rows.length === 0) return null;
    return rows[0].data as Bar[]; // JSONB is returned already parsed
  } catch (e) {
    console.error(`[db] getPriceHistory(${symbol}) failed:`, e instanceof Error ? e.message : e);
    return null;
  }
}

/** Upsert a symbol's cached price history. Returns false on any failure. */
export async function setPriceHistory(symbol: string, bars: Bar[]): Promise<boolean> {
  const p = getPool();
  if (!p) return false;
  try {
    await p.query(
      `INSERT INTO price_history (symbol, data, updated_at)
       VALUES ($1, $2::jsonb, now())
       ON CONFLICT (symbol) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
      // JSON.stringify: node-pg would otherwise coerce a JS array to a Postgres array
      [symbol, JSON.stringify(bars)]
    );
    return true;
  } catch (e) {
    console.error(`[db] setPriceHistory(${symbol}) failed:`, e instanceof Error ? e.message : e);
    return false;
  }
}

// ─── rsi_alerts_latest (single row, id = 1) ───────────────────────────────────
// The `alerts` JSONB column stores the FULL RsiAlertsPayload (alert array +
// scanned/universeSize/batch/generatedAt metadata) so the /alerts UI keeps all
// its fields. `computed_at` is a DB-side audit timestamp.

export async function getLatestAlerts(): Promise<RsiAlertsPayload | null> {
  const p = getPool();
  if (!p) return null;
  try {
    const { rows } = await p.query('SELECT alerts FROM rsi_alerts_latest WHERE id = 1');
    if (rows.length === 0) return null;
    return rows[0].alerts as RsiAlertsPayload;
  } catch (e) {
    console.error('[db] getLatestAlerts failed:', e instanceof Error ? e.message : e);
    return null;
  }
}

export async function setLatestAlerts(payload: RsiAlertsPayload): Promise<boolean> {
  const p = getPool();
  if (!p) return false;
  try {
    await p.query(
      `INSERT INTO rsi_alerts_latest (id, alerts, computed_at)
       VALUES (1, $1::jsonb, now())
       ON CONFLICT (id) DO UPDATE SET alerts = EXCLUDED.alerts, computed_at = now()`,
      [JSON.stringify(payload)]
    );
    return true;
  } catch (e) {
    console.error('[db] setLatestAlerts failed:', e instanceof Error ? e.message : e);
    return false;
  }
}
