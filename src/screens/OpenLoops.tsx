import { useMemo, useState } from 'react';
import { useData } from '../app/useData';
import { BUILDER_NAMES, getOpenLoops } from '../data';
import {
  EmptyState,
  Loading,
  LoadFailed,
  PageHeader,
  RowAction,
  RowActions,
  SPINE_HEADERS,
  SourceLink,
  SpineCells,
  TableFrame,
  TagRow,
  Th,
  act,
} from '../components/ui';

const TABS = ['Loops', 'Review queue', 'Reconciliation'] as const;
type Tab = (typeof TABS)[number];

/** Age is the headline signal on this page, so it carries the only colour. */
function ageTone(days: number): string {
  if (days >= 30) return 'text-failing';
  if (days >= 14) return 'text-degraded';
  return 'text-dim';
}

export default function OpenLoops() {
  const [tab, setTab] = useState<Tab>('Loops');
  const [owner, setOwner] = useState<string>('all');
  const { status, data, error } = useData(getOpenLoops);

  const loops = useMemo(
    () => (data ? data.loops.filter((l) => owner === 'all' || l.owner === owner) : []),
    [data, owner],
  );

  if (status === 'loading') return <Loading />;
  if (status === 'error') return <LoadFailed error={error} />;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="Open loops"
        subtitle="Oldest first"
        right={
          <div className="flex items-center gap-4">
            {TABS.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={`border-b-2 pb-1 text-[12px] ${
                  tab === t ? 'border-gold text-ink' : 'border-transparent text-faint hover:text-dim'
                }`}
              >
                {t}
                {t === 'Review queue' && data.review_queue.length > 0 && (
                  <span className="tabular ml-1.5 text-faint">{data.review_queue.length}</span>
                )}
                {t === 'Reconciliation' && data.reconciliation.length > 0 && (
                  <span className="tabular ml-1.5 text-degraded">{data.reconciliation.length}</span>
                )}
              </button>
            ))}
          </div>
        }
      />

      {tab === 'Loops' && (
        <div className="flex min-h-0 flex-1 flex-col">
          {/* Grouped by owner, so where work is piling up is visible at a glance. */}
          <div className="flex shrink-0 items-stretch border-b border-line">
            <button
              type="button"
              onClick={() => setOwner('all')}
              className={`border-r border-line px-3 py-1.5 text-left ${
                owner === 'all' ? 'bg-raised' : 'hover:bg-hover'
              }`}
            >
              <div className="text-[11px] text-faint">All owners</div>
              <div className="tabular text-[15px] leading-tight">
                {data.by_owner.reduce((n, o) => n + o.open, 0)}
              </div>
            </button>
            {data.by_owner.map((o) => (
              <button
                key={o.owner}
                type="button"
                onClick={() => setOwner(o.owner)}
                className={`flex-1 border-r border-line px-3 py-1.5 text-left last:border-r-0 ${
                  owner === o.owner ? 'bg-raised' : 'hover:bg-hover'
                }`}
              >
                <div className="text-[11px] text-faint">{BUILDER_NAMES[o.owner] ?? o.owner}</div>
                <div className="flex items-baseline gap-2">
                  <span className="tabular text-[15px] leading-tight">{o.open}</span>
                  <span className={`tabular text-[11px] ${ageTone(o.oldest_days)}`}>
                    {o.oldest_days}d
                  </span>
                </div>
              </button>
            ))}
          </div>

          <p className="shrink-0 border-b border-line px-4 py-1 text-[11px] text-faint">
            {data.status_history_note}
          </p>

          {loops.length === 0 ? (
            <EmptyState>
              No loops match the selected lane and owner. The per-owner counts above are
              totals; the rows here are the loops this dashboard currently holds.
            </EmptyState>
          ) : (
            <TableFrame>
              <thead>
                <tr>
                  <Th className="text-right">age</Th>
                  <Th>loop</Th>
                  <Th>title</Th>
                  <Th>tags</Th>
                  <Th>owner</Th>
                  <Th>status</Th>
                  {SPINE_HEADERS.map((h) => (
                    <Th key={h}>{h}</Th>
                  ))}
                  <Th>raised</Th>
                  <Th>source</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {loops.map((l) => (
                  <tr key={l.id}>
                    <td className={`td tabular text-right ${ageTone(l.age_days)}`} title="Days since raised">
                      {l.age_days}d
                    </td>
                    <td className="td tabular text-faint">{l.id}</td>
                    <td className="td td-clip" style={{ maxWidth: '52ch' }} title={l.title}>
                      {l.title}
                    </td>
                    <td className="td"><TagRow tags={l.tags} /></td>
                    <td className="td text-dim">{BUILDER_NAMES[l.owner] ?? l.owner}</td>
                    <td className={`td ${l.status === 'in progress' ? 'text-dim' : 'text-faint'}`}>
                      {l.status}
                    </td>
                    <SpineCells spine={l.spine} />
                    <td className="td tabular text-faint">{l.raised_at}</td>
                    <td className="td">
                      <SourceLink source={l.source} />
                    </td>
                    <td className="td">
                      <RowActions>
                        <RowAction label="close" onClick={() => act('loop.close', l.id)} />
                        <RowAction label="update" onClick={() => act('loop.update', l.id)} />
                        <RowAction
                          label="open in Slack"
                          onClick={() => act('loop.open-slack', l.id)}
                        />
                      </RowActions>
                    </td>
                  </tr>
                ))}
              </tbody>
            </TableFrame>
          )}
        </div>
      )}

      {tab === 'Review queue' && (
        <div className="flex min-h-0 flex-1 flex-col">
          <p className="shrink-0 border-b border-line px-4 py-1.5 text-[11px] text-faint">
            Proposed closes for stale loops. Each carries its supporting citation. Nothing
            closes automatically — approve or reject each one.
          </p>
          {data.review_queue.length === 0 ? (
            <EmptyState>Nothing is currently proposed for closing.</EmptyState>
          ) : (
            <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
              {data.review_queue.map((p) => (
                <div key={p.id} className="rowlike border-b border-line px-4 py-2">
                  <div className="flex items-baseline gap-3">
                    <span className={`tabular ${ageTone(p.age_days)}`}>{p.age_days}d</span>
                    <span className="tabular text-faint">{p.loop_id}</span>
                    <span className="min-w-0 flex-1">{p.title}</span>
                    <span className="text-dim">{BUILDER_NAMES[p.owner] ?? p.owner}</span>
                    <RowActions>
                      <RowAction label="approve close" onClick={() => act('review.approve', p.id)} />
                      <RowAction label="reject" onClick={() => act('review.reject', p.id)} />
                    </RowActions>
                  </div>
                  <div className="mt-0.5 max-w-[92ch] text-dim">{p.reason}</div>
                  <blockquote className="mt-1 max-w-[92ch] border-l border-line pl-2 text-faint italic">
                    “{p.citation.text}” <SourceLink source={p.citation.source} />
                  </blockquote>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'Reconciliation' && (
        <div className="flex min-h-0 flex-1 flex-col">
          <p className="shrink-0 border-b border-line px-4 py-1.5 text-[11px] text-faint">
            {data.reconciliation_note}
          </p>
          {data.reconciliation.length === 0 ? (
            <EmptyState>
              Every loop the digest names was found in exactly one builder table.
            </EmptyState>
          ) : (
            <TableFrame>
              <thead>
                <tr>
                  <Th>loop</Th>
                  <Th>title</Th>
                  <Th>expected owner</Th>
                  <Th>found in</Th>
                  <Th>discrepancy</Th>
                  <Th>source</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {data.reconciliation.map((r) => (
                  <tr key={r.id}>
                    <td className="td tabular text-faint">{r.loop_id}</td>
                    <td className="td td-clip" style={{ maxWidth: '46ch' }}>{r.title}</td>
                    <td className="td text-dim">{BUILDER_NAMES[r.expected_owner] ?? r.expected_owner}</td>
                    <td className={`td ${r.found_in ? 'text-degraded' : 'text-failing'}`}>
                      {r.found_in ?? 'no table'}
                    </td>
                    <td className="td td-clip text-faint" style={{ maxWidth: '52ch' }}>{r.discrepancy}</td>
                    <td className="td">
                      <SourceLink source={r.source} />
                    </td>
                    <td className="td">
                      <RowActions>
                        <RowAction label="reassign" onClick={() => act('reconcile.reassign', r.id)} />
                        <RowAction label="ignore" onClick={() => act('reconcile.ignore', r.id)} />
                      </RowActions>
                    </td>
                  </tr>
                ))}
              </tbody>
            </TableFrame>
          )}
        </div>
      )}
    </div>
  );
}
