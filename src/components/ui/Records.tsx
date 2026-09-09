import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Metric, MetricSeries, SyncInfo } from '../../data';
import { BUILDER_NAMES } from '../../data';
import { Bars } from './Charts';
import { StatCell } from './Card';
import { Segmented } from './Tabs';

/**
 * Shared pieces for the four records pages. Every figure on those pages is
 * computed by the server; a figure the rows cannot support arrives null with
 * a note, and the note is what is shown. A zero and an unknown never look the
 * same: a zero is a number, an unknown is a sentence.
 */

/** Whether the viewer asked for less motion. */
function reducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/**
 * A count that runs up from zero to its value once, on first paint. Later
 * changes snap, because a number that keeps animating on every refetch reads
 * as noise rather than news.
 */
export function CountUp({ value, duration = 720 }: { value: number; duration?: number }) {
  const [shown, setShown] = useState(reducedMotion() ? value : 0);
  const animated = useRef(false);
  useEffect(() => {
    if (animated.current || reducedMotion()) {
      setShown(value);
      animated.current = true;
      return;
    }
    animated.current = true;
    const start = performance.now();
    let raf = 0;
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      setShown(Math.round(value * eased));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return <>{shown}</>;
}

/** A headline count with its label; animates on load. */
export function CountCell({ label, value, tone = 'default', hint }: { label: string; value: number; tone?: 'default' | 'accent' | 'degraded' | 'failing' | 'dim'; hint?: ReactNode }) {
  const toneClass = tone === 'accent' ? 'text-accent-ink' : tone === 'degraded' ? 'text-degraded' : tone === 'failing' ? 'text-failing' : tone === 'dim' ? 'text-dim' : 'text-ink';
  return (
    <StatCell>
      <div className="min-w-0">
        <div className="kicker truncate">{label}</div>
        <div className={`font-display tabular mt-1 text-[28px] leading-none ${toneClass}`}>
          <CountUp value={value} />
        </div>
        {hint && <div className="mt-1.5 text-[11.5px] leading-snug text-faint">{hint}</div>}
      </div>
    </StatCell>
  );
}

/** A figure that may be unknown. Null renders as "Not recorded" and the reason; never as 0. */
export function MetricCell({ label, metric, suffix, compareLabel = 'last week' }: { label: string; metric: Metric; suffix?: string; compareLabel?: string }) {
  const { value, compare, note } = metric;
  const delta = value !== null && compare !== null && compare !== undefined ? value - compare : null;
  return (
    <StatCell>
      <div className="min-w-0">
        <div className="kicker truncate">{label}</div>
        {value === null ? (
          <div className="mt-1 text-[15px] leading-tight text-faint">Not recorded</div>
        ) : (
          <div className="mt-1 flex items-baseline gap-2">
            <span className="font-display tabular text-[24px] leading-none text-ink">
              <CountUp value={value} />
              {suffix && <span className="ml-0.5 text-[13px] text-faint">{suffix}</span>}
            </span>
            {compare !== null && compare !== undefined && (
              <span className={`tabular text-[11.5px] ${delta === 0 ? 'text-faint' : 'text-dim'}`} title={`Compared with ${compareLabel}`}>
                {delta !== null && delta > 0 ? `+${delta}` : delta} vs {compare} {compareLabel}
              </span>
            )}
          </div>
        )}
        {note && (
          <div className="mt-1.5 text-[11.5px] leading-snug text-faint" title={note}>
            {note}
          </div>
        )}
      </div>
    </StatCell>
  );
}

/** A small bar series, or the sentence saying why there is none. */
export function SeriesBlock({ title, series, tone = 'ink', height = 44, total }: { title: string; series: MetricSeries; tone?: 'ink' | 'accent' | 'degraded'; height?: number; total?: boolean }) {
  const pts = series.points;
  return (
    <div className="min-w-0">
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <div className="text-[13px] font-medium text-ink">{title}</div>
        {pts && total && <div className="tabular text-[12px] text-dim">{pts.reduce((n, p) => n + p.value, 0)} total</div>}
      </div>
      {pts ? (
        <>
          <Bars values={pts.map((p) => p.value)} labels={pts.map((p) => p.label)} height={height} tone={tone} highlightLast={false} />
          <div className="mt-1 flex justify-between text-[10.5px] text-faint">
            <span>{pts[0]?.label}</span>
            <span>{pts[pts.length - 1]?.label}</span>
          </div>
        </>
      ) : (
        <div className="rounded-[10px] bg-raised px-3 py-2.5 text-[12px] leading-snug text-dim">Not recorded</div>
      )}
      {series.note && <div className="mt-1.5 text-[11.5px] leading-snug text-faint">{series.note}</div>}
    </div>
  );
}

/** Where the rows came from and when, with the way to pull them again. */
export function SyncLine({ sync, onResync, busy }: { sync: SyncInfo; onResync?: () => void; busy?: boolean }) {
  const when = sync.synced_at ? sync.synced_at.replace('T', ' ').slice(0, 16) + ' UTC' : null;
  const tables = sync.tables.length > 1 ? sync.tables.map((t) => `${t.label} ${t.n}`).join(' · ') : null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-[11.5px] text-faint">
      <span>
        {sync.source === 'airtable' ? (
          <>
            Read from Airtable {when}
            {tables ? ` — ${tables}` : sync.tables[0] ? ` — ${sync.tables[0].n} rows` : ''}.
            {!sync.write_through && <span className="text-degraded"> Writes are off: no AIRTABLE_API_KEY.</span>}
          </>
        ) : (
          <span className="text-degraded">{sync.error ?? 'Nothing has been read from Airtable yet.'}</span>
        )}
        {sync.source === 'airtable' && sync.error && <span className="text-degraded"> Last resync failed: {sync.error}</span>}
      </span>
      {onResync && (
        <button type="button" onClick={onResync} disabled={busy} className="btn btn-ghost btn-sm">
          {busy ? 'Reading Airtable…' : 'Resync from Airtable'}
        </button>
      )}
    </div>
  );
}

/** Builder filter as a segmented control: everyone, then each builder with a count. */
export function BuilderFilter({ counts, value, onChange, unattributed }: { counts: Record<string, number>; value: string; onChange: (v: string) => void; unattributed?: number }) {
  const ids = Object.keys(BUILDER_NAMES).filter((id) => (counts[id] ?? 0) > 0 || id === value);
  const total = Object.values(counts).reduce((n, c) => n + c, 0) + (unattributed ?? 0);
  return (
    <Segmented
      ariaLabel="Filter by builder"
      value={value}
      onChange={onChange}
      options={[
        { value: 'all', label: 'Everyone', count: total },
        ...ids.map((id) => ({ value: id, label: BUILDER_NAMES[id], count: counts[id] ?? 0 })),
        ...(unattributed ? [{ value: 'none', label: 'No builder', count: unattributed }] : []),
      ]}
    />
  );
}

/** A search box that reports its value as typed. */
export function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <label className="relative block min-w-[220px] flex-1 md:max-w-[360px]">
      <span className="sr-only">{placeholder}</span>
      <input type="search" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="input py-1.5 pr-8 text-[12.5px]" />
      {value && (
        <button type="button" onClick={() => onChange('')} aria-label="Clear search" className="absolute top-1/2 right-2 -translate-y-1/2 text-faint hover:text-ink">
          ×
        </button>
      )}
    </label>
  );
}

/** A toast that clears itself. */
export function useToast() {
  const [toast, setToast] = useState<{ text: string; tone: 'ok' | 'failing' } | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.tone === 'failing' ? 6000 : 3200);
    return () => clearTimeout(t);
  }, [toast]);
  return { toast, setToast };
}

export function Toast({ toast }: { toast: { text: string; tone: 'ok' | 'failing' } | null }) {
  if (!toast) return null;
  return (
    <div
      role="status"
      className={`fade-up pointer-events-none absolute bottom-5 left-1/2 z-30 max-w-[80%] -translate-x-1/2 rounded-full px-4 py-2 text-center text-[12.5px] shadow-[var(--shadow-pop)] ${
        toast.tone === 'failing' ? 'bg-failing-soft text-failing' : 'bg-ink text-bg'
      }`}
    >
      {toast.text}
    </div>
  );
}
