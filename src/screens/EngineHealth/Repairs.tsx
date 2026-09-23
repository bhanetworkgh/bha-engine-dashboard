import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useData } from '../../app/useData';
import { getRepairs, revertRepair, type Repair, type RepairsData, type RepairSummary } from '../../data';
import type { RecordColumn } from '../../components/ui';
import { ButtonAnchor, Pagination, Button, Definition, FigureCell, Pill, LoadFailed, Loading, EmptyState, RecordId, RecordTable, SearchBox, Segmented, StatStrip, usePaged } from '../../components/ui';
import { Fact, when } from './parts';
import { REPAIR_OUTCOME_DEFS, REPAIR_STATE_DEFS, REVERT_GUARD_DEFS } from './definitions';
import { HEALTH_KINDS } from './kinds';

/**
 * The repair record — every automated repair, and the way back from one.
 *
 * Built 2026-09-20 with `bha-repair-bridge`, which runs Claude Code against a
 * failing workflow and posts its result to `POST /api/engine/repair`.
 *
 * The rule the tab is built around: **nothing heals invisibly.** Every failure
 * ends as retried, repaired, or waiting on a person, and every repair shows the
 * error, the root cause, the exact change, and a way back. So:
 *
 * **A repair is only repaired where the bridge said so and a version came
 * back.** Nothing here counts a repair because the bridge was called. The
 * server decides `can_revert` and this page asks rather than working it out a
 * second time, so the button and the endpoint cannot disagree about what is
 * revertible.
 *
 * **`human_action` is the whole value of a needs-human outcome**, so it is on
 * the row rather than behind the click: a repair that ended by naming what a
 * person should do has said the most useful thing it will ever say.
 *
 * **A revert is not styled as an undo.** It brings back the failure the repair
 * addressed, and the confirmation and the result both say so.
 */

type Filter = 'all' | 'repaired' | 'needs_human' | 'not_repaired' | 'reverted';

/** One line per filter word, from repairs.ts and the bridge's vocabulary — see definitions.ts. */
const FILTER_DEF: Record<Filter, string> = {
  all: 'Every result the repair bridge has reported, whatever came of it, including skipped attempts, which no other filter shows.',
  repaired: REPAIR_OUTCOME_DEFS.repaired,
  needs_human: REPAIR_OUTCOME_DEFS.needs_human,
  not_repaired: `Two outcomes. Not repaired: ${REPAIR_OUTCOME_DEFS.not_repaired} Bridge error: ${REPAIR_OUTCOME_DEFS.error}`,
  reverted: REPAIR_STATE_DEFS.reverted,
};
const FILTER_TERM: Record<Filter, string> = {
  all: 'All',
  repaired: 'Repaired',
  needs_human: 'Needs a person',
  not_repaired: 'Not repaired',
  reverted: 'Reverted',
};

/** The definition a row's pill carries, reverted first because the pill says so first. */
function outcomeTitle(repair: Repair): string {
  if (repair.reverted_at) return REPAIR_STATE_DEFS.reverted;
  return REPAIR_OUTCOME_DEFS[repair.outcome] ?? `${repair.outcome} — an outcome this page has no definition for.`;
}

function matches(r: Repair, q: string): boolean {
  if (!q) return true;
  const n = q.toLowerCase();
  return [r.repair_id, r.workflow_name, r.workflow_id, r.failed_node, r.error_class, r.error_message, r.root_cause, r.change_summary, r.human_action, r.execution_id].some(
    (v) => v && v.toLowerCase().includes(n),
  );
}

/** The outcome, with colour only on the directions that are genuinely bad. */
export function OutcomePill({ repair }: { repair: Repair }) {
  return (
    <span title={outcomeTitle(repair)}>
      <OutcomeWord repair={repair} />
    </span>
  );
}

function OutcomeWord({ repair }: { repair: Repair }) {
  if (repair.reverted_at) return <Pill>reverted</Pill>;
  switch (repair.outcome) {
    // Not green: a repair is a machine having changed a live workflow, which is
    // worth reading rather than celebrating. Accent says "something happened
    // here", which is the truth.
    case 'repaired':
      return <Pill tone="accent">repaired</Pill>;
    case 'needs_human':
      return <Pill tone="degraded">needs a person</Pill>;
    case 'not_repaired':
      return <Pill tone="degraded">not repaired</Pill>;
    case 'error':
      return <Pill tone="failing">bridge error</Pill>;
    case 'skipped':
      return <Pill>skipped</Pill>;
    default:
      return <Pill>{String(repair.outcome).replace(/_/g, ' ')}</Pill>;
  }
}

function seconds(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  return s < 90 ? `${s.toFixed(s < 10 ? 1 : 0)} s` : `${Math.round(s / 60)} min`;
}

export default function Repairs() {
  const [tick, setTick] = useState(0);
  const [held, setHeld] = useState<RepairsData | null>(null);
  const { status, data: loaded, error } = useData(getRepairs, [tick], { kinds: HEALTH_KINDS });
  const data = held ?? loaded;

  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<{
    id: string;
    ok: boolean;
    message: string;
  } | null>(null);

  const repairs = data?.repairs ?? [];

  const rows = useMemo(
    () => repairs.filter((r) => (filter === 'all' ? true : filter === 'reverted' ? Boolean(r.reverted_at) : r.outcome === filter)).filter((r) => matches(r, q.trim())),
    [repairs, filter, q],
  );
  const paged = usePaged(rows, `${filter}|${q.trim()}`);

  const counts = {
    all: repairs.length,
    repaired: repairs.filter((r) => r.outcome === 'repaired').length,
    needs_human: repairs.filter((r) => r.outcome === 'needs_human').length,
    not_repaired: repairs.filter((r) => r.outcome === 'not_repaired' || r.outcome === 'error').length,
    reverted: repairs.filter((r) => r.reverted_at).length,
  };

  /**
   * The revert. The row is replaced with whatever the server hands back —
   * reverted or refused — rather than assumed, because `reverted_at` is a claim
   * about n8n's state and only the server has just checked it.
   */
  const revert = (r: Repair) => {
    if (busy) return;
    setBusy(r.repair_id);
    setConfirming(null);
    setSaid(null);
    void (async () => {
      try {
        const res = await revertRepair(r.repair_id);
        setSaid({ id: r.repair_id, ok: res.ok, message: res.message });
        if (res.repair && data) {
          const updated = res.repair;
          setHeld({
            ...data,
            repairs: data.repairs.map((x) => (x.repair_id === updated.repair_id ? updated : x)),
          });
        } else {
          setTick((n) => n + 1);
        }
      } catch (e) {
        setSaid({
          id: r.repair_id,
          ok: false,
          message: e instanceof Error ? e.message : 'The revert could not be sent.',
        });
      } finally {
        setBusy(null);
      }
    })();
  };

  if (status === 'loading' && !data) return <Loading />;
  if (status === 'error' && !data) return <LoadFailed error={error} />;
  if (!data) return <Loading />;

  const columns: RecordColumn<Repair>[] = [
    {
      key: 'when',
      header: 'when',
      width: '17ch',
      className: 'tabular text-faint',
      cell: (r) => when(r.created_at),
    },
    {
      key: 'workflow',
      header: 'workflow',
      card: 'title',
      width: '26ch',
      clip: true,
      title: (r) => r.workflow_name ?? r.workflow_id ?? undefined,
      cell: (r) => r.workflow_name ?? r.workflow_id ?? <span className="text-faint">not named</span>,
    },
    {
      key: 'node',
      header: 'failed node',
      width: '22ch',
      clip: true,
      className: 'text-dim',
      title: (r) => r.failed_node ?? undefined,
      cell: (r) => r.failed_node ?? <span className="text-faint">not named</span>,
    },
    {
      key: 'class',
      header: 'class',
      card: 'meta',
      className: 'card-meta text-dim',
      cell: (r) => (r.error_class ? r.error_class.toLowerCase().replace(/_/g, ' ') : <span className="text-faint">not classified</span>),
    },
    {
      key: 'outcome',
      header: 'outcome',
      card: 'meta',
      className: 'card-meta',
      cell: (r) => <OutcomePill repair={r} />,
    },
    {
      key: 'what',
      header: 'what it did',
      width: '44ch',
      clip: true,
      className: 'text-dim',
      /*
        A needs-human row shows its instruction here rather than its (absent)
        change summary: that sentence is the whole value of the outcome, and
        making somebody open the row to find it would waste it.
      */
      title: (r) => r.human_action ?? r.change_summary ?? r.root_cause ?? undefined,
      cell: (r) =>
        r.human_action ? <span className="text-degraded">{r.human_action}</span> : (r.change_summary ?? r.root_cause ?? <span className="text-faint">nothing recorded</span>),
    },
    {
      key: 'took',
      header: 'took',
      align: 'right',
      className: 'tabular text-faint',
      cell: (r) => seconds(r.duration_ms),
    },
    {
      key: 'id',
      header: 'repair',
      width: '16ch',
      clip: true,
      title: (r) => r.repair_id,
      cell: (r) => <RecordId>{r.repair_id}</RecordId>,
    },
    {
      key: 'actions',
      align: 'right',
      card: 'actions',
      className: 'card-actions',
      cell: (r) =>
        confirming === r.repair_id ? (
          <div className="flex items-center justify-end gap-2" onClick={(e) => e.stopPropagation()}>
            <span className="max-w-[34ch] truncate text-[11.5px] text-dim">Put {r.workflow_name ?? r.workflow_id} back?</span>
            <Button variant="ghost" size="sm" className="text-degraded" disabled={busy !== null} onClick={() => revert(r)}>
              Revert
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirming(null)}>
              Cancel
            </Button>
          </div>
        ) : (
          <div className="flex items-center justify-end gap-2">
            <Button
 variant="ghost" size="sm"
 disabled={!r.can_revert || busy !== null}
 // Where it is disabled, the tooltip is the server's own reason
 // rather than a shrug — which guard refused, in a sentence.
 title={
 r.revert_blocked_reason ??
 (busy !== null ? 'Another revert from this page is still waiting for n8n.' : 'Restores this workflow to the version it was on before this repair.')
 }
 onClick={(e) => {
 e.stopPropagation();
 setConfirming(r.repair_id);
 }}
 >
              {busy === r.repair_id ? 'Reverting…' : 'Revert'}
            </Button>
          </div>
        ),
    },
  ];

  const shown = repairs.find((r) => r.repair_id === open) ?? null;

  return (
    <div className="scroll-thin flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto">
      <Strip summary={data.summary} repairs={repairs} />

      {!data.n8n_configured && (
        <div className="card mx-6 mb-4 px-5 py-3 text-[12.5px] text-degraded md:mx-8">
          N8N_API_KEY is not set on this server, so no repair can be put back from here. The record below is complete; only the Revert button is unavailable.
        </div>
      )}

      {said && (
        <div className={`card mx-6 mb-4 px-5 py-3 text-[12.5px] md:mx-8 ${said.ok ? 'text-ink' : 'text-failing'}`} role="status">
          <span className="tabular text-faint">{said.id}</span> — {said.message}
        </div>
      )}

      <div className="shrink-0 space-y-3 px-6 pb-3 md:px-8">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Segmented<Filter>
            ariaLabel="Filter repairs"
            value={filter}
            onChange={setFilter}
            options={[
              {
                value: 'all',
                label: 'All',
                count: counts.all,
                title: FILTER_DEF.all,
              },
              {
                value: 'repaired',
                label: 'Repaired',
                count: counts.repaired,
                title: FILTER_DEF.repaired,
              },
              {
                value: 'needs_human',
                label: 'Needs a person',
                count: counts.needs_human,
                title: FILTER_DEF.needs_human,
              },
              {
                value: 'not_repaired',
                label: 'Not repaired',
                count: counts.not_repaired,
                title: FILTER_DEF.not_repaired,
              },
              {
                value: 'reverted',
                label: 'Reverted',
                count: counts.reverted,
                title: FILTER_DEF.reverted,
              },
            ]}
          />
          <div className="flex flex-1 items-center justify-end gap-3">
            <SearchBox value={q} onChange={setQ} placeholder="Search workflows, nodes, causes and changes" />
          </div>
        </div>
        <Definition term={FILTER_TERM[filter]}>{FILTER_DEF[filter]}</Definition>
      </div>

      {rows.length === 0 ? (
        <EmptyState>
          {repairs.length === 0
            ? 'Nothing has been repaired yet. The error handler posts a failure to the repair bridge, the bridge runs a repair against the workflow, and its result lands here — repaired, needing a person, or refused, whichever happened. An empty list means no failure has reached the bridge, not that nothing has broken.'
            : q.trim()
              ? 'No repair matches that search in this filter.'
              : filter === 'needs_human'
                ? 'No repair ended by asking for a person.'
                : filter === 'reverted'
                  ? 'No repair has been put back.'
                  : `No repair is ${filter.replace(/_/g, ' ')}.`}
        </EmptyState>
      ) : (
        <>
          <RecordTable columns={columns} rows={paged.rows} rowKey={(r) => r.repair_id} onOpen={(r) => setOpen(r.repair_id)} busyKey={busy ?? undefined} label="Repairs" />
          <Pagination paged={paged} unit="repairs" />
        </>
      )}

      {shown && (
        <RepairPanel
          repair={shown}
          busy={busy === shown.repair_id}
          onRevert={() => revert(shown)}
          onClose={() => {
            setOpen(null);
            setConfirming(null);
          }}
        />
      )}
    </div>
  );
}

/**
 * Five figures, and the two that carry colour are the two that mean somebody
 * has something to do.
 *
 * "Repaired and standing" is deliberately not "repaired": a repair that has
 * since been put back is not a fix the engine currently has, and a figure that
 * counted it would drift from the workflow's actual state the moment anybody
 * used the Revert button.
 */
function Strip({ summary: s, repairs }: { summary: RepairSummary; repairs: Repair[] }) {
  const needsHuman = s.by_outcome.find((o) => o.key === 'needs_human')?.n ?? 0;
  const failed = (s.by_outcome.find((o) => o.key === 'not_repaired')?.n ?? 0) + (s.by_outcome.find((o) => o.key === 'error')?.n ?? 0);
  /**
   * The two figures a revert moves are counted from the rows on screen rather
   * than taken from the summary the server computed before it.
   *
   * A revert updates one row in place, so a strip still reading the server's
   * count would say two repairs are standing while the table showed one — the
   * reconciliation bug the record pages and the Early Access tab already
   * learned once. Nothing else here changes on a revert: the outcome, the
   * duration and the date do not move, so the windows and the percentiles stay
   * as the server computed them.
   */
  const standing = repairs.filter((r) => r.outcome === 'repaired' && !r.reverted_at).length;
  const reverted = repairs.filter((r) => r.reverted_at).length;
  const notRepaired = s.by_outcome.find((o) => o.key === 'not_repaired')?.n ?? 0;
  const errored = s.by_outcome.find((o) => o.key === 'error')?.n ?? 0;
  const skipped = s.by_outcome.find((o) => o.key === 'skipped')?.n ?? 0;
  const repaired = repairs.filter((r) => r.outcome === 'repaired').length;
  return (
    <StatStrip cols={5}>
      <FigureCell
        label="Repairs this week"
        value={s.last_7_days}
        caption={`${s.last_30_days} in 30 days · ${s.total} held in all`}
        note={
          <>
            <span className="mb-1 block text-dim">
              {s.last_30_days} in 30 days · {s.total} held in all
            </span>
            Every attempt the bridge reported, whatever came of it. A failure that never reached the bridge is not counted here — it is an incident, on the other tabs.
          </>
        }
      />
      <FigureCell
        label="Repaired and standing"
        value={standing}
        caption={`of ${repaired} repaired · ${reverted} since put back`}
        note={
          <>
            <span className="mb-1 block text-dim">{reverted} since put back</span>
            Repairs the engine currently claims, so a reverted one is excluded rather than still counted. A repair counts only where the bridge said `repaired` and a new workflow
            version came back.
          </>
        }
      />
      <FigureCell
        label="Needs a person"
        value={needsHuman}
        tone={needsHuman ? 'degraded' : undefined}
        caption={`of ${s.total} attempts held`}
        note="Repairs that ended by naming what somebody should do — a run that could not fix the fault, or could not report its own result. Nothing else in the engine will move these."
      />
      <FigureCell
        label="Not repaired"
        value={failed}
        tone={failed ? 'degraded' : undefined}
        caption={`${notRepaired} not repaired · ${errored} bridge error · ${skipped} skipped apart`}
        note="Attempts that changed nothing and asked for nothing: a repair the agent judged too large, and a bridge that errored. Skipped attempts — rate limits, the never-heal list — are counted apart, on the All filter."
      />
      <FigureCell
        label="Median time to repair"
        value={s.median_repair_ms === null ? null : Math.round(s.median_repair_ms / 1000)}
        unit="s"
        caption={s.p95_repair_ms !== null ? `p95 ${Math.round(s.p95_repair_ms / 1000)} s over ${s.timed} repaired runs` : 'no repaired run recorded a duration'}
        note={
          <>
            {s.p95_repair_ms !== null && (
              <span className="mb-1 block text-dim">
                p95 {Math.round(s.p95_repair_ms / 1000)} s over {s.timed}
              </span>
            )}
            {s.duration_note}
          </>
        }
      />
    </StatStrip>
  );
}

/**
 * One repair, opened up: the error, the root cause, the exact change, and the
 * way back.
 *
 * The same shape as `IncidentPanel` next door, deliberately — a reader who has
 * opened one knows where to look in the other.
 */
function RepairPanel({ repair: r, busy, onRevert, onClose }: { repair: Repair; busy: boolean; onRevert: () => void; onClose: () => void }) {
  const [confirming, setConfirming] = useState(false);
  return createPortal(
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/30 p-4 md:p-10" onClick={onClose}>
      <div className="card fade-up w-full max-w-[880px] px-6 py-5" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Repair">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="kicker tabular truncate">{r.repair_id}</div>
            <h2 className="mt-1 text-[18px] leading-tight">{r.workflow_name ?? r.workflow_id ?? 'A workflow this row does not name'}</h2>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-faint">
              <OutcomePill repair={r} />
              {r.error_class && <Pill>{r.error_class.toLowerCase().replace(/_/g, ' ')}</Pill>}
              {r.failed_node && <span>{r.failed_node}</span>}
              <span className="tabular">{when(r.created_at)}</span>
              {r.duration_ms !== null && <span className="tabular">took {seconds(r.duration_ms)}</span>}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {r.execution_url && (
              <ButtonAnchor variant="ghost" size="sm" href={r.execution_url} target="_blank" rel="noreferrer">
                Open in n8n
              </ButtonAnchor>
            )}
            <Button variant="ghost" size="sm" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>

        {/*
          The instruction first where there is one. A needs-human repair has
          already said the most useful thing it will say, and it belongs above
          everything else on the panel for the same reason an incident's
          self-healing advice does.
        */}
        {r.human_action && (
          <div className="mt-4 rounded-[12px] bg-raised px-4 py-3">
            <div className="mb-1 text-[11px] text-faint">What a person needs to do</div>
            <p className="text-[13px] leading-relaxed whitespace-pre-wrap text-ink">{r.human_action}</p>
          </div>
        )}

        {r.root_cause && (
          <div className="mt-4">
            <div className="mb-1 text-[11px] text-faint">Root cause</div>
            <p className="text-[13px] leading-relaxed whitespace-pre-wrap text-ink">{r.root_cause}</p>
          </div>
        )}

        {r.change_summary && (
          <div className="mt-4">
            <div className="mb-1 text-[11px] text-faint">What was changed</div>
            <p className="text-[13px] leading-relaxed whitespace-pre-wrap text-ink">{r.change_summary}</p>
            {r.nodes_changed.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {r.nodes_changed.map((n) => (
                  <span key={n} className="tag">
                    {n}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="mt-4 grid gap-3 border-t border-line pt-4 sm:grid-cols-3">
          <Fact label="Outcome" value={String(r.outcome).replace(/_/g, ' ')} />
          <Fact label="Failed node" value={r.failed_node ?? 'not named'} />
          <Fact label="Execution" value={r.execution_id ?? 'not recorded'} />
          <Fact label="Version before" value={r.version_before ?? 'not recorded'} hint="the restore point" />
          <Fact label="Version after" value={r.version_after ?? 'not recorded'} hint={r.version_after ? 'what the repair produced' : 'no new version, so nothing was published'} />
          <Fact label="Nodes changed" value={r.nodes_changed.length ? String(r.nodes_changed.length) : 'none'} />
          {r.started_at && <Fact label="Started" value={when(r.started_at)} />}
          {r.finished_at && <Fact label="Finished" value={when(r.finished_at)} />}
          {r.reverted_at && <Fact label="Reverted" value={when(r.reverted_at)} hint={r.reverted_by ? `by ${r.reverted_by}` : undefined} />}
        </div>

        {r.error_message && (
          <details className="mt-4 border-t border-line pt-4">
            <summary className="cursor-pointer text-[12.5px] text-dim">The error itself</summary>
            <p className="mt-2 max-h-[30vh] overflow-y-auto text-[12px] leading-relaxed whitespace-pre-wrap text-dim">{r.error_message}</p>
          </details>
        )}

        {/*
          The way back. Confirmed in a step that names the workflow and says
          what reverting means — the failure this repair addressed comes back
          with it — because that is the part somebody would otherwise discover
          afterwards.
        */}
        <div className="mt-4 border-t border-line pt-4">
          {r.can_revert ? (
            confirming ? (
              <div className="rounded-[12px] bg-raised px-4 py-3">
                <p className="text-[12.5px] leading-relaxed text-ink">
                  Put <span className="font-medium">{r.workflow_name ?? r.workflow_id}</span> back to the version it was on before this repair? The change above is undone, and the
                  failure it addressed is no longer fixed.
                </p>
                <div className="mt-2 flex items-center gap-2">
                  <Button variant="ghost" size="sm" className="text-degraded" disabled={busy} onClick={onRevert}>
                    {busy ? 'Reverting…' : 'Yes, revert it'}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
                    Keep the repair
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-[12px] text-faint">Restores the workflow as it stood before this repair. Refused if anybody has edited it since.</p>
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirming(true)}>
                  Revert
                </Button>
              </div>
            )
          ) : (
            <p className="text-[12.5px] leading-relaxed text-faint">{r.revert_blocked_reason ?? 'This repair cannot be reverted from here.'}</p>
          )}
          {/* The four guards, from `revert` in repairs.ts — see definitions.ts. */}
          <details className="mt-3">
            <summary className="cursor-pointer text-[12px] text-faint">What can refuse a revert</summary>
            <div className="mt-2 space-y-1.5">
              <Definition term="Not a repair">{REVERT_GUARD_DEFS.not_a_repair}</Definition>
              <Definition term="Already reverted">{REVERT_GUARD_DEFS.already_reverted}</Definition>
              <Definition term="No restore point">{REVERT_GUARD_DEFS.no_restore_point}</Definition>
              <Definition term="Version moved on">{REVERT_GUARD_DEFS.version_moved_on}</Definition>
            </div>
          </details>
        </div>
      </div>
    </div>,
    document.body,
  );
}
