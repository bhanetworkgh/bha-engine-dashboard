import { useEffect, useState } from 'react';
import type { RecordMetrics } from '../../data';
import { BUILDER_NAMES } from '../../data';
import { Band } from './Charts';
import { StatCell, StatStrip } from './Card';
import { Segmented } from './Tabs';

/**
 * The counts strip on a records page: volume this week against last, how
 * many reached the terminal state, open against closed, and how quickly items
 * move. The server computes these from its own status history; a metric it
 * cannot compute arrives null with a note, and the note is what is shown.
 */
function MetricCell({ label, value, compare, note, suffix }: { label: string; value: number | null; compare?: number | null; note: string | null; suffix?: string }) {
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
              {value}
              {suffix && <span className="ml-0.5 text-[13px] text-faint">{suffix}</span>}
            </span>
            {compare !== null && compare !== undefined && (
              <span className={`tabular text-[11.5px] ${delta === 0 ? 'text-faint' : 'text-dim'}`} title="Compared with last week">
                {delta !== null && delta > 0 ? `+${delta}` : delta} vs {compare} last week
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

export function MetricsStrip({ metrics, loading, error }: { metrics: RecordMetrics | null; loading: boolean; error: string | null }) {
  if (error) {
    return (
      <div className="card mx-6 mb-4 px-5 py-4 text-[12.5px] text-failing md:mx-8">Counts unavailable: {error}</div>
    );
  }
  if (!metrics) {
    return (
      <StatStrip cols={4} className={loading ? 'opacity-60' : ''}>
        {['Raised this week', 'Closed this week', 'Open vs closed', 'Median days to close'].map((l) => (
          <StatCell key={l}>
            <div className="kicker truncate">{l}</div>
            <div className="mt-1 text-[15px] text-faint">Counting</div>
          </StatCell>
        ))}
      </StatStrip>
    );
  }
  const t = metrics.terminal_label;
  const cap = t.charAt(0).toUpperCase() + t.slice(1);
  const ovc = metrics.open_vs_closed;
  return (
    <StatStrip cols={4} className={loading ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
      <MetricCell label="Raised this week" value={metrics.raised.value} compare={metrics.raised.compare} note={metrics.raised.note} />
      <MetricCell label={`${cap} this week`} value={metrics.closed.value} compare={metrics.closed.compare} note={metrics.closed.note} />
      <StatCell>
        <div className="min-w-0">
          <div className="kicker truncate">Open vs {t}</div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="font-display tabular text-[24px] leading-none text-ink">{ovc.open}</span>
            <span className="tabular text-[12px] text-faint">open</span>
            <span className="font-display tabular ml-1 text-[24px] leading-none text-dim">{ovc.closed}</span>
            <span className="tabular text-[12px] text-faint">{t}</span>
          </div>
          <div className="mt-2">
            <Band
              parts={[
                { value: ovc.open, tone: 'accent', label: 'open' },
                { value: ovc.closed, tone: 'dim', label: t },
              ]}
              height={6}
            />
          </div>
          {ovc.note && (
            <div className="mt-1.5 text-[11.5px] leading-snug text-faint" title={ovc.note}>
              {ovc.note}
            </div>
          )}
        </div>
      </StatCell>
      <MetricCell label={`Median days raised to ${t}`} value={metrics.median_days_to_close.value} note={metrics.median_days_to_close.note} suffix="d" />
    </StatStrip>
  );
}

/** Builder filter as a segmented control: everyone, then each builder with a count. */
export function BuilderFilter({ counts, value, onChange }: { counts: Record<string, number>; value: string; onChange: (v: string) => void }) {
  const ids = Object.keys(BUILDER_NAMES).filter((id) => (counts[id] ?? 0) > 0 || id === value);
  const total = Object.values(counts).reduce((n, c) => n + c, 0);
  return (
    <Segmented
      ariaLabel="Filter by builder"
      value={value}
      onChange={onChange}
      options={[{ value: 'all', label: 'Everyone', count: total }, ...ids.map((id) => ({ value: id, label: BUILDER_NAMES[id], count: counts[id] ?? 0 }))]}
    />
  );
}

/** A toast that clears itself. */
export function useToast() {
  const [toast, setToast] = useState<{ text: string; tone: 'ok' | 'failing' } | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(t);
  }, [toast]);
  return { toast, setToast };
}

export function Toast({ toast }: { toast: { text: string; tone: 'ok' | 'failing' } | null }) {
  if (!toast) return null;
  return (
    <div
      role="status"
      className={`fade-up pointer-events-none absolute bottom-5 left-1/2 z-30 -translate-x-1/2 rounded-full px-4 py-2 text-[12.5px] shadow-[var(--shadow-pop)] ${
        toast.tone === 'failing' ? 'bg-failing-soft text-failing' : 'bg-ink text-bg'
      }`}
    >
      {toast.text}
    </div>
  );
}
