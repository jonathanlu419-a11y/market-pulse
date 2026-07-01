'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import type { RsiAlert, RsiAlertsPayload } from '@/lib/types';

type Filter = 'all' | 'sp500' | 'nasdaq100';

function indexLabel(indices: RsiAlert['indices']): string {
  const sp = indices.includes('S&P500');
  const nq = indices.includes('Nasdaq100');
  if (sp && nq) return 'Both';
  if (sp) return 'S&P 500';
  if (nq) return 'Nasdaq 100';
  return '—';
}

function rsiColor(v: number): string {
  if (v >= 70) return 'text-red-400';
  if (v >= 50) return 'text-emerald-400';
  if (v <= 30) return 'text-sky-400';
  return 'text-slate-300';
}

export default function AlertsPage() {
  const [payload, setPayload] = useState<RsiAlertsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>('all');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/alerts/rsi-cross');
        const data: RsiAlertsPayload = await res.json();
        if (!cancelled) setPayload(data);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const alerts = useMemo(() => payload?.alerts ?? [], [payload]);

  const filtered = useMemo(() => {
    if (filter === 'sp500') return alerts.filter((a) => a.indices.includes('S&P500'));
    if (filter === 'nasdaq100') return alerts.filter((a) => a.indices.includes('Nasdaq100'));
    return alerts;
  }, [alerts, filter]);

  const filters: { key: Filter; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'sp500', label: 'S&P 500' },
    { key: 'nasdaq100', label: 'Nasdaq 100' },
  ];

  return (
    <main className="mx-auto min-h-screen w-full max-w-5xl px-4 pb-16">
      <header className="pt-8 pb-5 sm:pt-12">
        <Link href="/" className="text-sm text-emerald-400 hover:text-emerald-300">
          ‹ Earnings Countdown
        </Link>
        <h1 className="mt-3 text-2xl font-extrabold tracking-tight sm:text-3xl">
          RSI Crossover Alerts
        </h1>
        <p className="mt-1.5 text-sm text-slate-400">
          S&amp;P 500 + Nasdaq 100 names where daily <span className="font-mono">RSI6</span> crossed
          above <span className="font-mono">both RSI12 and RSI24</span> today (Futu 6/12/24 periods).
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
          {payload?.generatedAt ? (
            <span className="tabular-nums">
              Last updated{' '}
              {new Date(payload.generatedAt).toLocaleString('en-US', {
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
              })}
            </span>
          ) : null}
          {payload?.scanned ? (
            <span>· {payload.scanned} of {payload.universeSize} scanned</span>
          ) : null}
          {payload?.batch ? (
            <span>· batch {payload.batch.index + 1}/{payload.batch.count}</span>
          ) : null}
        </div>
      </header>

      {/* Filters */}
      <div className="mb-4 flex gap-2">
        {filters.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={[
              'rounded-lg px-3.5 py-2 text-sm font-medium transition-colors',
              filter === f.key
                ? 'bg-emerald-500/20 text-emerald-300 ring-1 ring-emerald-500/40'
                : 'bg-white/[0.04] text-slate-400 hover:bg-white/[0.08]',
            ].join(' ')}
          >
            {f.label}
            {f.key !== 'all' && (
              <span className="ml-1.5 text-xs text-current/60">
                {f.key === 'sp500'
                  ? alerts.filter((a) => a.indices.includes('S&P500')).length
                  : alerts.filter((a) => a.indices.includes('Nasdaq100')).length}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Body */}
      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-12 animate-pulse rounded-lg border border-white/5 bg-white/[0.03]" />
          ))}
        </div>
      ) : payload?.error && alerts.length === 0 ? (
        <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-6 text-center">
          <p className="font-semibold text-amber-300">Alerts aren&apos;t available yet</p>
          <p className="mt-1 text-sm text-slate-400">{payload.error}</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border border-white/8 bg-white/[0.02] py-16 text-center text-slate-400">
          No RSI crossovers detected today
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-white/8">
          <table className="w-full min-w-[640px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="px-3 py-3 font-semibold">Ticker</th>
                <th className="px-3 py-3 font-semibold">Company</th>
                <th className="px-3 py-3 font-semibold">Index</th>
                <th className="px-3 py-3 font-semibold">Sector</th>
                <th className="px-3 py-3 text-right font-semibold">RSI6</th>
                <th className="px-3 py-3 text-right font-semibold">RSI12</th>
                <th className="px-3 py-3 text-right font-semibold">RSI24</th>
                <th className="px-3 py-3 text-right font-semibold">Crossover</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((a) => (
                <tr key={a.symbol} className="border-b border-white/5 last:border-0 hover:bg-white/[0.03]">
                  <td className="px-3 py-3 font-mono font-bold text-white">{a.symbol}</td>
                  <td className="px-3 py-3 text-slate-300">{a.name}</td>
                  <td className="px-3 py-3">
                    <span
                      className={[
                        'rounded-full px-2 py-0.5 text-[11px]',
                        indexLabel(a.indices) === 'Both'
                          ? 'bg-violet-500/15 text-violet-300'
                          : indexLabel(a.indices) === 'Nasdaq 100'
                          ? 'bg-sky-500/15 text-sky-300'
                          : 'bg-emerald-500/15 text-emerald-300',
                      ].join(' ')}
                    >
                      {indexLabel(a.indices)}
                    </span>
                  </td>
                  <td className="px-3 py-3 text-slate-400">{a.sector}</td>
                  <td className={`px-3 py-3 text-right font-mono tabular-nums ${rsiColor(a.rsi6)}`}>{a.rsi6.toFixed(1)}</td>
                  <td className="px-3 py-3 text-right font-mono tabular-nums text-slate-300">{a.rsi12.toFixed(1)}</td>
                  <td className="px-3 py-3 text-right font-mono tabular-nums text-slate-300">{a.rsi24.toFixed(1)}</td>
                  <td className="px-3 py-3 text-right font-mono tabular-nums text-slate-400">{a.crossoverDate}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <footer className="mt-10 text-center text-xs text-slate-600">
        RSI computed with Wilder smoothing · updated daily after US market close
      </footer>
    </main>
  );
}
