import { createPortal } from 'react-dom';
import { Fragment, useMemo, useState } from 'react';
import { useData } from '../app/useData';
import { getClients, resyncRecords, type ClientGroup, type ClientLaneRow, type ClientQuestion, type ClientRequest, type ClientsData } from '../data';
import { ButtonAnchor, TableFrame, Tabs, PageHeader, Button, CountCell, Definition, Th, Pill, LoadFailed, Loading, MetricCard, EmptyPanel, EmptyState, Toast, relativeTime, ResyncButton, RowAction, RowActions, RowsLine, SearchBox, Segmented, SourceLink, StatStrip, useResync, useToast } from '../components/ui';
import RecordStatistics from '../components/RecordStatistics';
import {
  ACTIVE_DEF,
  AT_THREE_DEF,
  LANE_STATUS_DEF,
  LAST_RUN_DEF,
  LAST_UPDATED_HERE_DEF,
  MISSING_RESEARCH_DEF,
  MOVEMENT_TAG_DEF,
  MOVEMENT_TAG_DEFS,
  NEEDS_HUMAN_DEF,
  NOT_COMMITTED_DEF,
  OPEN_CHECKS_DEF,
  OVERDUE_DEF,
  QUARANTINED_DEF,
  RUN_STATE_DEF,
  VIEW_DEFS,
  WARMING_UP_DEF,
  requestStatusDef,
} from './clientDefinitions';

/** The record kinds this page is built from: a change to one re-reads it (live since 2026-09-23). */
const CLIENT_KINDS = ['client_lanes', 'client_questions', 'client_requests'] as const;

/**
 * Watched clients: one row per lane, grouped under the client that owns it.
 *
 * The grouping is the page. Client 2 has two lanes — rare earths, and CRE vFarm
 * + Kiosk — and appears once with both beneath, because they are one client
 * with two lanes and not two clients. The key is the index row's own `Client
 * ID`; nothing here infers a client from a lane's name, and the clients are
 * ordered by the number inside that id, so the page reads 2, 9, 12.
 *
 * **The page renders what the index holds, never what tables exist in the
 * base.** Each lane's questions live in the table its index row names in `Table
 * ID`, and the server follows that field: adding a client is a row, not a
 * deploy. Question tables with no index row are orphans, are being deleted
 * upstream, and can never appear here — a resync removes anything held against
 * one.
 *
 * **Lane Status and Run State are two different questions** (2026-09-15,
 * Destiny) and had been mixed into one pill. Lane Status is onboarding maturity
 * — warming_up, warm_running — and moves with the calendar. Run State is the
 * outcome of the last research run — contradicted, stuck, idle — and is set by
 * Research Twin. A lane can be warm_running and contradicted at once, and the
 * old pill could only say one of those.
 */

function LaneStatusPill({ lane }: { lane: ClientLaneRow }) {
  if (!lane.lane_status) return <span className="text-faint" title={LANE_STATUS_DEF}>not set</span>;
  // warming_up is a stage, not a fault: a lane added and not yet run has no run
  // history to judge it by, and is never drawn as a failure.
  return (
    <span title={LANE_STATUS_DEF}>
      <Pill>{lane.lane_status.replace(/_/g, ' ')}</Pill>
    </span>
  );
}

function RunStatePill({ lane }: { lane: ClientLaneRow }) {
  if (!lane.run_state) return <span className="text-faint" title={RUN_STATE_DEF}>no run state</span>;
  const tone = lane.run_state === 'stuck' || lane.run_state === 'contradicted' ? 'degraded' : lane.run_state === 'resolved' ? 'ok' : 'default';
  return (
    <span title={RUN_STATE_DEF}>
      <Pill tone={tone}>{lane.run_state.replace(/_/g, ' ')}</Pill>
    </span>
  );
}

function day(iso: string | null): string {
  return iso ? iso.slice(0, 10) : '—';
}

/**
 * The three circuit breakers that already exist upstream, read rather than
 * recomputed. `Quarantined` is the real "needs a human": it flips true only
 * when `Stuck Cycle Count` reaches 3.
 */
function needsHumanNote(lane: ClientLaneRow): string | null {
  if (lane.quarantined) return `Quarantined after ${lane.stuck_cycles} stuck cycles. The lane is out of the weekly loop until a person clears it.`;
  if (lane.infra_fix_required) return 'Infra fix required: the run failed for an infrastructure reason, not a research one.';
  if (lane.consecutive_errors > 0) return `${lane.consecutive_errors} consecutive ${lane.consecutive_errors === 1 ? 'run has' : 'runs have'} ended in error or thin evidence.`;
  if (lane.stuck_cycles > 0) return `${lane.stuck_cycles} of 3 stuck cycles. Quarantine, and a person, at 3.`;
  return null;
}

/* ------------------------------------------------------------ lane view */

function LaneView({ lane, questions, onClose }: { lane: ClientLaneRow; questions: ClientQuestion[]; onClose: () => void }) {
  const needsHuman = (q: ClientQuestion) => q.research_stuck || q.run_count >= 3 || lane.quarantined;
  const note = needsHumanNote(lane);
  return createPortal(
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/30 p-4 md:p-10" onClick={onClose}>
      <div className="card fade-up w-full max-w-[960px] px-6 py-5" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Client lane">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="kicker tabular truncate">{lane.lane_id ?? lane.id}</div>
            <h2 className="mt-1 text-[18px] leading-tight">{lane.name}</h2>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-faint">
              <span className="flex items-center gap-1.5">
                lane <LaneStatusPill lane={lane} />
              </span>
              <span className="flex items-center gap-1.5">
                last run <RunStatePill lane={lane} />
              </span>
              {lane.quarantined && (
                <span title={QUARANTINED_DEF}>
                  <Pill tone="failing">quarantined</Pill>
                </span>
              )}
              {lane.infra_fix_required && <Pill tone="degraded">infra fix required</Pill>}
              <span title={LAST_RUN_DEF}>{lane.last_run_at ? `ran ${relativeTime(lane.last_run_at) ?? day(lane.last_run_at)}` : 'never run'}</span>
              {lane.next_run_due && (
                <span className={lane.overdue ? 'text-degraded' : ''} title={OVERDUE_DEF}>
                  next due {day(lane.next_run_due)}
                  {lane.overdue && lane.days_overdue !== null ? ` — ${lane.days_overdue} days ago` : ''}
                </span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {lane.latest_memo && (
              <ButtonAnchor variant="ghost" size="sm" href={lane.latest_memo} target="_blank" rel="noreferrer">
                Latest report
              </ButtonAnchor>
            )}
            <Button variant="ghost" size="sm" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>

        {note && <p className="mt-3 text-[12.5px] leading-snug text-dim">{note}</p>}
        {lane.warming_up && (
          <p className="mt-3 text-[12.5px] leading-snug text-dim">
            This lane has been added and not yet run. It is warming up, not failing: there is no run history to judge it by until the weekly loop reaches it.
          </p>
        )}
        {lane.first_stuck_at && !lane.quarantined && (
          <p className="mt-2 text-[12.5px] leading-snug text-faint">First went stuck {day(lane.first_stuck_at)}. That stamp is deliberately not re-set each week it stays stuck, so it is the age of the problem.</p>
        )}

        {lane.commercial_hook && (
          <div className="mt-4 border-t border-line pt-4">
            <div className="mb-0.5 text-[11px] text-faint">Commercial hook</div>
            <p className="text-[12.5px] leading-relaxed text-ink">{lane.commercial_hook}</p>
          </div>
        )}

        <div className="mt-4 border-t border-line pt-4">
          <div className="mb-2 flex items-baseline justify-between gap-3">
            <div className="text-[13px] font-medium text-ink">Standing questions</div>
            <div className="text-[11px] text-faint">{questions.length} in this lane</div>
          </div>
          {questions.length === 0 ? (
            <p className="text-[12.5px] leading-relaxed text-faint">
              {lane.questions_table ? 'This lane’s questions table was read and holds no rows yet.' : 'The index row names no Table ID, so this lane’s questions could not be read.'}
            </p>
          ) : (
            <div className="space-y-3">
              {questions.map((q) => (
                <div key={q.id} className="border-b border-line pb-3 last:border-b-0 last:pb-0">
                  <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
                    <div className="min-w-0 flex-1 text-[12.5px] font-medium text-ink">{q.question}</div>
                    <div className="flex shrink-0 flex-wrap items-center gap-2 text-[11.5px] text-faint">
                      {needsHuman(q) && (
                        <span title={NEEDS_HUMAN_DEF}>
                          <Pill tone="degraded">needs a human</Pill>
                        </span>
                      )}
                      {q.missing_research && (
                        <span title={MISSING_RESEARCH_DEF}>
                          <Pill>missing research</Pill>
                        </span>
                      )}
                      {q.movement_tag && <span title={MOVEMENT_TAG_DEFS[q.movement_tag] ?? MOVEMENT_TAG_DEF}>{q.movement_tag}</span>}
                      {q.confidence && <span>confidence {q.confidence.toLowerCase()}</span>}
                      {/* Run Count caps at 3: a question at 3 is skipped by the weekly clock and needs a person. */}
                      <span className={q.run_count >= 3 ? 'text-degraded' : ''} title={q.run_count >= 3 ? AT_THREE_DEF : 'Weekly research attempts on this question. The Weekly Clock adds one before each attempt and stops at 3.'}>
                        {q.run_count} of 3 runs
                      </span>
                    </div>
                  </div>
                  {/* Plain Summary is deliberately jargon-free, so it goes first. */}
                  {(q.plain_summary || q.answer) && <p className="mt-1 text-[12px] leading-relaxed text-dim">{q.plain_summary ?? q.answer}</p>}
                  {q.research_stuck && q.next_experiments && (
                    <p className="mt-1 text-[11.5px] leading-snug text-faint">
                      <span className="text-degraded">Stuck.</span> Next: {q.next_experiments}
                    </p>
                  )}
                  <div className="mt-1 flex items-center gap-3 text-[11px] text-faint">
                    <SourceLink source={q.source} />
                    <span>updated {q.last_updated ? (relativeTime(q.last_updated) ?? day(q.last_updated)) : 'never'}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/* --------------------------------------------------------- the lane table */

const HEADERS: { label: string; right?: boolean; title?: string }[] = [
  { label: 'lane' },
  { label: 'lane status', title: LANE_STATUS_DEF },
  { label: 'run state', title: RUN_STATE_DEF },
  { label: 'last run', title: LAST_RUN_DEF },
  { label: 'next run due', title: OVERDUE_DEF },
  { label: 'active', right: true, title: ACTIVE_DEF },
  { label: 'needs human', right: true, title: NEEDS_HUMAN_DEF },
  { label: 'at 3 runs', right: true, title: AT_THREE_DEF },
  { label: 'missing research', right: true, title: MISSING_RESEARCH_DEF },
  { label: 'report' },
  { label: 'last updated here', title: LAST_UPDATED_HERE_DEF },
  { label: '' },
];

const VIA: Record<string, string> = { engine: 'written by the engine', resync: 'copied in by a resync', page: 'edited on this page' };

/**
 * When this lane (or any of its questions) last changed in this database, and
 * how it got here (2026-09-22). Nothing has written these rows since the
 * resync of 17 Sep, and a lane sitting on that copy must not read as current.
 */
function LastUpdate({ h }: { h: ClientLaneRow['last_update'] }) {
  if (!h) return <span className="text-faint">not recorded</span>;
  const days = Math.floor((Date.now() - Date.parse(h.updated_at)) / 86_400_000);
  return (
    <span className={days >= 3 ? 'text-degraded' : 'text-dim'} title={`${VIA[h.via] ?? h.via}, ${h.updated_at.slice(0, 16).replace('T', ' ')} UTC`}>
      {day(h.updated_at)} · {h.via === 'resync' ? 'resync' : h.via === 'engine' ? 'engine' : 'page'}
    </span>
  );
}

/** One sentence over the whole kind: when n8n itself last wrote any of it. */
function EngineWritesLine({ d, kinds }: { d: ClientsData; kinds: ('lanes' | 'questions' | 'requests')[] }) {
  const parts = kinds.map((k) => {
    const at = d.engine_last_write[k];
    return `${k}: ${at ? `${day(at)} (${relativeTime(at) ?? ''})` : 'never'}`;
  });
  const rows = kinds.flatMap((k) => (k === 'lanes' ? d.lanes.map((l) => l.held) : k === 'questions' ? d.questions.map((q) => q.held) : d.requests.map((r) => r.held)));
  const viaResync = rows.filter((h) => h?.via === 'resync').length;
  return (
    <p className="text-[12px] text-dim">
      Last written by the engine — {parts.join(' · ')}.{' '}
      {rows.length > 0 && viaResync === rows.length
        ? `Every one of the ${rows.length} rows here were copied in before the engine began writing here, so this is a copy as of that import, not a live feed.`
        : `${viaResync} of ${rows.length} rows here were copied in before the engine began writing here; the rest were written by the engine.`}
    </p>
  );
}

/**
 * One table for every lane, with a row per client heading its own lanes.
 *
 * A table per client gave each block its own column widths, so nothing lined up
 * down the page and the header row was drawn four times for four lanes. One
 * table keeps one set of columns and one set of headers, and the client rows do
 * the nesting.
 */
function LaneTable({ clients, lanes, onOpen }: { clients: ClientGroup[]; lanes: (c: ClientGroup) => ClientLaneRow[]; onOpen: (id: string) => void }) {
  return (
    <div className="scroll-thin card mx-6 mb-4 shrink-0 overflow-x-auto md:mx-8">
      <table className="table-cards w-full border-collapse text-[12.5px]" aria-label="Watched client lanes">
        <thead>
          <tr>
            {HEADERS.map((h, i) => (
              <th key={i} title={h.title} className={`sticky top-0 z-10 border-b border-line bg-panel px-3 py-2 text-left text-[11.5px] font-medium whitespace-nowrap text-faint ${h.right ? 'text-right' : ''} ${h.title ? 'cursor-help' : ''}`}>
                {h.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {clients.map((c) => {
            const mine = lanes(c);
            if (mine.length === 0) return null;
            const needs = mine.reduce((n, l) => n + l.needs_human, 0);
            return (
              <Fragment key={c.client_id}>
                {/* The client heading, spanning the table. Once per client, however many lanes it owns. */}
                <tr className="row-group">
                  <td className="td card-full" colSpan={HEADERS.length}>
                    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                      <div className="flex items-baseline gap-3">
                        <span className="text-[13.5px] font-medium text-ink">{c.label}</span>
                        <span className="tabular text-[11px] text-faint">{c.client_id}</span>
                      </div>
                      <div className="text-[11px] text-faint">
                        {mine.length} {mine.length === 1 ? 'lane' : 'lanes'} · {c.questions} {c.questions === 1 ? 'question' : 'questions'}
                        {needs > 0 && <span className="text-degraded"> · {needs} waiting on a person</span>}
                      </div>
                    </div>
                  </td>
                </tr>
                {mine.map((l) => (
                  <tr key={l.id} className="cursor-pointer" onClick={() => onOpen(l.id)}>
                    <td className="td card-title td-clip" style={{ maxWidth: '34ch' }} title={l.name}>
                      {l.name}
                      {l.quarantined && (
                        <span className="ml-2 text-[10.5px] text-failing" title={QUARANTINED_DEF}>
                          quarantined
                        </span>
                      )}
                    </td>
                    <td className="td card-meta">
                      <LaneStatusPill lane={l} />
                    </td>
                    <td className="td card-meta">
                      <RunStatePill lane={l} />
                    </td>
                    <td className="td card-meta tabular whitespace-nowrap text-faint" title={l.last_run_at ?? 'never run'}>
                      {l.last_run_at ? (relativeTime(l.last_run_at) ?? day(l.last_run_at)) : 'never'}
                      <span className="text-faint md:hidden"> since the last run</span>
                    </td>
                    {/*
                      Overdue is Next Run Due against today, which is the field
                      the weekly clock reads. Those stamps were frozen for weeks
                      because nothing wrote them back; that was fixed in n8n on
                      15 Sep, so they become real from the next weekly run. Until
                      then this column shows the history, not a page fault.
                    */}
                    <td
                      className={`td card-meta tabular whitespace-nowrap ${l.overdue ? 'text-degraded' : 'text-faint'}`}
                      title={l.overdue && l.days_overdue !== null ? `${l.days_overdue} days past due` : (l.next_run_due ?? 'no due date recorded')}
                    >
                      {l.next_run_due ? `due ${day(l.next_run_due)}` : 'no due date'}
                      {l.overdue && (
                        <span className="ml-1.5 text-[10.5px]" title={OVERDUE_DEF}>
                          overdue
                        </span>
                      )}
                    </td>
                    <td className="td card-meta tabular text-right text-ink">
                      {l.active_questions}
                      <span className="text-faint md:hidden"> active</span>
                    </td>
                    <td className={`td card-meta tabular text-right ${l.needs_human ? 'text-degraded' : 'text-faint'}`}>
                      {l.needs_human}
                      <span className="text-faint md:hidden"> need a human</span>
                    </td>
                    <td className={`td card-meta tabular text-right ${l.capped ? 'text-degraded' : 'text-faint'}`} title={AT_THREE_DEF}>
                      {l.capped}
                      <span className="text-faint md:hidden"> at 3 runs</span>
                    </td>
                    <td className={`td card-meta tabular text-right ${l.missing_research ? 'text-dim' : 'text-faint'}`}>
                      {l.missing_research}
                      <span className="text-faint md:hidden"> missing research</span>
                    </td>
                    <td className="td card-meta">
                      {l.latest_memo ? (
                        <a href={l.latest_memo} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="text-accent-ink hover:underline">
                          latest report
                        </a>
                      ) : (
                        <span className="text-faint">no report</span>
                      )}
                    </td>
                    <td className="td card-meta tabular whitespace-nowrap">
                      <LastUpdate h={l.last_update} />
                    </td>
                    <td className="td card-actions td-actions">
                      <RowActions>
                        <RowAction label="View" tone="accent" onClick={() => onOpen(l.id)} />
                      </RowActions>
                    </td>
                  </tr>
                ))}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------ page */

type Filter = 'all' | 'needs-human' | 'overdue';
type RequestFilter = 'all' | 'open' | 'checks';

/** One line per filter word, from the server's own tests — see clientDefinitions.ts. */
const LANE_FILTER_DEF: Record<Filter, string> = {
  all: 'Every lane on the watched-clients index.',
  'needs-human': `Lanes with at least one question that needs a human, or that are Quarantined. ${NEEDS_HUMAN_DEF}`,
  overdue: OVERDUE_DEF,
};

const REQUEST_FILTER_DEF: Record<RequestFilter, string> = {
  all: 'Every row in the Client Requests table.',
  open: NOT_COMMITTED_DEF,
  checks: 'Requests with at least one Open Check still named: Feasibility, Licensing, Food Safety, Pricing or Ownership.',
};

/**
 * Still interest rather than commitment — the same rule the server applies, in
 * the same words, because the page's own filter and the server's `open_requests`
 * count have to agree. A status neither side knows reads as open: the unsafe
 * direction here is calling something a commitment.
 */
function isOpenRequest(status: string | null): boolean {
  return status !== 'Confirmed' && status !== 'Delivered' && status !== 'Declined';
}

/**
 * What each client has asked for (2026-09-17).
 *
 * A new table in the client research base, and the one thing it exists to make
 * impossible is reading interest as commitment: **a request stays Requested or
 * Under Review until every Open Check is cleared.** So the open checks are a
 * column of their own rather than a detail behind a click, and a row with none
 * outstanding says so in those words rather than showing an empty cell that
 * could be read as "nothing needed" or as "nobody has filled this in".
 *
 * Grouped under the client that asked, the same way the lanes are, because that
 * is what the page's shape already says: one heading per client.
 */
function statusTone(status: string | null): 'accent' | 'degraded' | 'default' {
  if (status === 'Confirmed' || status === 'Delivered') return 'accent';
  // Declined is settled, so it is quiet rather than amber. Requested and Under
  // Review are the two that are not yet a commitment, and those are the ones
  // worth a colour.
  if (status === 'Declined') return 'default';
  return 'degraded';
}

function RequestTable({ clients, requests }: { clients: ClientGroup[]; requests: (c: ClientGroup) => ClientRequest[] }) {
  const shown = clients.filter((c) => requests(c).length > 0);
  return (
    <TableFrame grow={false} tableClass="rows-2" label="Client requests">
      <thead>
        <tr>
          <Th className="w-[34%]">request</Th>
          <Th>category</Th>
          <Th>lane</Th>
          <Th>
            <span title="The request’s own Status. Requested and Under Review are still interest; Confirmed and Delivered are commitments; Declined is settled." className="cursor-help">
              status
            </span>
          </Th>
          <Th className="w-[24%]">
            <span title={OPEN_CHECKS_DEF} className="cursor-help">
              open checks
            </span>
          </Th>
          <Th>requested</Th>
          <Th>source</Th>
        </tr>
      </thead>
      <tbody>
        {shown.length === 0 && (
          <tr className="row-empty">
            <td colSpan={7} className="td td-empty px-6 text-center align-middle text-[13px] text-dim">
              No client has asked for anything that matches.
            </td>
          </tr>
        )}
        {shown.map((c) => (
          <Fragment key={c.client_id}>
            <tr className="row-group">
              <td colSpan={7} className="td">
                <span className="text-[13px] font-medium text-ink">{c.label}</span>
                <span className="ml-2 text-[11.5px] text-faint">
                  {requests(c).length} {requests(c).length === 1 ? 'request' : 'requests'}
                  {c.open_requests > 0 && (
                    <span className="text-degraded" title={NOT_COMMITTED_DEF}>
                      {' '}
                      · {c.open_requests} not yet a commitment
                    </span>
                  )}
                </span>
              </td>
            </tr>
            {requests(c).map((r) => (
              <tr key={r.id}>
                <td className="td card-title" style={{ maxWidth: '44ch' }}>
                  <TwoLineRequest r={r} />
                </td>
                <td className="td card-meta text-dim">{r.category ?? <span className="text-faint">—</span>}</td>
                <td className="td td-clip text-faint" style={{ maxWidth: '22ch' }} title={r.lane_id ?? undefined}>
                  {r.lane_id ?? '—'}
                </td>
                <td className="td card-meta">
                  <span title={requestStatusDef(r.status)}>
                    <Pill tone={statusTone(r.status)}>{(r.status ?? 'no status').toLowerCase()}</Pill>
                  </span>
                </td>
                <td className="td card-meta" style={{ maxWidth: '30ch' }}>
                  {r.open_checks.length === 0 ? (
                    <span className="text-[11.5px] text-ok" title={OPEN_CHECKS_DEF}>
                      nothing outstanding
                    </span>
                  ) : (
                    <span className="flex flex-wrap gap-1">
                      {r.open_checks.map((k) => (
                        <span key={k} className="tag">
                          {k}
                        </span>
                      ))}
                    </span>
                  )}
                </td>
                <td className="td tabular whitespace-nowrap text-faint">{r.date_requested?.slice(0, 10) ?? <span className="text-faint">no date</span>}</td>
                <td className="td">
                  <SourceLink source={r.source} />
                </td>
              </tr>
            ))}
          </Fragment>
        ))}
      </tbody>
    </TableFrame>
  );
}

/** The request, with the client's own words under it where there are any. */
function TwoLineRequest({ r }: { r: ClientRequest }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-[13px] text-ink" title={r.request}>
        {r.request}
      </div>
      <div className="truncate text-[11.5px] text-faint" title={r.details ?? r.notes ?? ''}>
        {r.details ?? r.notes ?? 'Nothing further was written down.'}
      </div>
    </div>
  );
}

/**
 * Two views of the same records (2026-09-16, Destiny), tabbed at the top the
 * way the System Registry tabs its four registries.
 *
 * **Clients** is the working surface: the list and its filters. **Statistics**
 * answers the other question — is this getting better or worse — which needs
 * month-against-month figures rather than rows. Everything month-shaped lives
 * there: the chart, the month in view and the export.
 */
const VIEWS = ['Clients', 'Requests', 'Statistics'] as const;
type View = (typeof VIEWS)[number];

export default function Clients() {
  const { status, data: loaded, error } = useData(getClients, [], { kinds: CLIENT_KINDS });
  const [live, setLive] = useState<ClientsData | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [requestFilter, setRequestFilter] = useState<RequestFilter>('all');
  // The month the statistics tab is looking at. The list is not filtered by
  // it: the month card came off this tab, and a list silently narrowed with
  // nothing on screen saying so is worse than no filter at all.
  const [month, setMonth] = useState<string | null>(null);
  const [view, setView] = useState<View>('Clients');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const { toast, setToast } = useToast();

  const d: ClientsData | null = live ?? loaded;

  const resync = useResync({
    run: () => resyncRecords('clients'),
    reload: async () => setLive(await getClients()),
    setToast,
  });

  const lanes = d?.lanes ?? [];
  const rows = useMemo(
    () =>
      lanes
        .filter((l) => (filter === 'all' ? true : filter === 'needs-human' ? l.needs_human > 0 || l.quarantined : l.overdue))
        .filter((l) => !q.trim() || [l.name, l.lane_id, l.client_id, l.commercial_hook].some((v) => v && v.toLowerCase().includes(q.trim().toLowerCase()))),
    [lanes, filter, q],
  );
  const shown = useMemo(() => new Set(rows.map((l) => l.id)), [rows]);

  const requests = d?.requests ?? [];
  const requestRows = useMemo(
    () =>
      requests
        .filter((r) => (requestFilter === 'all' ? true : requestFilter === 'open' ? isOpenRequest(r.status) : r.open_checks.length > 0))
        .filter(
          (r) =>
            !q.trim() ||
            [r.request, r.details, r.notes, r.lane_id, r.client_id, r.category, r.status, ...r.open_checks].some((v) => v && v.toLowerCase().includes(q.trim().toLowerCase())),
        ),
    [requests, requestFilter, q],
  );
  const requestShown = useMemo(() => new Set(requestRows.map((r) => r.id)), [requestRows]);
  /*
   * The export moved to the statistics tab and carries every question in the
   * month in view, not the lanes this tab happens to be filtered to: the
   * figures beside the button are computed over all of them, and a file that
   * disagreed with the numbers printed next to it would be worse than no file.
   */

  if (status === 'loading' || !d) return status === 'error' ? <LoadFailed error={error} /> : <Loading />;
  const current = open ? lanes.find((l) => l.id === open) : null;
  const totals = {
    lanes: lanes.length,
    clients: d.clients.length,
    needsHuman: lanes.reduce((n, l) => n + l.needs_human, 0),
    questions: lanes.reduce((n, l) => n + l.questions, 0),
    overdue: lanes.filter((l) => l.overdue).length,
    warming: lanes.filter((l) => l.warming_up).length,
    requests: requests.length,
    openRequests: requests.filter((r) => isOpenRequest(r.status)).length,
    openChecks: requests.reduce((n, r) => n + r.open_checks.length, 0),
    asking: d.clients.filter((c) => c.requests.length > 0).length,
  };
  /*
   * The breakdowns the captions print, from the same rows the figures count.
   * Questions are taken lane by lane, on the key the server groups them by, so
   * the breakdown is over exactly the questions the headline counts.
   */
  const laneQuestions = lanes.flatMap((l) => d.questions.filter((qq) => qq.lane_id === (l.lane_id ?? l.id)));
  const stuckQs = laneQuestions.filter((qq) => qq.research_stuck).length;
  const atThreeQs = laneQuestions.filter((qq) => qq.run_count >= 3).length;
  const quarantinedLanes = lanes.filter((l) => l.quarantined).length;
  const datedLanes = lanes.filter((l) => l.next_run_due).length;
  const worstOverdue = lanes.reduce((m, l) => Math.max(m, l.days_overdue ?? 0), 0);
  const withChecks = requests.filter((r) => r.open_checks.length > 0).length;
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <PageHeader
        title="Clients"
        subtitle="Every watched lane, grouped under the client it belongs to"
        right={<ResyncButton busy={resync.busy} onClick={resync.start} />}
        below={<Tabs tabs={VIEWS} value={view} onChange={setView} titles={VIEW_DEFS} />}
      />

      {/*
        Everything month-shaped lives on the statistics tab: the chart, the
        month in view and the export. This tab is the list and its filters.
      */}
      {view === 'Requests' ? (
        <div className="scroll-thin flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto">
          <div className="shrink-0 px-6 pb-3 md:px-8">
            {/* The requests table's own age, not the index's. */}
            <RowsLine freshness={d.requests_freshness} writes={false} />
            <EngineWritesLine d={d} kinds={['requests']} />
          </div>

          <StatStrip cols={4}>
            <CountCell label="Requests" value={totals.requests} caption="rows in the Client Requests table" hint="Every row in the Client Requests table, whatever its status. Nothing in this dashboard writes to that table." />
            <CountCell
              label="Not yet a commitment"
              value={totals.openRequests}
              tone={totals.openRequests ? 'degraded' : 'dim'}
              caption={`${totals.openRequests} of ${plural(totals.requests, 'request')}`}
              hint={
                <>
                  still Requested or Under Review, so nothing is promised. {NOT_COMMITTED_DEF}
                </>
              }
            />
            <CountCell
              label="Open checks"
              value={totals.openChecks}
              tone={totals.openChecks ? 'degraded' : 'dim'}
              caption={`on ${withChecks} of ${plural(totals.requests, 'request')}`}
              hint={
                <>
                  confirmations owed across every request. {OPEN_CHECKS_DEF}
                </>
              }
            />
            <CountCell
              label="Clients asking"
              value={totals.asking}
              caption={`of ${plural(d.clients.length, 'client')} on this page`}
              hint="clients with at least one request, counted by the Client ID the request carries."
            />
          </StatStrip>

          <div className="shrink-0 space-y-3 px-6 pb-3 md:px-8">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Segmented<RequestFilter>
                ariaLabel="Filter requests"
                value={requestFilter}
                onChange={setRequestFilter}
                options={[
                  { value: 'all', label: 'All requests', count: totals.requests, title: REQUEST_FILTER_DEF.all },
                  { value: 'open', label: 'Not yet a commitment', count: totals.openRequests, title: REQUEST_FILTER_DEF.open },
                  { value: 'checks', label: 'Has open checks', count: withChecks, title: REQUEST_FILTER_DEF.checks },
                ]}
              />
              <div className="flex flex-1 items-center justify-end gap-3">
                <SearchBox value={q} onChange={setQ} placeholder="Search requests, details and checks" />
              </div>
            </div>
            <Definition term={requestFilter === 'all' ? 'All requests' : requestFilter === 'open' ? 'Not yet a commitment' : 'Has open checks'}>{REQUEST_FILTER_DEF[requestFilter]}</Definition>
            {/*
              Said once, at the top of the table rather than on every row: this
              is what the Client Requests table is for, in its own words.
            */}
            <p className="max-w-[92ch] text-[11.5px] leading-relaxed text-faint">
              A request stays <span className="text-ink">Requested</span> or <span className="text-ink">Under Review</span> until every open check is cleared. Nothing here is a
              commitment until its Status says <span className="text-ink">Confirmed</span>, and this dashboard never writes to that table.
            </p>
          </div>

          {(d.requests ?? []).length === 0 ? (
            <EmptyState>
              No client request is held. The Client Requests table was added to the client research base on 17 Sept 2026; if it holds rows and this does not, press resync.
            </EmptyState>
          ) : (
            <RequestTable clients={d.clients} requests={(c) => c.requests.filter((r) => requestShown.has(r.id))} />
          )}
        </div>
      ) : view === 'Statistics' ? (
        <div className="scroll-thin min-h-0 flex-1 overflow-x-hidden overflow-y-auto pt-4">
          <RecordStatistics<ClientQuestion>
            kind="clients"
            noun="Questions"
            monthlyKind="clients"
            month={month}
            onMonth={setMonth}
            rows={d?.questions ?? []}
            dateOf={(q) => q.last_updated}
            columns={[
              { header: 'record_id', value: (q) => q.id },
              { header: 'table_id', value: (q) => q.table },
              { header: 'lane_id', value: (q) => q.lane_id },
              { header: 'question', value: (q) => q.question },
              { header: 'plain_summary', value: (q) => q.plain_summary },
              { header: 'confidence', value: (q) => q.confidence },
              { header: 'movement_tag', value: (q) => q.movement_tag },
              { header: 'run_count', value: (q) => q.run_count },
              { header: 'missing_research', value: (q) => q.missing_research },
              { header: 'research_stuck', value: (q) => q.research_stuck },
              { header: 'last_updated', value: (q) => q.last_updated },
            ]}
          />
        </div>
      ) : (
      <div className="scroll-thin flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto">
        <div className="shrink-0 space-y-1 px-6 pb-3 md:px-8">
          <RowsLine freshness={d.freshness} writes={false} />
          <EngineWritesLine d={d} kinds={['lanes', 'questions']} />
        </div>

        <StatStrip cols={5}>
          <CountCell
            label="Clients"
            value={totals.clients}
            caption={`${plural(totals.lanes, 'lane')} between them`}
            hint="Distinct Client ID values on the watched-clients index, plus any Client ID a request carries that no index row has. Two lanes with one Client ID are one client."
          />
          <CountCell
            label="Needs a human"
            value={totals.needsHuman}
            tone={totals.needsHuman ? 'degraded' : 'dim'}
            caption={`${stuckQs} stuck · ${atThreeQs} at 3 runs · ${quarantinedLanes} quarantined`}
            hint={
              <>
                questions stuck, at three runs, or in a quarantined lane. {NEEDS_HUMAN_DEF} A question can be both stuck and at three runs, so the caption’s parts can overlap; the figure counts it once.
              </>
            }
          />
          <CountCell
            label="Questions"
            value={totals.questions}
            caption={`across ${plural(totals.lanes, 'lane')} · ${laneQuestions.length - totals.needsHuman} still active`}
            hint={
              <>
                standing questions across every lane. Active: {ACTIVE_DEF}
              </>
            }
          />
          <CountCell
            label="Overdue"
            value={totals.overdue}
            tone={totals.overdue ? 'degraded' : 'dim'}
            caption={
              datedLanes === 0
                ? 'no lane carries a Next Run Due'
                : totals.overdue
                  ? `${totals.overdue} of ${datedLanes} dated lanes, up to ${worstOverdue} days late`
                  : `0 of ${plural(datedLanes, 'dated lane')}`
            }
            hint={
              <>
                Next Run Due is in the past. {OVERDUE_DEF}
              </>
            }
          />
          <CountCell
            label="Warming up"
            value={totals.warming}
            caption="added, never run — not failing"
            hint={WARMING_UP_DEF}
          />
        </StatStrip>

        {/*
          The monthly panel counts questions rather than lanes: `Last Updated`
          on each question has always been written correctly, while the index's
          own `Last Run At` was frozen at 24 Aug because nothing wrote it back.
          The CSV therefore exports the questions in view, not the lanes.
        */}


        {d.unreadable.length > 0 && (
          <div className="mx-6 mb-4 md:mx-8">
            <MetricCard title="Lanes that could not be read">
              <div className="space-y-1.5 text-[12.5px]">
                {d.unreadable.map((u) => (
                  <div key={u.name} className="text-dim">
                    <span className="text-ink">{u.name}</span> — {u.reason}
                  </div>
                ))}
              </div>
            </MetricCard>
          </div>
        )}

        <div className="shrink-0 px-6 pb-3 md:px-8">
          <div className="flex flex-wrap items-center justify-between gap-2">
            {/*
              No client tab: the clients are the page's own structure now, one
              block each, so a tab per client would be a second way to say the
              same thing. These two filters read the circuit breakers instead.
            */}
            <Segmented<Filter>
              ariaLabel="Filter lanes"
              value={filter}
              onChange={setFilter}
              options={[
                { value: 'all', label: 'All lanes', count: totals.lanes, title: LANE_FILTER_DEF.all },
                { value: 'needs-human', label: 'Needs a human', count: lanes.filter((l) => l.needs_human > 0 || l.quarantined).length, title: LANE_FILTER_DEF['needs-human'] },
                { value: 'overdue', label: 'Overdue', count: totals.overdue, title: LANE_FILTER_DEF.overdue },
              ]}
            />
            <div className="flex flex-1 items-center justify-end gap-3">
              <SearchBox value={q} onChange={setQ} placeholder="Search clients and lanes" />
            </div>
          </div>
          <div className="mt-2">
            <Definition term={filter === 'all' ? 'All lanes' : filter === 'needs-human' ? 'Needs a human' : 'Overdue'}>{LANE_FILTER_DEF[filter]}</Definition>
          </div>
        </div>

        {rows.length === 0 ? (
          <EmptyState>
            {d.freshness.source === 'none'
              ? (d.freshness.note ?? 'No watched-client lanes are held.')
              : q.trim()
                ? 'No lane matches that search under the selected filter.'
                : filter === 'needs-human'
                  ? 'No lane has a question waiting on a person, and none is quarantined.'
                  : filter === 'overdue'
                    ? 'Every lane’s next run is still ahead of it.'
                    : 'The watched-clients index holds no lanes.'}
          </EmptyState>
        ) : (
          // Ordered by the number in each Client ID, with its lanes beneath it.
          // A client with two lanes appears once, heading both.
          <LaneTable clients={d.clients} lanes={(c) => c.lanes.filter((l) => shown.has(l.id))} onOpen={setOpen} />
        )}

        {/* Warming up is not failing, and the page says which is which. */}
        {totals.warming > 0 && (
          <div className="shrink-0 px-6 pb-6 md:px-8">
            <EmptyPanel min={0}>
              {totals.warming === 1 ? 'One lane has' : `${totals.warming} lanes have`} been added and not yet run. They are warming up, not failing: there is no run history to judge them by until the weekly loop reaches them.
            </EmptyPanel>
          </div>
        )}
      </div>
      )}

      {current && <LaneView lane={current} questions={d.questions.filter((qq) => qq.lane_id === (current.lane_id ?? current.id))} onClose={() => setOpen(null)} />}
      <Toast toast={toast} />
    </div>
  );
}
