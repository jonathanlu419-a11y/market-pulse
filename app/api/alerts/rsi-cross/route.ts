import { NextResponse } from 'next/server';
import { getLatestAlerts, isDBConfigured } from '@/lib/db';
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

  if (!isDBConfigured()) {
    return NextResponse.json<RsiAlertsPayload>(
      { ...emptyBase, error: 'Database not configured — set MARKET_PULSE_DATABASE_URL and run the RSI scan.' },
      { status: 200 }
    );
  }

  const payload = await getLatestAlerts();
  if (!payload) {
    return NextResponse.json<RsiAlertsPayload>(
      { ...emptyBase, error: 'No scan has run yet.' },
      { status: 200 }
    );
  }

  return NextResponse.json<RsiAlertsPayload>(payload, { status: 200 });
}
