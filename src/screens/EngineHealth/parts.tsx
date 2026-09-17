import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';
import type { Incident, LaneRead, RetryAttempt } from '../../data';
import { Pill } from '../../components/ui';

/**
 * The pieces Engine Health's five tabs share.
 *
 * The one that matters most is `LaneReads`. **No incidents and no reporting
 * look identical from the outside** — a lane with nothing wrong and a lane
 * nobody asked both draw an empty page — and only one of them is good news. So
 * every tab prints, above everything else, which lanes answered and which did
 * not, and nothing below it is allowed to imply an answer a lane never gave.
 */

/** Severity, as the ledger recorded it. Only critical and high are coloured. */
export function SeverityPill({ severity }: { severity: string }) {
  if (severity === 'critical') return <Pill tone="failing">critical</Pill>;
  if (severity === 'high') return <Pill tone="degraded">high</Pill>;
  if (severity === 'warning') return <Pill>warning</Pill>;
  return <Pill>{severity}</Pill>;
}

/**
 * The error class, with retryability as the thing the colour carries.
 *
 * A retryable class is not good news, but it is news of a different kind: the
 * engine will have a go at it on its own. A non-retryable one will sit there
 * until a person does something, which is the direction worth marking.
 */
export function ClassPill({ cls, retryable, known }: { cls: string; retryable: boolean; known: boolean }) {
  return (
    <Pill tone={retryable ? 'accent' : 'degraded'}>
      {cls.toLowerCase().replace(/_/g, ' ')}
      {!known && <span className="ml-1 opacity-70">· new to this page</span>}
    </Pill>
  );
}

export function RetryStatusPill({ status }: { status: string }) {
  if (status === 'Recovered') return <Pill tone="ok">recovered</Pill>;
  if (status === 'Exhausted') return <Pill tone="failing">exhausted</Pill>;
  // Genuinely undecided, and drawn that way: a retry that ran is not a retry
  // that worked, and the status comes from the retried run's own outcome.
  if (status === 'Retrying') return <Pill tone="degraded">retrying</Pill>;
  return <Pill>{status.toLowerCase()}</Pill>;
}

export function when(iso: string | null): string {
  return iso ? iso.slice(0, 16).replace('T', ' ') : '—';
}

/**
 * Which lanes answered, on every tab, above everything else.
 *
 * A lane with no credential was never asked; a lane that refused was asked and
 * said no; a lane that answered with nothing is the only one of the three that
 * is actually good news. They are three different sentences here because they
 * are three different facts, and the page must never let the first two read as
 * the third.
 */
export function LaneReads({ lanes, only }: { lanes: LaneRead[]; only?: string | null }) {
  const shown = only ? lanes.filter((l) => l.lane === only) : lanes;
  const bad = shown.filter((l) => !l.read);
  if (bad.length === 0) {
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-faint">
        <span className="text-dim">
          {shown.length === 1 ? 'This lane was read' : `All ${shown.length} lanes were read`}
          {shown[0]?.at ? ` — last at ${when(shown[0].at)}` : ''}
        </span>
        {shown.map((l) => (
          <span key={l.lane}>
            {l.label} {l.open} open
          </span>
        ))}
      </div>
    );
  }
  return (
    <div className="card mb-1 px-4 py-3">
      <div className="text-[12.5px] font-medium text-degraded">
        {bad.length === shown.length ? (shown.length === 1 ? 'This lane was not read' : 'No lane was read') : `${bad.length} of ${shown.length} lanes were not read`}
      </div>
      <p className="mt-1 text-[11.5px] leading-snug text-dim">
        Every figure below is over what this database holds, not over what exists. A lane nobody asked looks exactly like a lane with nothing wrong, which is the one
        thing this page must not let you believe.
      </p>
      <div className="mt-2 space-y-1">
        {shown.map((l) => (
          <div key={l.lane} className="flex flex-wrap items-baseline justify-between gap-x-3 text-[11.5px]">
            <span className={l.read ? 'text-dim' : 'text-degraded'}>{l.label}</span>
            <span className="min-w-0 flex-1 truncate text-right text-faint" title={l.reason ?? undefined}>
              {l.read ? `read${l.at ? ` at ${when(l.at)}` : ''} · ${l.open} open` : (l.reason ?? 'not read')}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * One incident, opened up.
 *
 * `self_healing_strategy` is shown **in full and first among the text**: it is
 * written as plain English for a person to act on and it is the most useful
 * thing on this page. Truncating it to a line would throw away the only part
 * that tells somebody what to do.
 */
export function IncidentPanel({ incident, retry, onClose }: { incident: Incident; retry: RetryAttempt | undefined; onClose: () => void }) {
  const i = incident;
  return createPortal(
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/30 p-4 md:p-10" onClick={onClose}>
      <div className="card fade-up w-full max-w-[880px] px-6 py-5" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Incident">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="kicker tabular truncate">{i.entity_id}</div>
            <h2 className="mt-1 text-[18px] leading-tight">{i.summary ?? 'No summary was recorded for this incident.'}</h2>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-faint">
              <SeverityPill severity={i.severity} />
              <ClassPill cls={i.error_class} retryable={i.retryable} known={i.error_class_known} />
              {i.open_now ? <Pill tone="degraded">open</Pill> : <Pill tone="ok">no longer open</Pill>}
              <span>{i.lane_label}</span>
              {i.subsystem && <span>{i.subsystem}</span>}
              <span className="tabular">first seen {when(i.first_seen_at)}</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {/* Only where this database actually holds that execution. */}
            {i.execution_url && (
              <a href={i.execution_url} target="_blank" rel="noreferrer" className="btn btn-ghost btn-sm">
                Open in n8n
              </a>
            )}
            <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
              Close
            </button>
          </div>
        </div>

        {/*
          The advice, first and whole. It is the reason an incident is worth
          opening: everything else on this panel says what happened, and this
          says what to do about it.
        */}
        {i.self_healing_strategy ? (
          <div className="mt-4 rounded-[12px] bg-raised px-4 py-3">
            <div className="mb-1 text-[11px] text-faint">What the handler suggests</div>
            <p className="text-[13px] leading-relaxed whitespace-pre-wrap text-ink">{i.self_healing_strategy}</p>
          </div>
        ) : (
          <p className="mt-4 text-[12.5px] text-faint">This incident carries no self-healing advice — the handler recorded the failure without saying what to do about it.</p>
        )}

        <div className="mt-4 grid gap-3 border-t border-line pt-4 sm:grid-cols-3">
          <Fact label="Workflow" value={i.workflow ?? 'not named'} />
          <Fact label="Failed node" value={i.failed_node ?? 'not named'} />
          <Fact label="Execution" value={i.execution_id ?? 'not recorded'} />
          <Fact label="Retryable" value={i.retryable ? 'yes' : 'no'} hint={`according to ${i.retryable_from}`} />
          <Fact label="Severity" value={i.severity} hint={`according to ${i.severity_from}`} />
          <Fact label="Resolution status" value={i.resolution_status ?? 'not recorded'} />
          {i.max_retries !== null && <Fact label="Retry policy" value={`up to ${i.max_retries}${i.retry_interval ? ` every ${i.retry_interval}` : ''}`} />}
          {i.reclassified_from && <Fact label="Reclassified from" value={i.reclassified_from.toLowerCase().replace(/_/g, ' ')} />}
          {i.resolved_at && <Fact label="Resolved" value={when(i.resolved_at)} hint={i.resolved_by ? `by ${i.resolved_by}` : undefined} />}
          {i.hours_to_resolve !== null && <Fact label="Took" value={`${i.hours_to_resolve} h`} />}
        </div>

        {i.error_message && (
          <details className="mt-4 border-t border-line pt-4">
            <summary className="cursor-pointer text-[12.5px] text-dim">The error itself</summary>
            <p className="mt-2 max-h-[30vh] overflow-y-auto text-[12px] leading-relaxed whitespace-pre-wrap text-dim">{i.error_message}</p>
          </details>
        )}

        {/*
          Attempts come from `retry_attempts`, never from the incident's own
          `retries_attempted` — the healer does not maintain that field, so the
          number on the incident is stale the moment a retry happens.
        */}
        <div className="mt-4 border-t border-line pt-4">
          <div className="mb-1 text-[11px] text-faint">Retries</div>
          {retry ? (
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[12.5px] text-ink">
              <RetryStatusPill status={retry.status} />
              <span className="tabular">
                {retry.attempts ?? '—'} of 3 attempts
              </span>
              <span className="text-faint">last {when(retry.last_attempt_at)}</span>
              {retry.triggered_by && <span className="text-faint">started by {retry.triggered_by}</span>}
              {retry.last_result && <span className="w-full text-[12px] leading-snug text-dim">{retry.last_result}</span>}
            </div>
          ) : (
            <p className="text-[12.5px] text-faint">
              {i.retryable
                ? 'The healer has not touched this incident yet. It is in a retryable class, so the 5-minute loop should pick it up.'
                : 'This incident is in a class a retry cannot fix, so the healer never queues it. It needs a person.'}
            </p>
          )}
        </div>

        {i.impact_tags.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5 border-t border-line pt-3">
            {i.impact_tags.map((t) => (
              <span key={t} className="tag">
                {t}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

export function Fact({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] text-faint">{label}</div>
      <div className="mt-0.5 truncate text-[12.5px] text-ink" title={typeof value === 'string' ? value : undefined}>
        {value}
      </div>
      {hint && <div className="text-[11px] text-faint">{hint}</div>}
    </div>
  );
}
