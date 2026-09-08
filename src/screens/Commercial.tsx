import { useEffect, useMemo, useState } from 'react';
import { useData } from '../app/useData';
import { BUILDER_NAMES, getCommercial, getRecordMetrics, setRecordStatus, type Opportunity, type Readiness } from '../data';
import {
  BuilderFilter,
  Dot,
  EmptyState,
  LoadFailed,
  Loading,
  MetricsStrip,
  PageHeader,
  RowAction,
  RowActions,
  Segmented,
  SPINE_HEADERS,
  SourceLink,
  SpineCells,
  TableFrame,
  Th,
  Toast,
  useToast,
} from '../components/ui';
import { healthText } from '../lib';

/** Readiness states in order, so a card's position in the run-up is visible. */
const ORDER: Readiness[] = ['idea', 'researching', 'evidence thin', 'ready to pitch', 'blocked', 'closed'];
const NEXT: Partial<Record<Readiness, Readiness>> = { idea: 'researching', researching: 'evidence thin', 'evidence thin': 'ready to pitch' };

type StatusFilter = 'all' | 'open' | Readiness;

export default function Commercial() {
  const { status, data: loaded, error } = useData(getCommercial);
  const [cards, setCards] = useState<Opportunity[]>([]);
  const [builder, setBuilder] = useState('all');
  const [filter, setFilter] = useState<StatusFilter>('open');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const { toast, setToast } = useToast();
  const metrics = useData((q) => getRecordMetrics('commercial', q, builder), [builder, tick]);

  useEffect(() => {
    if (loaded) setCards(loaded.opportunities);
  }, [loaded]);

  const byBuilder = useMemo(() => {
    const c: Record<string, number> = {};
    for (const o of cards) c[o.owner] = (c[o.owner] ?? 0) + 1;
    return c;
  }, [cards]);

  const scoped = useMemo(() => cards.filter((o) => builder === 'all' || o.owner === builder), [cards, builder]);
  const count = (r: Readiness) => scoped.filter((o) => o.readiness === r).length;
  const rows = scoped.filter((o) => (filter === 'all' ? true : filter === 'open' ? o.readiness !== 'closed' : o.readiness === filter));

  async function change(o: Opportunity, next: Readiness) {
    setBusyId(o.id);
    try {
      const updated = await setRecordStatus('commercial', o.id, next);
      setCards((list) => list.map((x) => (x.id === updated.id ? updated : x)));
      setTick((n) => n + 1);
      setToast({ text: next === 'closed' ? 'Card closed.' : `Moved to ${next}.`, tone: 'ok' });
    } catch (err) {
      setToast({ text: err instanceof Error ? err.message : 'The change did not save.', tone: 'failing' });
    } finally {
      setBusyId(null);
    }
  }

  if (status === 'loading' || !loaded) return status === 'error' ? <LoadFailed error={error} /> : <Loading />;

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <PageHeader title="Commercial" subtitle="Opportunities and readiness" />

      <MetricsStrip metrics={metrics.data} loading={metrics.status === 'loading'} error={metrics.error} />

      <div className="shrink-0 space-y-3 px-6 pb-3 md:px-8">
        <BuilderFilter counts={byBuilder} value={builder} onChange={setBuilder} />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Segmented<StatusFilter>
            ariaLabel="Filter by readiness"
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'open', label: 'Open', count: scoped.filter((o) => o.readiness !== 'closed').length },
              ...ORDER.map((r) => ({ value: r, label: r.charAt(0).toUpperCase() + r.slice(1), count: count(r) })),
              { value: 'all', label: 'All', count: scoped.length },
            ]}
          />
          <span className="text-[11.5px] text-faint">
            Showing <span className="tabular text-dim">{rows.length}</span> cards
          </span>
        </div>
      </div>

      {rows.length === 0 ? (
        <EmptyState>No commercial opportunities match the selected lane, owner and readiness.</EmptyState>
      ) : (
        <TableFrame>
          <thead>
            <tr>
              <Th />
              <Th>card</Th>
              <Th>title</Th>
              <Th>readiness</Th>
              <Th>blocker</Th>
              <Th>owner</Th>
              {SPINE_HEADERS.map((h) => (
                <Th key={h}>{h}</Th>
              ))}
              <Th>last touched</Th>
              <Th>source</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {rows.map((o) => {
              const busy = busyId === o.id;
              const next = NEXT[o.readiness];
              return (
                <tr key={o.id} className={busy ? 'opacity-60' : ''}>
                  <td className="td">
                    <Dot health={o.health} />
                  </td>
                  <td className="td tabular text-faint">{o.id}</td>
                  <td className="td card-title td-clip" style={{ maxWidth: '40ch' }}>
                    {o.title}
                  </td>
                  <td className={`td card-meta ${o.readiness === 'closed' ? 'text-faint' : healthText(o.health)}`}>{o.readiness}</td>
                  <td className="td td-clip text-faint" style={{ maxWidth: '46ch' }}>
                    {o.blocker ?? '—'}
                  </td>
                  <td className="td card-meta text-dim">{BUILDER_NAMES[o.owner] ?? o.owner}</td>
                  <SpineCells spine={o.spine} />
                  <td className="td tabular text-faint">{o.last_touched}</td>
                  <td className="td">
                    <SourceLink source={o.source} />
                  </td>
                  <td className="td card-actions td-actions">
                    <RowActions>
                      {next && <RowAction label={`Move to ${next}`} tone="accent" disabled={busy} onClick={() => change(o, next)} />}
                      {o.readiness === 'blocked' && <RowAction label="Unblock" tone="accent" disabled={busy} onClick={() => change(o, 'researching')} />}
                      {o.readiness !== 'blocked' && o.readiness !== 'closed' && <RowAction label="Block" disabled={busy} onClick={() => change(o, 'blocked')} />}
                      {o.readiness !== 'closed' ? (
                        <RowAction label="Close" disabled={busy} onClick={() => change(o, 'closed')} />
                      ) : (
                        <RowAction label="Reopen" tone="accent" disabled={busy} onClick={() => change(o, 'researching')} />
                      )}
                      <RowAction label="Open in Airtable" onClick={() => window.open(o.source.url, '_blank', 'noreferrer')} />
                    </RowActions>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </TableFrame>
      )}
      <Toast toast={toast} />
    </div>
  );
}
