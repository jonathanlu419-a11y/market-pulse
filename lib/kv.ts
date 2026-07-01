/**
 * Thin wrapper around Vercel KV that degrades gracefully when the KV
 * integration isn't configured (KV_REST_API_URL / KV_REST_API_TOKEN absent).
 * This keeps builds and the /alerts page working before KV is provisioned.
 */
import { createClient, type VercelKV } from '@vercel/kv';

let client: VercelKV | null = null;

function getClient(): VercelKV | null {
  if (client) return client;
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  client = createClient({ url, token });
  return client;
}

export function isKVConfigured(): boolean {
  return !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

export async function kvGet<T>(key: string): Promise<T | null> {
  const c = getClient();
  if (!c) return null;
  try {
    return (await c.get<T>(key)) ?? null;
  } catch {
    return null;
  }
}

export async function kvSet<T>(key: string, value: T): Promise<boolean> {
  const c = getClient();
  if (!c) return false;
  try {
    await c.set(key, value);
    return true;
  } catch {
    return false;
  }
}

// ─── Key helpers ──────────────────────────────────────────────────────────────
export const priceHistoryKey = (symbol: string) => `price-history:${symbol}`;
export const RSI_ALERTS_KEY = 'rsi-alerts:latest';
