import { createPortal } from 'react-dom';
import { useMemo, useState } from 'react';
import { useData } from '../app/useData';
import { getRecordMetrics, getRtTelemetry, resync, type RtCard, type RtMetrics } from '../data';
import {
  CountCell,
  CountUp,
  EmptyPanel,
  EmptyState,
  HBar,
  LoadFailed,
  Loading,
  MetricCard,
  PageHeader,
  Pagination,
  Pill,
  RecordList,
  RecordRow,
  Ring,
  RowAction,
  RowActions,
  SearchBox,
  Segmented,
  SeriesBlock,
  SourceLink,
  StatCell,
  StatStrip,
  SyncLine,
  Toast,
  usePaged,
  useToast,
} from '../components/ui';

/**
 * Research Twin's queue.
 *
 * The Research Queue is an attempt log — one row per research attempt, with
 * card_id repeating — so every figure here is per card, collapsed on card_id
 * with the newest attempt deciding the state. The row count is printed beside
 * the card count so the two are never mistaken for each other.
 *
 * Cards at requires_human come first, because they are the only ones nothing
 * else in the engine will move.
 */

type Filter = 'all' | 'needs-human' | 'stuck' | 'untriaged' | string;

function StatusPill({ card }: { card: RtCard }) {
  if (!card.status) return <Pill>untriaged</Pill>;
  if (card.status === 'resolved') return <Pill tone="ok">resolved</Pill>;
  if (card.status === 'completed') return <Pill tone="accent">completed</Pill>;
  return <Pill>{card.status}</Pill>;
}

function matches(c: RtCard, q: string): boolean {
  if (!q) return true;
  const n = q.toLowerCase();
  return [c.card_id, c.lane_id, c.hypothesis, c.research_summary, c.gap_classification, c.missing_elements, c.target_source_types].some((v) => v && v.toLowerCase().includes(n));
}

/* ---------------------------------------------------------------- metrics */

function RtMetricsPanel({ metrics, loading, error }: { metrics: RtMetrics | null; loading: boolean; error: string | null }) {
  if (error) return <div className="card mx-6 mb-4 px-5 py-4 text-[12.5px] text-failing md:mx-8">Figures unavailable: {error}</div>;
  if (!metrics) {
    return (
      <StatStrip cols={4} className="opacity-60">
        {['Needs a human', 'Cards', 'Untriaged', 'Longest stuck'].map((l) => (
          <StatCell key={l}>
            <div className="kicker truncate">{l}</div>
            <div className="mt-1 text-[15px] text-faint">{loading ? 'Counting' : 'No figures'}</div>
          </StatCell>
        ))}
      </StatStrip>
    );
  }
  const m = metrics;
  const maxStatus = Math.max(1, ...m.by_status.map((s) => s.n));
  const maxStuck = Math.max(1, ...m.days_stuck.map((s) => s.n));
  const maxRun = Math.max(1, ...m.run_count_mix.map((r) => r.n));
  const maxGap = Math.max(1, ...m.gap_mix.map((g) => g.n));

  return (
    <div className={loading ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
      <StatStrip cols={4}>
        {/* The hard stop leads: these cards are the only ones that will not move on their own. */}
        <CountCell label="Needs a human" value={m.requires_human.n} tone={m.requires_human.n ? 'degraded' : 'dim'} hint="requires_human is ticked" />
        <CountCell label="Cards" value={m.scope.cards} hint={`${m.scope.rows} attempt rows`} />
        <CountCell label="Untriaged" value={m.untriaged.n} tone="dim" hint="no status set" />
        <StatCell>
          <div className="min-w-0">
            <div className="kicker truncate">Longest stuck</div>
            <div className={`font-display tabular mt-1 text-[28px] leading-none ${(m.oldest_stuck.days ?? 0) > 14 ? 'text-degraded' : 'text-ink'}`}>
              {m.oldest_stuck.days === null ? '—' : <CountUp value={m.oldest_stuck.days} />}
              {m.oldest_stuck.days !== null && <span className="ml-1 text-[13px] text-faint">d</span>}
            </div>
            <div className="mt-1.5 truncate text-[11.5px] leading-snug text-faint" title={m.oldest_stuck.card_id ?? ''}>
              {m.oldest_stuck.card_id ?? 'nothing is stuck'}
            </div>
          </div>
        </StatCell>
      </StatStrip>

      <div className="mx-6 mb-4 grid items-stretch gap-4 md:mx-8 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <div className="card flex h-full flex-col justify-between px-5 py-4">
          <div className="flex items-center gap-5">
            <Ring value={m.requires_human.n} total={m.scope.cards} size={88} tone={m.requires_human.n ? 'degraded' : 'accent'} label="need a human" />
            <div className="min-w-0">
              <div className="kicker">At the hard stop</div>
              <div className="mt-1 flex items-baseline gap-2">
                <span className="font-display tabular text-[32px] leading-none text-ink">
                  <CountUp value={m.requires_human.n} />
                </span>
                <span className="text-[14px] text-faint">of {m.scope.cards}</span>
              </div>
              <div className="mt-1.5 text-[11.5px] leading-snug text-faint">{m.requires_human.note}</div>
            </div>
          </div>
          {/*
            How much of the queue is still moving on its own. The hard stop and
            the untriaged pile are the two ways a card stops moving, and neither
            is stated anywhere else on the page as a share of the whole.
          */}
          <div className="mt-4 space-y-2 border-t border-line pt-3">
            <HBar
              label="Still moving on its own"
              value={m.scope.cards - m.requires_human.n - m.untriaged.n}
              max={Math.max(1, m.scope.cards)}
              tone="accent"
              valueNode={<CountUp value={m.scope.cards - m.requires_human.n - m.untriaged.n} />}
              right={<span className="text-faint">of {m.scope.cards}</span>}
            />
            <div className="text-[11.5px] leading-snug text-faint">{m.untriaged.note}</div>
          </div>
        </div>

        <MetricCard title="Queue depth by status" note={m.status_note}>
          {m.by_status.length === 0 ? (
            <EmptyPanel>The queue is empty.</EmptyPanel>
          ) : (
            <div className="space-y-2">
              {m.by_status.map((s) => (
                <HBar
                  key={s.status}
                  label={s.label}
                  value={s.n}
                  max={maxStatus}
                  tone={s.status === 'resolved' ? 'accent' : 'ink'}
                  valueNode={<CountUp value={s.n} />}
                  right={<span className="text-faint">{m.scope.cards ? Math.round((s.n / m.scope.cards) * 100) : 0}%</span>}
                />
              ))}
            </div>
          )}
        </MetricCard>
      </div>

      <div className="mx-6 mb-4 grid items-stretch gap-4 md:mx-8 md:grid-cols-3">
        <MetricCard title="Days stuck" note={m.days_stuck_note}>
          {m.days_stuck.every((b) => b.n === 0) ? (
            <EmptyPanel>No card carries a first_stuck_at, so nothing has been recorded as stuck.</EmptyPanel>
          ) : (
            <div className="space-y-2">
              {m.days_stuck.map((b) => (
                <HBar key={b.bucket} label={b.bucket} value={b.n} max={maxStuck} tone={b.bucket.startsWith('over') ? 'degraded' : 'ink'} valueNode={<CountUp value={b.n} />} />
              ))}
            </div>
          )}
        </MetricCard>

        <MetricCard title="Attempts per card" note={m.run_count_note}>
          {m.run_count_mix.length === 0 ? (
            <EmptyPanel>No card records a run count.</EmptyPanel>
          ) : (
            <div className="space-y-2">
              {m.run_count_mix.map((r) => (
                <HBar key={r.runs} label={r.runs} value={r.n} max={maxRun} tone={r.runs.startsWith('3') || r.runs.startsWith('over') ? 'degraded' : 'ink'} valueNode={<CountUp value={r.n} />} />
              ))}
            </div>
          )}
        </MetricCard>

        <MetricCard title="What kind of stuck" note="From gap_classification, set on any attempt that came back low-confidence.">
          {m.gap_mix.length === 0 ? (
            <EmptyPanel>No card records a gap classification.</EmptyPanel>
          ) : (
            <div className="space-y-2">
              {m.gap_mix.map((g) => (
                <HBar key={g.gap} label={g.gap} value={g.n} max={maxGap} valueNode={<CountUp value={g.n} />} />
              ))}
            </div>
          )}
        </MetricCard>
      </div>

      <div className="mx-6 mb-4 grid items-stretch gap-4 md:mx-8 md:grid-cols-2">
        <MetricCard title="Cards created per week">
          <SeriesBlock title="" series={m.created_per_week} tone="accent" total bare />
        </MetricCard>
        <MetricCard title="Confidence" note="confidence_level as set on each card's newest attempt.">
          {m.confidence_mix.length === 0 ? (
            <EmptyPanel>No card records a confidence level.</EmptyPanel>
          ) : (
            <div className="space-y-2">
              {m.confidence_mix.map((c) => (
                <HBar
                  key={c.level}
                  label={c.level}
                  value={c.n}
                  max={Math.max(1, ...m.confidence_mix.map((x) => x.n))}
                  tone={c.level === 'low' ? 'degraded' : 'ink'}
                  valueNode={<CountUp value={c.n} />}
                />
              ))}
            </div>
          )}
        </MetricCard>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ card view */

function CardView({ c, onClose }: { c: RtCard; onClose: () => void }) {
  const fields: { label: string; value: string | null }[] = [
    { label: 'Hypothesis to validate', value: c.hypothesis },
    { label: 'Research summary', value: c.research_summary },
    { label: 'What evidence is missing', value: c.missing_elements },
    { label: 'What would resolve it', value: c.target_source_types },
  ];
  return createPortal(
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/30 p-4 md:p-10" onClick={onClose}>
      <div className="card fade-up w-full max-w-[880px] px-6 py-5" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Research card">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="kicker tabular truncate">{c.card_id}</div>
            <h2 className="mt-1 text-[18px] leading-tight">{c.lane_id ?? 'no lane'}</h2>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-faint">
              <StatusPill card={c} />
              {c.requires_human && <Pill tone="degraded">needs a human</Pill>}
              <span>
                {c.run_count} attempt{c.run_count === 1 ? '' : 's'}
              </span>
              {c.days_stuck !== null && <span className={c.days_stuck > 14 ? 'text-degraded' : ''}>stuck {c.days_stuck} d</span>}
              {c.confidence_level && <span>confidence {c.confidence_level}</span>}
              <span title="How many rows in the Research Queue are this one card">
                {c.attempts} row{c.attempts === 1 ? '' : 's'}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <a href={c.airtable.url} target="_blank" rel="noreferrer" className="btn btn-ghost btn-sm">
              Open in Airtable
            </a>
            <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
              Close
            </button>
          </div>
        </div>

        {c.first_stuck_at && (
          <p className="mt-3 text-[12.5px] leading-snug text-dim">
            First went stuck {c.first_stuck_at.slice(0, 10)}
            {c.gap_classification ? ` — ${c.gap_classification.replace(/_/g, ' ')}` : ''}. That stamp is not re-set on later attempts, so it is the age of the problem rather than the age of the last retry.
          </p>
        )}

        <div className="mt-4 space-y-4 border-t border-line pt-4">
          {fields.filter((f) => f.value).length === 0 ? (
            <p className="text-[12.5px] text-faint">This card carries no hypothesis, summary or gap detail — only its status and attempt count.</p>
          ) : (
            fields
              .filter((f) => f.value)
              .map((f) => (
                <div key={f.label}>
                  <div className="mb-0.5 text-[11px] text-faint">{f.label}</div>
                  <p className="text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink">{f.value}</p>
                </div>
              ))
          )}
          <div className="flex items-center justify-between gap-2 border-t border-line pt-3 text-[11.5px] text-faint">
            <SourceLink source={c.source} />
            <span>{c.source_system ? `written by ${c.source_system}` : 'no source system recorded'}</span>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/* ------------------------------------------------------------------ page */

export default function ResearchTwin() {
  const [reload, setReload] = useState(0);
  const { status, data: loaded, error } = useData(getRtTelemetry, [reload]);
  const [filter, setFilter] = useState<Filter>('needs-human');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const { toast, setToast } = useToast();
  const metrics = useData(() => getRecordMetrics('rt', { lane: 'all' }), [reload]);

  const cards = loaded?.cards ?? [];
  const statuses = useMemo(() => [...new Set(cards.map((c) => c.status).filter((v): v is string => Boolean(v)))].sort(), [cards]);
  const rows = useMemo(
    () =>
      cards
        .filter((c) =>
          filter === 'all'
            ? true
            : filter === 'needs-human'
              ? c.requires_human
              : filter === 'stuck'
                ? c.days_stuck !== null
                : filter === 'untriaged'
                  ? !c.status
                  : c.status === filter,
        )
        .filter((c) => matches(c, q.trim()))
        // Newest first by last attempt; a card needing a human sorts above the rest.
        .sort((a, b) => Number(b.requires_human) - Number(a.requires_human) || (b.last_attempt_at ?? '').localeCompare(a.last_attempt_at ?? '')),
    [cards, filter, q],
  );
  const paged = usePaged(rows, `${filter}|${q.trim()}`);

  async function pull() {
    setSyncing(true);
    try {
      const r = await resync('rt');
      const t = r.results[0]?.tables[0];
      setToast(t?.error ? { text: `Resync failed: ${t.error}`, tone: 'failing' } : { text: `Resync read ${t?.n ?? 0} queue rows.`, tone: 'ok' });
      setReload((n) => n + 1);
    } catch (e) {
      setToast({ text: e instanceof Error ? e.message : 'The resync did not run.', tone: 'failing' });
    } finally {
      setSyncing(false);
    }
  }

  if (status === 'loading' || !loaded) return status === 'error' ? <LoadFailed error={error} /> : <Loading />;
  const current = open ? cards.find((c) => c.card_id === open) : null;
  const counts = {
    all: cards.length,
    'needs-human': cards.filter((c) => c.requires_human).length,
    stuck: cards.filter((c) => c.days_stuck !== null).length,
    untriaged: cards.filter((c) => !c.status).length,
  };

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <PageHeader title="Research Twin" subtitle="The research queue, and what is waiting on a person" />

      <div className="scroll-thin flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto">
        <div className="shrink-0 px-6 pb-3 md:px-8">
          <SyncLine sync={loaded.sync} onResync={pull} busy={syncing} />
        </div>

        <RtMetricsPanel metrics={metrics.data} loading={metrics.status === 'loading'} error={metrics.error} />

        <div className="shrink-0 space-y-3 px-6 pb-3 md:px-8">
          <Segmented<Filter>
            ariaLabel="Filter cards"
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'needs-human', label: 'Needs a human', count: counts['needs-human'] },
              { value: 'stuck', label: 'Ever stuck', count: counts.stuck },
              ...(counts.untriaged ? [{ value: 'untriaged' as Filter, label: 'Untriaged', count: counts.untriaged }] : []),
              ...statuses.map((st) => ({ value: st as Filter, label: st.charAt(0).toUpperCase() + st.slice(1), count: cards.filter((c) => c.status === st).length })),
              { value: 'all', label: 'All', count: counts.all },
            ]}
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[11.5px] leading-snug text-faint">{loaded.shape.note}</span>
            <div className="flex flex-1 items-center justify-end gap-3">
              <SearchBox value={q} onChange={setQ} placeholder="Search cards, hypotheses and gaps" />
            </div>
          </div>
        </div>

        {rows.length === 0 ? (
          <EmptyState>
            {loaded.sync.source === 'none'
              ? (loaded.sync.error ?? 'Nothing has been read from Airtable yet.')
              : q.trim()
                ? 'No card matches that search in this filter.'
                : filter === 'needs-human'
                  ? 'No card has reached the hard stop. Nothing in the queue is waiting on a person.'
                  : filter === 'stuck'
                    ? 'No card carries a first_stuck_at, so nothing has ever been recorded as stuck.'
                    : filter === 'untriaged'
                      ? 'Every card carries a status.'
                      : `No card is ${filter}.`}
          </EmptyState>
        ) : (
          <>
            <RecordList>
              {paged.rows.map((c) => (
                <RecordRow
                  key={c.card_id}
                  id={
                    <span className="flex flex-wrap items-center gap-x-2">
                      <span className="truncate">{c.card_id}</span>
                      <span className="text-faint">{c.lane_id ?? 'no lane'}</span>
                    </span>
                  }
                  title={c.hypothesis ?? c.research_summary ?? c.card_id}
                  summary={c.missing_elements ?? c.research_summary}
                  summaryEmpty="No hypothesis, summary or missing-evidence note on this card."
                  meta={
                    <>
                      <StatusPill card={c} />
                      {c.requires_human && <Pill tone="degraded">needs a human</Pill>}
                      {c.days_stuck !== null && <span className={c.days_stuck > 14 ? 'text-degraded' : ''}>stuck {c.days_stuck} d</span>}
                      <span title={`${c.attempts} rows in the queue for this card`}>
                        {c.run_count} attempt{c.run_count === 1 ? '' : 's'}
                      </span>
                      <SourceLink source={c.source} />
                    </>
                  }
                  actions={
                    <RowActions>
                      <RowAction label="View" tone="accent" onClick={() => setOpen(c.card_id)} />
                      <RowAction label="Open in Airtable" onClick={() => window.open(c.airtable.url, '_blank', 'noreferrer')} />
                    </RowActions>
                  }
                  onOpen={() => setOpen(c.card_id)}
                />
              ))}
            </RecordList>
            <Pagination paged={paged} unit="cards" />
          </>
        )}
      </div>

      {current && <CardView c={current} onClose={() => setOpen(null)} />}
      <Toast toast={toast} />
    </div>
  );
}
