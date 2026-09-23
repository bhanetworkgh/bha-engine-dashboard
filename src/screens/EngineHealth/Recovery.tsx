import { useState } from 'react';
import { useData } from '../../app/useData';
import {
  getRecovery,
  rerunRecovery,
  setRecoveryEnabled,
  type DependencyState,
  type RecoveryDependency,
  type RecoveryRow,
  type RecoveryStatus,
} from '../../data';
import { Button, Card, CardHeader, Dot, EmptyState, LoadFailed, Loading, Pill, RecordId, TableFrame, Th } from '../../components/ui';
import { when } from './parts';
import { HEALTH_KINDS } from './kinds';

/**
 * Waiting on a dependency — the recovery watcher (2026-09-23, Destiny).
 *
 * A failure caused by something the engine depends on being down — OpenRouter
 * out of credit, a Slack or Google login lapsed, BHARAG not answering — is an
 * open incident in the ledger. The healer retries it for twenty minutes and
 * stops. This tab is the other half: what is waiting for that dependency to
 * come back, whether it has, and what happened when the watcher re-ran it.
 *
 * **One group per dependency**, with its state from the last probe, because
 * "waiting on OpenRouter" is only useful beside whether OpenRouter answers. A
 * dependency nobody waits on is still drawn: a probe that says Slack is down
 * matters before anything has failed on it.
 *
 * **The last batch reads exactly as the Slack summary did** — the outcomes
 * come from the runs that were sent, not recomputed.
 */

const DEPS: RecoveryDependency[] = ['openrouter', 'slack', 'google', 'bharag'];
const LABEL: Record<RecoveryDependency, string> = { openrouter: 'OpenRouter', slack: 'Slack', google: 'Google', bharag: 'BHARAG' };

/** One line per status, in plain English, for the tooltip on each pill. */
const STATUS_DEF: Record<RecoveryStatus, string> = {
  waiting: 'Waiting for the dependency to answer again. Nothing has been re-run yet.',
  replaying: 'Handed to the healer with recovery: true. It retries from the failed step up to three times; the outcome lands from retry_attempts.',
  recovered: 'The re-run worked. The healer closed the ledger incident as self_healed.',
  already_done: 'Nothing to re-run: the ledger incident was already closed, or n8n already held a successful retry.',
  chat_not_rerun: 'A chat reply. The registry says never re-run it, so the incident was closed as won’t fix.',
  failed_again: 'The re-run failed again, or the healer never answered. The incident stays open for a person.',
  data_gone: 'n8n no longer holds the failed run, so there is nothing to resume. It can only be re-run from its own trigger.',
};

function StatusPill({ status }: { status: RecoveryStatus }) {
  const word = status.replace(/_/g, ' ');
  const tone = status === 'failed_again' ? 'failing' : status === 'data_gone' ? 'degraded' : status === 'replaying' || status === 'recovered' ? 'accent' : 'default';
  return (
    <span title={STATUS_DEF[status]}>
      <Pill tone={tone}>{word}</Pill>
    </span>
  );
}

function depHealth(d: DependencyState | undefined): 'ok' | 'degraded' | 'failing' {
  if (!d || d.ok === null) return 'degraded';
  return d.ok ? 'ok' : 'failing';
}

function depWords(d: DependencyState | undefined, probed: boolean): string {
  if (!probed) return 'not probed yet — the watcher probes only while something is waiting';
  if (!d || d.ok === null) return d?.status ? `unknown (${d.status})` : 'unknown — the probe did not say';
  const money = typeof d.remaining_usd === 'number' ? ` · $${d.remaining_usd.toFixed(2)} left${typeof d.floor_usd === 'number' ? ` (floor $${d.floor_usd.toFixed(2)})` : ''}` : '';
  return `${d.ok ? 'ok' : `not ok${d.status ? ` (${d.status})` : ''}`}${money}`;
}

export default function Recovery() {
  const [tick, setTick] = useState(0);
  const { status, data, error } = useData(getRecovery, [tick], { kinds: HEALTH_KINDS });
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<{ ok: boolean; message: string } | null>(null);

  if (status === 'loading' && !data) return <Loading />;
  if (status === 'error' && !data) return <LoadFailed error={error} />;
  if (!data) return <Loading />;

  const flip = () => {
    if (busy) return;
    setBusy('toggle');
    setSaid(null);
    void setRecoveryEnabled(!data.switch_on)
      .catch((e: unknown) => setSaid({ ok: false, message: e instanceof Error ? e.message : 'The switch could not be flipped.' }))
      .finally(() => {
        setBusy(null);
        setTick((n) => n + 1);
      });
  };

  const rerun = (r: RecoveryRow) => {
    if (busy) return;
    setBusy(r.incident_id);
    setSaid(null);
    void rerunRecovery(r.incident_id)
      .then((res) => setSaid({ ok: res.ok, message: `${r.incident_id} — ${res.message}` }))
      .catch((e: unknown) => setSaid({ ok: false, message: e instanceof Error ? e.message : 'The re-run could not be sent.' }))
      .finally(() => {
        setBusy(null);
        setTick((n) => n + 1);
      });
  };

  // The page switch's own position, separate from the env override: the
  // button says what pressing it does to the switch, and the override is a
  // sentence beside it rather than a button that silently does nothing.
  const switchOn = data.switch_on;
  const probed = Boolean(data.last_probe);
  const settled = data.rows.filter((r) => r.status !== 'waiting' && r.status !== 'replaying');
  const batch = data.last_batch;

  return (
    <div className="scroll-thin flex min-h-0 flex-1 flex-col gap-4 overflow-x-hidden overflow-y-auto px-6 pb-6 md:px-8">
      <Card className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
        <div className="min-w-0 text-[12.5px]">
          <div className="flex items-center gap-2 text-[13px] font-medium text-ink">
            <Dot health={data.enabled ? 'ok' : 'degraded'} title={data.enabled ? 'on' : 'off'} />
            Recovery is {data.enabled ? 'on' : 'off'}
          </div>
          <p className="mt-1 text-dim">
            {data.disabled_by === 'env'
              ? 'RECOVERY_ENABLED=false is set on the service and overrides this switch. Nothing waiting is re-run until it is removed.'
              : data.enabled
                ? `Every ${Math.round(data.interval_seconds / 60)} minutes, while an incident waits on a dependency, the watcher probes it and re-runs what was waiting once it answers.`
                : 'Nothing is probed and nothing is re-run. Incidents are still noted as waiting.'}
            {data.toggled_by && <span className="text-faint"> Last switched by {data.toggled_by} at {when(data.toggled_at)}.</span>}
            {data.last_tick_at && <span className="text-faint"> Last tick {when(data.last_tick_at)}.</span>}
          </p>
        </div>
        <Button variant="secondary" size="sm" loading={busy === 'toggle'} disabled={busy !== null} onClick={flip}>
          {switchOn ? 'Switch off' : 'Switch on'}
        </Button>
      </Card>

      {!data.heal_configured && <p className="text-[12.5px] text-degraded">ENGINE_HEAL_URL is empty on this server, so nothing can be handed to the healer.</p>}
      {!data.n8n_configured && <p className="text-[12.5px] text-degraded">N8N_API_KEY is not set, so failed runs cannot be read and nothing is re-run.</p>}
      {data.last_probe?.error && (
        <p className="text-[12.5px] text-degraded">
          The last probe could not ask n8n about OpenRouter, Slack and Google: {data.last_probe.error}
        </p>
      )}

      {said && (
        <Card className={`px-5 py-3 text-[12.5px] ${said.ok ? 'text-ink' : 'text-failing'}`}>
          <span role="status">{said.message}</span>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {DEPS.map((dep) => {
          const d = data.last_probe?.dependencies[dep];
          const rows = [...data.waiting, ...data.replaying].filter((r) => r.dependency === dep);
          return (
            <Card key={dep} className="flex flex-col pb-3">
              <CardHeader
                title={
                  <span className="flex items-center gap-2">
                    <Dot health={probed ? depHealth(d) : 'degraded'} title={depWords(d, probed)} />
                    {LABEL[dep]}
                  </span>
                }
                right={<span className="tabular text-[11.5px] text-faint">{rows.length} waiting</span>}
              />
              <p className="px-5 pb-2 text-[11.5px] text-dim">
                {depWords(d, probed)}
                {probed && <span className="text-faint"> · probed {when(data.last_probe!.checked_at)}</span>}
              </p>
              {rows.length === 0 ? (
                <p className="px-5 py-2 text-[12.5px] text-faint">Nothing is waiting on {LABEL[dep]}.</p>
              ) : (
                <ul className="divide-y divide-[var(--color-line,transparent)] px-5">
                  {rows.map((r) => (
                    <li key={r.incident_id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-[12.5px]">
                      <div className="min-w-0">
                        <div className="truncate text-ink" title={r.workflow ?? undefined}>
                          {r.workflow ?? <span className="text-faint">unnamed workflow</span>}
                        </div>
                        <div className="tabular truncate text-[11px] text-faint" title={r.dependency_from ?? undefined}>
                          failed {when(r.failed_at)} · {(r.error_class ?? 'unclassified').toLowerCase().replace(/_/g, ' ')} · <RecordId>{r.incident_id}</RecordId>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <StatusPill status={r.status} />
                        {r.status === 'waiting' && (
                          <Button
                            variant="ghost"
                            size="sm"
                            loading={busy === r.incident_id}
                            disabled={busy !== null || !data.enabled || Boolean(r.batch_id)}
                            title={
                              !data.enabled
                                ? 'Recovery is off. Switch it on to re-run from here.'
                                : 'Re-runs this one failure now from its failed step, whatever the last probe said.'
                            }
                            onClick={() => rerun(r)}
                          >
                            Re-run now
                          </Button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          );
        })}
      </div>

      <Card className="pb-3">
        <CardHeader
          title="Last batch"
          right={batch ? <span className="tabular text-[11.5px] text-faint">{when(batch.started_at)}</span> : undefined}
        />
        {!batch ? (
          <EmptyState compact>No recovery batch has run yet. One starts when a dependency something waited on answers again.</EmptyState>
        ) : (
          <div className="px-5 text-[12.5px]">
            <p className="text-dim">
              {LABEL[batch.dependency]} came back · started by {batch.started_by.replace(/^manual:/, '')} ·{' '}
              {batch.pending
                ? `${batch.pending} still replaying; the Slack summary goes once they settle.`
                : batch.summary_sent_at
                  ? `summary ${batch.summary_http && batch.summary_http < 300 ? 'sent' : 'not delivered'} ${when(batch.summary_sent_at)}${batch.summary_detail && !(batch.summary_http && batch.summary_http < 300) ? ` — ${batch.summary_detail}` : ''}`
                  : 'settled'}
            </p>
            <ul className="mt-2 space-y-1">
              {batch.runs.map((r) => (
                <li key={`${r.execution_id}-${r.workflow}`} className="flex flex-wrap items-baseline gap-2">
                  <StatusPill status={r.outcome} />
                  <span className="text-ink">{r.workflow}</span>
                  <span className="tabular text-faint">exec {r.execution_id || '—'}</span>
                  {r.retry_execution_id && <span className="tabular text-faint">→ {r.retry_execution_id}</span>}
                  {r.note && <span className="min-w-0 truncate text-dim" title={r.note}>{r.note}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>

      <Card className="pb-3">
        <CardHeader title="What the next tick would do" />
        <ul className="list-disc space-y-1 px-9 text-[12.5px] text-dim">
          {data.next_tick.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        {data.skipped.length > 0 && (
          <details className="px-5 pt-2 text-[12px]">
            <summary className="cursor-pointer text-dim">{data.skipped.length} open incident(s) not waiting on a dependency, and why</summary>
            <ul className="mt-1 space-y-1 text-faint">
              {data.skipped.map((x) => (
                <li key={x.incident_id}>
                  <span className="tabular">{x.incident_id}</span> {x.workflow ? `· ${x.workflow}` : ''} — {x.reason}
                </li>
              ))}
            </ul>
          </details>
        )}
      </Card>

      {settled.length > 0 && (
        <TableFrame grow={false} label="Settled recoveries">
          <thead>
            <tr>
              <Th>settled</Th>
              <Th>workflow</Th>
              <Th>waited on</Th>
              <Th>outcome</Th>
              <Th>note</Th>
              <Th>incident</Th>
            </tr>
          </thead>
          <tbody>
            {settled.map((r) => (
              <tr key={r.incident_id}>
                <td className="td tabular whitespace-nowrap text-faint">{when(r.updated_at)}</td>
                <td className="td td-clip" style={{ maxWidth: '30ch' }} title={r.workflow ?? undefined}>
                  {r.execution_url ? (
                    <a className="link" href={r.execution_url} target="_blank" rel="noreferrer">
                      {r.workflow ?? r.execution_id}
                    </a>
                  ) : (
                    (r.workflow ?? r.execution_id ?? '—')
                  )}
                </td>
                <td className="td text-dim">{LABEL[r.dependency]}</td>
                <td className="td">
                  <StatusPill status={r.status} />
                </td>
                <td className="td td-clip text-dim" style={{ maxWidth: '50ch' }} title={r.note ?? undefined}>
                  {r.note ?? '—'}
                </td>
                <td className="td td-clip" style={{ maxWidth: '24ch' }}>
                  <RecordId>{r.incident_id}</RecordId>
                </td>
              </tr>
            ))}
          </tbody>
        </TableFrame>
      )}
    </div>
  );
}
