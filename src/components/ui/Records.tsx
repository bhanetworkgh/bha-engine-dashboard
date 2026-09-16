import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Metric, MetricSeries, Freshness, RecordWrite } from '../../data';
import { BUILDER_NAMES } from '../../data';
import { Bars } from './Charts';
import { StatCell } from './Card';
import { EmptyPanel } from './EmptyState';
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
 * A count that runs up to its value. It animates on first paint, again
 * whenever the value changes (from the number it was showing, so a status
 * change reads as movement), and from zero whenever `replayKey` changes —
 * the page passes the selected builder, so switching tabs re-runs it.
 */
export function CountUp({ value, duration = 1900, replayKey }: { value: number; duration?: number; replayKey?: string | number }) {
  const [shown, setShown] = useState(reducedMotion() ? value : 0);
  const shownRef = useRef(reducedMotion() ? value : 0);
  const lastKey = useRef(replayKey);
  useEffect(() => {
    if (reducedMotion()) {
      shownRef.current = value;
      setShown(value);
      return;
    }
    const from = lastKey.current === replayKey ? shownRef.current : 0;
    lastKey.current = replayKey;
    const start = performance.now();
    let raf = 0;
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / duration);
      /**
       * A smoothstep, not an ease-out (2026-09-16, Destiny, third pass).
       *
       * Every ease-out — cubic, quint — front-loads: it covers most of its
       * distance immediately and then crawls, which is exactly the "it just
       * happens all at once" this kept reading as. A smoothstep starts slow,
       * moves through the middle and settles, so the number is legible the
       * whole way up rather than only at the end.
       */
      const eased = p * p * (3 - 2 * p);
      const v = Math.round(from + (value - from) * eased);
      shownRef.current = v;
      setShown(v);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, replayKey]);
  return <>{shown}</>;
}

/**
 * A headline count with its label; animates on load.
 *
 * `hintMinLines` is the counterpart of MetricCard's `noteMinLines`: a floor
 * under the footnote so a row of these cells is one block of text rather than
 * four of different depths. Set it to the longest hint in the row.
 */
export function CountCell({
  label,
  value,
  tone = 'default',
  hint,
  hintMinLines,
  replayKey,
}: {
  label: string;
  value: number;
  tone?: 'default' | 'accent' | 'degraded' | 'failing' | 'dim';
  hint?: ReactNode;
  hintMinLines?: number;
  replayKey?: string | number;
}) {
  const toneClass = tone === 'accent' ? 'text-accent-ink' : tone === 'degraded' ? 'text-degraded' : tone === 'failing' ? 'text-failing' : tone === 'dim' ? 'text-dim' : 'text-ink';
  return (
    <StatCell>
      <div className="min-w-0">
        <div className="kicker truncate">{label}</div>
        <div className={`font-display tabular mt-1 text-[28px] leading-none ${toneClass}`}>
          <CountUp value={value} replayKey={replayKey} />
        </div>
        {hint && (
          // 1.375 is leading-snug; the floor is that many lines of it.
          <div className="mt-1.5 text-[11.5px] leading-snug text-faint" style={hintMinLines ? { minHeight: `${hintMinLines * 1.375}em` } : undefined}>
            {hint}
          </div>
        )}
      </div>
    </StatCell>
  );
}

/** A figure that may be unknown. Null renders as "Not recorded" and the reason; never as 0. */
export function MetricCell({ label, metric, suffix, compareLabel = 'last week', replayKey }: { label: string; metric: Metric; suffix?: string; compareLabel?: string; replayKey?: string | number }) {
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
              <CountUp value={value} replayKey={replayKey} />
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

/**
 * A small bar series, or the sentence saying why there is none.
 *
 * A series with no points is not drawn as an empty axis: rule five of the
 * refinement pass — a section with no data says so, in the middle of the space
 * the chart would have filled. `bare` drops the internal title for a card that
 * already carries one, and lets the block grow to fill that card.
 */
export function SeriesBlock({
  title,
  series,
  tone = 'ink',
  height = 44,
  total,
  replayKey,
  note,
  bare,
  layout = 'bottom',
  footnote = true,
}: {
  title: string;
  series: MetricSeries;
  tone?: 'ink' | 'accent' | 'degraded';
  height?: number;
  total?: boolean;
  replayKey?: string | number;
  note?: ReactNode;
  /** The card supplies the title; this block supplies only the body. */
  bare?: boolean;
  /**
   * How the body uses a card taller than it is. `bottom` keeps the total sitting
   * on the chart, which is right for a lone card. `spread` puts the total at the
   * top and the chart on the floor, so a row of these cards has its totals on
   * one line and its charts on one baseline.
   */
  layout?: 'bottom' | 'spread';
  /**
   * Whether the series' own note is drawn under the chart. A card that pins the
   * same sentence to its own floor passes false — otherwise it appears twice,
   * and the one under the chart is what puts the charts on different baselines.
   */
  footnote?: boolean;
}) {
  const pts = series.points;
  return (
    <div className={`min-w-0 ${bare ? 'flex h-full flex-col' : ''}`}>
      {!bare && (
        <div className="mb-1.5 flex items-baseline justify-between gap-3">
          <div className="text-[13px] font-medium text-ink">{title}</div>
          {pts && total && (
            <div className="tabular text-[12px] text-dim">
              <CountUp value={pts.reduce((n, p) => n + p.value, 0)} replayKey={replayKey} /> total
            </div>
          )}
        </div>
      )}
      {pts ? (
        <div className={bare ? `flex flex-1 flex-col ${layout === 'spread' ? 'justify-between' : 'justify-end'}` : ''}>
          {bare && total && (
            <div className="tabular mb-1 text-[12px] text-dim">
              <CountUp value={pts.reduce((n, p) => n + p.value, 0)} replayKey={replayKey} /> total
            </div>
          )}
          <Bars values={pts.map((p) => p.value)} labels={pts.map((p) => p.label)} height={height} tone={tone} highlightLast={false} replayKey={replayKey} />
          <div className="mt-1 flex justify-between text-[10.5px] text-faint">
            <span>{pts[0]?.label}</span>
            <span>{pts[pts.length - 1]?.label}</span>
          </div>
        </div>
      ) : (
        <EmptyPanel min={bare ? 84 : 56}>{series.note ?? 'Not recorded.'}</EmptyPanel>
      )}
      {/* When the series is null its reason is the empty state itself, so it is not repeated underneath. */}
      {pts && footnote && series.note && <div className="mt-2 text-[11.5px] leading-snug text-faint">{series.note}</div>}
      {note}
    </div>
  );
}

/**
 * How long ago, in words. "just now", "4 min ago", "3 h ago", "2 d ago".
 *
 * Relative rather than absolute because the question a reader actually has is
 * "can I trust this number right now", and "18:27 UTC" does not answer it
 * without arithmetic.
 */
export function relativeTime(iso: string | null, now = Date.now()): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const secs = Math.max(0, Math.round((now - t) / 1000));
  if (secs < 45) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/**
 * How old the rows are and where they came from, in one line, in the same
 * place on every page.
 *
 * There is nothing to resync and no "last synced" to print (13 Sep 2026): the
 * engine writes these rows into this database and the page reads the same row,
 * so the only honest age is when one of them last changed here. The age
 * re-renders on a timer, so a tab left open does not keep claiming the rows
 * changed four minutes ago an hour later.
 *
 * `from_engine` is the count the engine or this interface has written since
 * the migration backfill. A kind still sitting entirely on backfilled rows is
 * a kind nothing is feeding, and it says so rather than looking current.
 */
export function RowsLine({ freshness, writes = true }: { freshness: Freshness; writes?: boolean }) {
  // A minute is the smallest unit shown, so a minute is often enough to tick.
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  if (freshness.source === 'none') {
    return <div className="text-[11.5px] text-degraded">{freshness.note ?? 'No rows of this kind are held.'}</div>;
  }
  const age = relativeTime(freshness.changed_at);
  const absolute = freshness.changed_at ? `${freshness.changed_at.replace('T', ' ').slice(0, 16)} UTC` : null;
  const tables = freshness.tables.length > 1 ? freshness.tables.map((t) => `${t.label} ${t.n}`).join(' · ') : null;

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-faint">
      <span title={tables ?? ''}>
        {freshness.rows} {freshness.rows === 1 ? 'row' : 'rows'}
        {tables ? ` across ${freshness.tables.length} tables` : ''}
      </span>
      <span className="text-dim" title={absolute ?? ''}>
        — newest change {age ?? 'at an unknown time'}
      </span>
      {/*
        Open loops passes writes={false}. It is the one kind this dashboard
        writes itself, so the count stops meaning "the engine is still feeding
        this" the moment anyone edits a loop here — one edit turns the warning
        off whether or not n8n has gone quiet. On the six read-only kinds it
        still says exactly what it says.
      */}
      {writes &&
        (freshness.from_engine === 0 ? (
          <span className="text-degraded">· none written since the migration backfill on 13 Sep 2026</span>
        ) : (
          <span>· {freshness.from_engine} written since the backfill</span>
        ))}
    </div>
  );
}

/* ------------------------------------------------ writes that did not land */

/**
 * The two states that mean this dashboard and Airtable disagree about a record.
 *
 * `duplicate` only happens to a loop — a move whose create landed and whose
 * delete did not — but it belongs here with `failed` because the reader's
 * problem is the same either way: what is on screen is not what Airtable holds.
 */
export function unlanded(w: RecordWrite | null | undefined): boolean {
  return w?.state === 'failed' || w?.state === 'duplicate';
}

/** The whole sentence, for the tooltip and the panel. */
export function writeWarning(w: RecordWrite, digestNote?: string): string {
  const tail = w.steps ? ` Completed: ${w.steps}.` : '';
  if (w.state === 'duplicate') return `${w.reason ?? 'This record exists in two tables.'}${tail}`;
  return `The change did not reach Airtable${w.http ? ` (HTTP ${w.http})` : ''}, so it still holds the old values. ${w.reason ?? 'No reason was given.'}${tail}${digestNote ? ` ${digestNote}` : ''}`;
}

/**
 * The marker that sits beside a record's status when its last write did not
 * land. Small, red, and never on anything else — the dashboard showing one
 * thing while Airtable holds another is a genuinely bad state.
 */
export function NotLanded({ write }: { write: RecordWrite }) {
  return (
    <span className="inline-flex items-center gap-1 text-[11px] leading-tight whitespace-nowrap text-failing">
      <span aria-hidden className="h-[6px] w-[6px] shrink-0 rounded-full bg-failing" />
      {write.state === 'duplicate' ? 'in two tables' : 'not in Airtable'}
    </span>
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
