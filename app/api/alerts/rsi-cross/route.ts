import { NextResponse } from 'next/server';
import { kvGet, isKVConfigured, RSI_ALERTS_KEY } from '@/lib/kv';
import { UNIVERSE } from '@/lib/universe';
import type { RsiAlertsPayload } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic'; // always read freshest cache value

/** Fast read of the pre-computed alert list — no live computation. */
export async function GET() {
  const emptyBase = {
    alerts: [],
    generatedAt: '',
    scanned: 0,
    universeSize: UNIVERSE.length,
  };

  if (!isKVConfigured()) {
    return NextResponse.json<RsiAlertsPayload>(
      { ...emptyBase, error: 'KV not configured — run the RSI scan once KV is set up.' },
      { status: 200 }
    );
  }

  const payload = await kvGet<RsiAlertsPayload>(RSI_ALERTS_KEY);
  if (!payload) {
    return NextResponse.json<RsiAlertsPayload>(
      { ...emptyBase, error: 'No scan has run yet.' },
      { status: 200 }
    );
  }

  return NextResponse.json<RsiAlertsPayload>(payload, { status: 200 });
}
