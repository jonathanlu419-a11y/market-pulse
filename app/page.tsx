'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import type { EarningsResponse, EarningsRow } from '@/lib/types';

/** Live countdown fields derived from an earnings date and the current clock */
function countdown(earningsDate: string, now: Date) {
  const target = new Date(earningsDate + 'T00:00:00'); // local midnight of the earnings day
  const startToday = new Date(now);
  startToday.setHours(0, 0, 0, 0);
  const dayDiff = Math.round((target.getTime() - startToday.getTime()) / 86_400_000);
  const msToTarget = target.getTime() - now.getTime();
  const hoursToTarget = msToTarget / 3_600_000;
  return { dayDiff, msToTarget, hoursToTarget };
}

function countdownLabel(earningsDate: string, now: Date): string {
  const { dayDiff, hoursToTarget } = countdown(earningsDate, now);
  if (dayDiff <= 0) return 'Today';
  // Within 48 hours → show hours + minutes for a live feel
  if (hoursToTarget > 0 && hoursToTarget <= 48) {
    const h = Math.floor(hoursToTarget);
    const m = Math.floor((hoursToTarget - h) * 60);
    return `${h}h ${m}m`;
  }
  return `${dayDiff} ${dayDiff === 1 ? 'day' : 'days'}`;
}

function fmtDate(d: string): string {
  return new Date(d + 'T00:00:00').toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function timeBadge(t: EarningsRow['time']): string {
  if (t === 'bmo') return 'Before open';
  if (t === 'amc') return 'After close';
  return 'Time TBD';
}

export default function Home() {
  const [rows, setRows] = useState<EarningsRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [now, setNow] = useState<Date>(() => new Date());

  // Fetch once on load
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/earnings');
        const data: EarningsResponse = await res.json();
        if (cancelled) return;
        setRows(data.rows);
        setGeneratedAt(data.generatedAt);
        if (data.error) setError(data.error);
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Recompute the countdown every minute for a live feel
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? rows.filter(
          (r) => r.symbol.toLowerCase().includes(q) || r.name.toLowerCase().includes(q)
        )
      : rows;
    // Sort ascending by soonest earnings (client-side, so it stays correct as time passes)
    return [...list].sort(
      (a, b) => countdown(a.earningsDate, now).msToTarget - countdown(b.earningsDate, now).msToTarget
    );
  }, [rows, query, now]);

  return (
    <main className="mx-auto min-h-screen w-full max-w-3xl px-4 pb-16">
      {/* Header */}
      <header className="pt-8 pb-5 sm:pt-12">
        <div className="flex items-start justify-between gap-3">
          <h1 className="text-2xl font-extrabold tracking-tight sm:text-3xl">
            Watchlist Earnings Countdown
          </h1>
          <Link
            href="/alerts"
            className="mt-1 shrink-0 rounded-lg bg-emerald-500/15 px-3 py-2 text-sm font-medium text-emerald-300 ring-1 ring-emerald-500/30 transition-colors hover:bg-emerald-500/25"
          >
            RSI Alerts →
          </Link>
        </div>
        <p className="mt-1.5 text-sm text-slate-400">
          Upcoming earnings dates, soonest first. Rows within 3 days are highlighted.
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
          {!loading && <span>{filtered.length} companies reporting in the next 90 days</span>}
          {generatedAt && (
            <span className="tabular-nums">
              · data as of{' '}
              {new Date(generatedAt).toLocaleString('en-US', {
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
              })}
            </span>
          )}
        </div>
      </header>

      {/* Search */}
      <div className="sticky top-0 z-10 -mx-4 bg-[#0a0e17]/90 px-4 py-3 backdrop-blur">
        <div className="relative">
          <svg
            className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500"
            viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search ticker or company…"
            className="w-full rounded-xl border border-white/10 bg-white/[0.04] py-3 pl-10 pr-4 text-sm text-white outline-none placeholder:text-slate-500 focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/30"
          />
        </div>
      </div>

      {/* Body */}
      <section className="mt-3">
        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="h-[68px] animate-pulse rounded-xl border border-white/5 bg-white/[0.03]" />
            ))}
          </div>
        ) : error && rows.length === 0 ? (
          <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-6 text-center">
            <p className="font-semibold text-red-300">Couldn&apos;t load earnings data</p>
            <p className="mt-1 text-sm text-slate-400">{error}</p>
            <p className="mt-3 text-xs text-slate-500">
              Make sure <code className="rounded bg-white/10 px-1">FINNHUB_API_KEY</code> is set in your environment.
            </p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-16 text-center text-slate-500">
            {query ? `No matches for “${query}”.` : 'No upcoming earnings found.'}
          </div>
        ) : (
          <ul className="space-y-2">
            {filtered.map((r) => {
              const { dayDiff } = countdown(r.earningsDate, now);
              const urgent = dayDiff <= 3;
              return (
                <li
                  key={r.symbol}
                  className={[
                    'flex items-center gap-3 rounded-xl border px-3 py-3 sm:gap-4 sm:px-4',
                    urgent
                      ? 'border-orange-500/40 bg-orange-500/[0.08]'
                      : 'border-white/8 bg-white/[0.03]',
                  ].join(' ')}
                >
                  {/* Countdown pill */}
                  <div
                    className={[
                      'flex w-20 shrink-0 flex-col items-center justify-center rounded-lg px-2 py-1.5 text-center sm:w-24',
                      urgent ? 'bg-orange-500/20 text-orange-300' : 'bg-white/[0.06] text-slate-200',
                    ].join(' ')}
                  >
                    <span className="font-mono text-sm font-bold leading-tight tabular-nums sm:text-base">
                      {countdownLabel(r.earningsDate, now)}
                    </span>
                    {dayDiff > 0 && (
                      <span className="text-[10px] uppercase tracking-wide text-current/70">
                        remaining
                      </span>
                    )}
                  </div>

                  {/* Ticker + company */}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="font-mono text-sm font-bold text-white sm:text-base">
                        {r.symbol}
                      </span>
                      <span className="truncate text-sm text-slate-300">{r.name}</span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      <span className="rounded-full bg-white/[0.06] px-2 py-0.5 text-[11px] text-slate-400">
                        {r.sector}
                      </span>
                      <span
                        className={[
                          'rounded-full px-2 py-0.5 text-[11px]',
                          r.time === 'bmo'
                            ? 'bg-sky-500/15 text-sky-300'
                            : r.time === 'amc'
                            ? 'bg-violet-500/15 text-violet-300'
                            : 'bg-white/[0.04] text-slate-500',
                        ].join(' ')}
                      >
                        {timeBadge(r.time)}
                      </span>
                    </div>
                  </div>

                  {/* Exact date */}
                  <div className="shrink-0 text-right">
                    <div className="font-mono text-xs text-slate-300 tabular-nums sm:text-sm">
                      {fmtDate(r.earningsDate)}
                    </div>
                    {r.epsEstimated != null && (
                      <div className="mt-0.5 text-[11px] text-slate-500">
                        est. EPS {r.epsEstimated.toFixed(2)}
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <footer className="mt-10 text-center text-xs text-slate-600">
        Data from Financial Modeling Prep · countdown updates live
      </footer>
    </main>
  );
}
