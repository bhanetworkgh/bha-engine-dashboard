import type { VfarmGateBoard, VfarmGateCheck, VfarmGateRecord, VfarmGatesData } from '../../data';
import { Card, CardHeader, EmptyState, FigureCell, Pill, RecordId, StatStrip, TableFrame, Th, relativeTime } from '../../components/ui';

/**
 * The vFarm stage gates and the 5-rack pilot offer (2026-10-09, Destiny —
 * LOOP-1791479575963-7S0O).
 *
 * Three records Jason locked on 8 Oct: the Stage 1 lab validation, the Stage 2
 * pilot checklist and the 5-rack pilot offer. This tab reads them; it does not
 * write them. They are written through the engine, which is where the order is
 * enforced: Stage 2 stays planned until Stage 1 is passed, and an offer cannot
 * be offered or signed without a Stage 2 record tied to it.
 *
 * **A scoreboard, not a list** (second pass, the same day). The strip at the
 * top is the three steps in order, with the locked ones shown locked. Under it
 * each record carries its numbers: checks passed out of four, days to its
 * target date, days in its current status, and for a pilot its uptime and
 * incidents against the budgets Jason set. The figures come from the server,
 * worked out from the records, the events and the Monitoring Twin.
 *
 * **Nothing is drawn that nobody wrote.** Before the first record each step
 * says so. A test fixture is labelled on every row it appears in and never
 * stands in the strip.
 *
 * **It says who or what fills each check.** A sensor-fed check says so; a check
 * no sensor covers says who was asked and when. Nothing here calls a check a
 * person records automated detection.
 */

const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : '—');
const txt = (v: unknown): string => (v === null || v === undefined || v === '' ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));
const words = (s: string) => s.replace(/_/g, ' ');
const NO_BOARD: VfarmGateBoard = { days_in_status: null, days_to_target: null, farm: null };

function StatusPill({ status }: { status: string }) {
  if (status === 'passed' || status === 'signed') return <Pill tone="ok">{status}</Pill>;
  if (status === 'failed') return <Pill tone="failing">{status}</Pill>;
  if (status === 'in_progress' || status === 'offered' || status === 'final' || status === 'under_review') return <Pill tone="accent">{words(status)}</Pill>;
  return <Pill>{status}</Pill>;
}

function FixtureTag({ fixture }: { fixture: boolean }) {
  return fixture ? (
    <span className="ml-2">
      <Pill tone="degraded">test fixture</Pill>
    </span>
  ) : null;
}

function Waiting({ children }: { children: string }) {
  return <EmptyState compact>{children}</EmptyState>;
}

/** The three steps in order. A step is done, under way, waiting to be written, or locked behind the one before it. */
function Pipeline({ steps }: { steps: VfarmGatesData['pipeline'] }) {
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
      {steps.map((s, i) => {
        const done = s.status === 'passed' || s.status === 'signed';
        const failed = s.status === 'failed';
        const edge = done ? 'border-ok' : failed ? 'border-failing' : s.status && s.status !== 'planned' && s.status !== 'draft' ? 'border-accent' : 'border-line';
        return (
          <div key={s.key} className={`card border-l-4 px-5 py-4 ${edge} ${s.locked && !s.status ? 'opacity-70' : ''}`}>
            <div className="kicker">
              Step {i + 1} of {steps.length}
            </div>
            <div className="mt-1 text-[13px] font-medium text-ink">{s.label}</div>
            <div className={`font-display mt-2 text-[24px] leading-none ${done ? 'text-ink' : failed ? 'text-failing' : s.status ? 'text-ink' : 'text-faint'}`}>{s.status ? words(s.status) : s.locked ? 'Locked' : 'Not started'}</div>
            <div className="mt-2 text-[11.5px] leading-snug text-faint">{s.locked_reason ?? (s.record_id ? s.record_id : 'No record has been written yet.')}</div>
          </div>
        );
      })}
    </div>
  );
}

function CheckCell({ check }: { check: VfarmGateCheck | undefined }) {
  const status = check?.status ?? 'pending';
  if (status === 'pending') return <span className="text-faint">not checked yet</span>;
  const how = check?.source === 'sensor' ? 'sensor' : 'by a person';
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {status === 'passed' ? <Pill tone="ok">passed</Pill> : <Pill tone="failing">failed</Pill>}
      <span className="text-[11.5px] text-faint">
        {how} · {txt(check?.checked_by)} · {day(check?.checked_at)}
      </span>
    </span>
  );
}

function targetCaption(b: VfarmGateBoard, target: string | undefined): string {
  if (b.days_to_target === null) return 'no target date on the record';
  return b.days_to_target < 0 ? `target ${day(target)} has passed` : `to the target, ${day(target)}`;
}

function FarmLine({ b }: { b: VfarmGateBoard }) {
  if (!b.farm) return <span>No farm named, so no sensor feeds this record.</span>;
  return (
    <span className={b.farm.feed_silent ? 'text-degraded' : ''}>
      Reads {b.farm.name ?? b.farm.farm_id}
      {b.farm.simulated ? ' (simulated)' : ''}
      {b.farm.feed_silent ? ': its feed is silent, so nothing is being judged' : `, last snapshot ${relativeTime(b.farm.last_snapshot_at) ?? '—'}`}.
    </span>
  );
}

function Stage1Card({ r, b, checks }: { r: VfarmGateRecord; b: VfarmGateBoard; checks: VfarmGatesData['checks'] }) {
  const total = b.checks_total ?? checks.length;
  return (
    <div className="border-t border-line px-5 py-4 first:border-t-0">
      <div className="mb-3 flex flex-wrap items-center gap-2 text-[12.5px]">
        <RecordId>{r.id}</RecordId>
        <StatusPill status={r.status} />
        <FixtureTag fixture={r.fixture} />
        <span className="text-dim">
          crop {txt(r.crop_profile)} · growth stage {txt(r.growth_stage)} · owner {txt(r.owner_slack_id)} · <FarmLine b={b} />
        </span>
      </div>
      <StatStrip cols={4} flush>
        <FigureCell label="Checks passed" value={b.checks_passed ?? 0} unit={`of ${total}`} caption={b.checks_pending ? `${b.checks_pending} still to come` : 'all four are in'} note="How many of the four Stage 1 checks are recorded as passed." />
        <FigureCell label="Checks failed" value={b.checks_failed ?? 0} tone={b.checks_failed ? 'degraded' : undefined} caption={b.checks_failed ? 'each one was announced in Slack' : 'none failing now'} note="Checks recorded as failed right now. A check that later passes stops counting; its failure stays in the events." />
        <FigureCell label="Days to target" value={b.days_to_target} tone={b.days_to_target !== null && b.days_to_target < 0 ? 'degraded' : undefined} missing="No target" caption={targetCaption(b, r.target_date)} note="Whole days from today to the record's target date. Negative once the date has passed." />
        <FigureCell label="Days in this status" value={b.days_in_status} caption={`${words(r.status)} since the last status change`} note="Days since the record's last status change, read from its events." />
      </StatStrip>
      {b.status_proposed_to ? (
        <p className="mt-2 text-[12px] text-dim">
          All four checks have passed. {b.status_proposed_to} was asked {relativeTime(b.status_proposed_at ?? null) ?? 'just now'} whether to mark Stage 1 passed; nothing changes until they answer.
        </p>
      ) : null}
      <TableFrame flat grow={false} label={`Checks on ${r.id}`}>
        <thead>
          <tr>
            <Th>check</Th>
            <Th>filled by</Th>
            <Th>outcome</Th>
            <Th>value</Th>
            <Th>notes</Th>
          </tr>
        </thead>
        <tbody>
          {checks.map((c) => {
            const v = r[c.name] as VfarmGateCheck | undefined;
            const meta = b.checks ? b.checks[c.name] : undefined;
            const pending = (v?.status ?? 'pending') === 'pending';
            return (
              <tr key={c.name}>
                <td className="td">{c.label}</td>
                <td className="td text-dim">
                  {meta?.fed_by === 'sensor' ? 'a sensor, through the Monitoring Twin' : 'a person'}
                  {pending && meta?.asked_user ? <span className="text-faint"> · {meta.asked_user} asked {relativeTime(meta.asked_at) ?? 'just now'}</span> : null}
                </td>
                <td className="td">
                  <CheckCell check={v} />
                </td>
                <td className="td td-clip text-dim" style={{ maxWidth: '26ch' }} title={txt(v?.value)}>
                  {txt(v?.value)}
                </td>
                <td className="td td-clip text-dim" style={{ maxWidth: '36ch' }} title={txt(v?.notes)}>
                  {txt(v?.notes)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </TableFrame>
    </div>
  );
}

function Stage2Card({ r, b }: { r: VfarmGateRecord; b: VfarmGateBoard }) {
  const uptime = b.uptime_pct ?? null;
  const uptimeTarget = b.uptime_target_pct ?? null;
  const incidents = b.incidents_7d ?? null;
  const budget = b.alert_budget_per_week ?? null;
  return (
    <div className="border-t border-line px-5 py-4 first:border-t-0">
      <div className="mb-3 flex flex-wrap items-center gap-2 text-[12.5px]">
        <RecordId>{r.id}</RecordId>
        <StatusPill status={r.status} />
        <FixtureTag fixture={r.fixture} />
        <span className="text-dim">
          follows {txt(r.stage1_ref)}{' '}
          <span className={b.locked ? 'text-degraded' : 'text-faint'}>({b.locked ? `Stage 1 is ${words(b.stage1_status ?? 'missing')}: this cannot start` : 'Stage 1 passed'})</span> · {txt(r.rack_count)} racks · crop {txt(r.crop_profile)} · growth stage{' '}
          {txt(r.growth_stage)} · <FarmLine b={b} />
        </span>
      </div>
      <StatStrip cols={4} flush>
        <FigureCell
          label="Uptime, last 24 h"
          value={uptime}
          unit="%"
          tone={uptime !== null && uptimeTarget !== null && uptime < uptimeTarget ? 'degraded' : undefined}
          missing="No live feed"
          caption={uptimeTarget !== null ? `target ${uptimeTarget}%` : 'no target set on the record'}
          note="The Monitoring Twin's figure for the farm this record names: the share of observed time with no device offline."
        />
        <FigureCell
          label="Incidents, last 7 days"
          value={incidents}
          tone={incidents !== null && budget !== null && incidents > budget ? 'degraded' : undefined}
          missing="No farm named"
          caption={budget !== null ? `budget ${budget} a week` : 'no budget set on the record'}
          note="Monitoring incidents opened on that farm in the last seven days, against the record's alert volume budget."
        />
        <FigureCell label="Days to target" value={b.days_to_target} tone={b.days_to_target !== null && b.days_to_target < 0 ? 'degraded' : undefined} missing="No target" caption={targetCaption(b, r.target_date)} note="Whole days from today to the record's target date." />
        <FigureCell label="Days in this status" value={b.days_in_status} caption={`${words(r.status)} since the last status change`} note="Days since the record's last status change, read from its events." />
      </StatStrip>
    </div>
  );
}

export function Gates({ data }: { data: VfarmGatesData }) {
  const board = (id: string): VfarmGateBoard => data.boards[id] ?? NO_BOARD;
  return (
    <div className="scroll-thin flex min-h-0 flex-1 flex-col gap-4 overflow-x-hidden overflow-y-auto px-6 pb-6 md:px-8">
      <Pipeline steps={data.pipeline} />

      <p className="max-w-[120ch] text-[12px] text-dim">
        {data.automation.sensor_checks} {data.automation.status}
        {data.fixtures > 0 ? ` ${data.fixtures} record${data.fixtures === 1 ? '' : 's'} below ${data.fixtures === 1 ? 'is a test fixture' : 'are test fixtures'}, not real state, and never shown in the strip above.` : ''}
        {data.alert_channel_configured ? '' : ' No Slack channel is set for gate alerts, so a status change or a failed check will not be announced.'}
        {data.automation.twin_error ? ` The Monitoring Twin could not be read just now (${data.automation.twin_error}), so the sensor-fed figures are missing.` : ''}
      </p>

      <Card className="pb-3">
        <CardHeader title="Stage 1 · lab validation" right={<span className="tabular text-[11.5px] text-faint">VFARM_STAGE1_LAB_VALIDATION_v1</span>} />
        {data.stage1.length === 0 ? (
          <Waiting>No Stage 1 record has been written yet. Jason or Bays writes the first one; nothing is filled in here on its behalf.</Waiting>
        ) : (
          data.stage1.map((r) => <Stage1Card key={r.id} r={r} b={board(r.id)} checks={data.checks} />)
        )}
      </Card>

      <Card className="pb-3">
        <CardHeader title="Stage 2 · pilot checklist" right={<span className="tabular text-[11.5px] text-faint">VFARM_STAGE2_PILOT_CHECKLIST_v1</span>} />
        {data.stage2.length === 0 ? (
          <Waiting>No Stage 2 record yet. One can be planned once a Stage 1 record exists, and can start only after that Stage 1 has passed.</Waiting>
        ) : (
          data.stage2.map((r) => <Stage2Card key={r.id} r={r} b={board(r.id)} />)
        )}
      </Card>

      <Card className="pb-3">
        <CardHeader title="5-rack pilot offer" right={<span className="tabular text-[11.5px] text-faint">VFARM_5RACK_PILOT_OFFER_v1</span>} />
        {data.offers.length === 0 ? (
          <Waiting>No offer record yet. An offer can be drafted at any time, and can be offered or signed only once a Stage 2 record is tied to it.</Waiting>
        ) : (
          <TableFrame flat grow={false} label="5-rack pilot offers">
            <thead>
              <tr>
                <Th>record</Th>
                <Th>status</Th>
                <Th>tied to Stage 2</Th>
                <Th>Early Access leads tied</Th>
                <Th>days to target</Th>
                <Th>days in status</Th>
              </tr>
            </thead>
            <tbody>
              {data.offers.map((r) => {
                const b = board(r.id);
                return (
                  <tr key={r.id}>
                    <td className="td whitespace-nowrap">
                      <RecordId>{r.id}</RecordId>
                      <FixtureTag fixture={r.fixture} />
                    </td>
                    <td className="td">
                      <StatusPill status={r.status} />
                    </td>
                    <td className="td text-dim">{r.stage2_ref ? r.stage2_ref : <span className="text-degraded">none: cannot be offered or signed</span>}</td>
                    <td className="td text-dim">
                      {r.linked_leads && r.linked_leads.length > 0 ? r.linked_leads.map((l) => `${l.full_name}${l.organization_name ? ` (${l.organization_name})` : ''}`).join(', ') : <span className="text-faint">none</span>}
                    </td>
                    <td className={`td tabular ${b.days_to_target !== null && b.days_to_target < 0 ? 'text-degraded' : 'text-dim'}`}>{b.days_to_target === null ? '—' : b.days_to_target}</td>
                    <td className="td tabular text-dim">{b.days_in_status === null ? '—' : b.days_in_status}</td>
                  </tr>
                );
              })}
            </tbody>
          </TableFrame>
        )}
      </Card>

      <Card className="pb-3">
        <CardHeader title="Events" right={<span className="tabular text-[11.5px] text-faint">newest first · every change writes one</span>} />
        {data.events.length === 0 ? (
          <Waiting>No gate event has been written yet. Each status change and each check update writes one, in the same step as the change itself.</Waiting>
        ) : (
          <TableFrame flat grow={false} label="vFarm gate events">
            <thead>
              <tr>
                <Th>when (UTC)</Th>
                <Th>event</Th>
                <Th>record</Th>
                <Th>what</Th>
                <Th>by</Th>
              </tr>
            </thead>
            <tbody>
              {data.events.map((e) => {
                const d = e.detail;
                const what =
                  e.event_type === 'VFARM_CHECK_UPDATED'
                    ? `${txt(d.check)}: ${txt(d.outcome)} (${txt(d.source)})`
                    : e.event_type === 'VFARM_GATE_ALERT_FAILED'
                      ? `Slack message not delivered: ${txt(d.error)}`
                      : `${d.old_status ? `${txt(d.old_status)} → ` : 'created as '}${txt(d.new_status)}`;
                return (
                  <tr key={e.id}>
                    <td className="td tabular whitespace-nowrap text-dim">{e.at.slice(0, 16).replace('T', ' ')}</td>
                    <td className={`td ${e.event_type === 'VFARM_GATE_ALERT_FAILED' ? 'text-degraded' : ''}`}>{e.event_type}</td>
                    <td className="td whitespace-nowrap">
                      <RecordId>{e.subject_id}</RecordId>
                      <FixtureTag fixture={d.fixture === true} />
                    </td>
                    <td className="td text-dim">{what}</td>
                    <td className="td text-dim">{txt(e.actor)}</td>
                  </tr>
                );
              })}
            </tbody>
          </TableFrame>
        )}
      </Card>
    </div>
  );
}
