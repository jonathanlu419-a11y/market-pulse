-- Market Pulse — RSI alerts cache schema
-- Run once against the `market_pulse` database (a SEPARATE database within the
-- existing Render Postgres instance — do NOT run against the finance-app database).
--
--   psql "<MARKET_PULSE_DATABASE_URL>" -f migrations/001_init_rsi_cache.sql
--
-- Replaces the previous Vercel KV keys:
--   price-history:{symbol}  ->  price_history table (one row per symbol)
--   rsi-alerts:latest       ->  rsi_alerts_latest table (single row, id = 1)

CREATE TABLE IF NOT EXISTS price_history (
  symbol     TEXT PRIMARY KEY,
  data       JSONB NOT NULL,                       -- array of { date, close }, last ~90 entries
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rsi_alerts_latest (
  id          INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),  -- single-row table
  alerts      JSONB NOT NULL,                                -- full RsiAlertsPayload (array + metadata)
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
