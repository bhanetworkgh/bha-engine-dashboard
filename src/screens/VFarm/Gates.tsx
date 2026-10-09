import type { VfarmGateCheck, VfarmGateRecord, VfarmGatesData } from '../../data';
import { Card, CardHeader, EmptyState, Pill, RecordId, TableFrame, Th, relativeTime } from '../../components/ui';

/**
 * The vFarm stage gates and the 5-rack pilot offer (2026-10-09, Destiny —
 * LOOP-1791479575963-7S0O).
 *
 * Three records Jason locked on 8 Oct: the Stage 1 lab validation, the Stage 2
 * pilot checklist and the 5-rack pilot offer. This tab reads them; it does not
 * write them. They are written through the engine (write_vfarm_gate, or
 * POST /api/engine/vfarm-gates), which is where the order is enforced: Stage 2
 * stays planned until Stage 1 is passed, and an offer cannot be offered or
 * signed without a Stage 2 record tied to it.
 *
 * **Nothing is drawn that nobody wrote.** Before the first record each section
 * says so. A test fixture is labelled as one on every row it appears in.
 *
 * **Three of the four checks are recorded by a person**, not a sensor, and the
 * tab says which. It never calls them automated detection.
 */

const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : '—');
const txt = (v: unknown): string => (v === null || v === undefined || v === '' ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));

function StatusPill({ status }: { status: string }) {
  if (status === 'passed' || status === 'signed') return <Pill tone="ok">{status}</Pill>;
  if (status === 'failed') return <Pill tone="failing">{status}</Pill>;
  if (status === 'in_progress' || status === 'offered' || status === 'final' || status === 'under_review') return <Pill tone="accent">{status.replace('_', ' ')}</Pill>;
  return <Pill>{status}</Pill>;
}

function FixtureTag({ r }: { r: VfarmGateRecord }) {
  return r.fixture ? (
    <span className="ml-2">
      <Pill tone="degraded">test fixture</Pill>
    </span>
  ) : null;
}

function Waiting({ children }: { children: string }) {
  return <EmptyState compact>{children}</EmptyState>;
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

function Stage1Card({ r, checks }: { r: VfarmGateRecord; checks: VfarmGatesData['checks'] }) {
  return (
    <div className="border-t border-line px-5 py-3 first:border-t-0">
      <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
        <RecordId>{r.id}</RecordId>
        <StatusPill status={r.status} />
        <FixtureTag r={r} />
        <span className="text-dim">
          target {day(r.target_date)} · crop {txt(r.crop_profile)} · growth stage {txt(r.growth_stage)} · updated {relativeTime(r.updated_at) ?? '—'} by {txt(r.updated_by)}
        </span>
      </div>
      <TableFrame flat grow={false} label={`Checks on ${r.id}`}>
        <thead>
          <tr>
            <Th>check</Th>
            <Th>recorded by</Th>
            <Th>outcome</Th>
            <Th>value</Th>
            <Th>notes</Th>
          </tr>
        </thead>
        <tbody>
          {checks.map((c) => {
            const v = r[c.name] as VfarmGateCheck | undefined;
            return (
              <tr key={c.name}>
                <td className="td">{c.label}</td>
                <td className="td text-dim">{c.recorded_by}</td>
                <td className="td">
                  <CheckCell check={v} />
                </td>
                <td className="td td-clip text-dim" style={{ maxWidth: '24ch' }} title={txt(v?.value)}>
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

export function Gates({ data }: { data: VfarmGatesData }) {
  const stage1Status = (id: string | null | undefined) => data.stage1.find((s) => s.id === id)?.status ?? null;
  return (
    <div className="scroll-thin flex min-h-0 flex-1 flex-col gap-4 overflow-x-hidden overflow-y-auto px-6 pb-6 md:px-8">
      <p className="max-w-[110ch] text-[12px] text-dim">
        The order is enforced by the engine, whoever writes: {data.gates.join(' ')} {data.note}
        {data.fixtures > 0 ? ` ${data.fixtures} record${data.fixtures === 1 ? '' : 's'} below ${data.fixtures === 1 ? 'is a test fixture' : 'are test fixtures'}, not real state.` : ''}
        {data.alert_channel_configured ? '' : ' No Slack channel is set for gate alerts, so a status change or a failed check will not be announced.'}
      </p>

      <Card className="pb-3">
        <CardHeader title="Stage 1 · lab validation" right={<span className="tabular text-[11.5px] text-faint">VFARM_STAGE1_LAB_VALIDATION_v1</span>} />
        {data.stage1.length === 0 ? (
          <Waiting>No Stage 1 record has been written yet. Jason or Bays writes the first one; nothing is filled in here on its behalf.</Waiting>
        ) : (
          data.stage1.map((r) => <Stage1Card key={r.id} r={r} checks={data.checks} />)
        )}
      </Card>

      <Card className="pb-3">
        <CardHeader title="Stage 2 · pilot checklist" right={<span className="tabular text-[11.5px] text-faint">VFARM_STAGE2_PILOT_CHECKLIST_v1</span>} />
        {data.stage2.length === 0 ? (
          <Waiting>No Stage 2 record yet. One can be planned once a Stage 1 record exists, and can start only after that Stage 1 has passed.</Waiting>
        ) : (
          <TableFrame flat grow={false} label="Stage 2 pilot checklists">
            <thead>
              <tr>
                <Th>record</Th>
                <Th>status</Th>
                <Th>follows Stage 1</Th>
                <Th>racks</Th>
                <Th>crop · growth stage</Th>
                <Th>target</Th>
                <Th>updated</Th>
              </tr>
            </thead>
            <tbody>
              {data.stage2.map((r) => {
                const s1 = stage1Status(r.stage1_ref);
                return (
                  <tr key={r.id}>
                    <td className="td whitespace-nowrap">
                      <RecordId>{r.id}</RecordId>
                      <FixtureTag r={r} />
                    </td>
                    <td className="td">
                      <StatusPill status={r.status} />
                    </td>
                    <td className="td text-dim">
                      {txt(r.stage1_ref)} <span className={s1 === 'passed' ? 'text-faint' : 'text-degraded'}>({s1 === 'passed' ? 'passed' : `${s1 ?? 'missing'}: Stage 2 cannot start`})</span>
                    </td>
                    <td className="td tabular text-dim">{txt(r.rack_count)}</td>
                    <td className="td text-dim">
                      {txt(r.crop_profile)} · {txt(r.growth_stage)}
                    </td>
                    <td className="td tabular text-dim">{day(r.target_date)}</td>
                    <td className="td text-dim">
                      {relativeTime(r.updated_at) ?? '—'} by {txt(r.updated_by)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </TableFrame>
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
                <Th>target</Th>
                <Th>updated</Th>
              </tr>
            </thead>
            <tbody>
              {data.offers.map((r) => (
                <tr key={r.id}>
                  <td className="td whitespace-nowrap">
                    <RecordId>{r.id}</RecordId>
                    <FixtureTag r={r} />
                  </td>
                  <td className="td">
                    <StatusPill status={r.status} />
                  </td>
                  <td className="td text-dim">{r.stage2_ref ? r.stage2_ref : <span className="text-degraded">none: cannot be offered or signed</span>}</td>
                  <td className="td text-dim">
                    {r.linked_leads && r.linked_leads.length > 0
                      ? r.linked_leads.map((l) => `${l.full_name}${l.organization_name ? ` (${l.organization_name})` : ''}`).join(', ')
                      : <span className="text-faint">none</span>}
                  </td>
                  <td className="td tabular text-dim">{day(r.target_date)}</td>
                  <td className="td text-dim">
                    {relativeTime(r.updated_at) ?? '—'} by {txt(r.updated_by)}
                  </td>
                </tr>
              ))}
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
                      ? `Slack alert not delivered: ${txt(d.error)}`
                      : `${d.old_status ? `${txt(d.old_status)} → ` : 'created as '}${txt(d.new_status)}`;
                return (
                  <tr key={e.id}>
                    <td className="td tabular whitespace-nowrap text-dim">{e.at.slice(0, 16).replace('T', ' ')}</td>
                    <td className={`td ${e.event_type === 'VFARM_GATE_ALERT_FAILED' ? 'text-degraded' : ''}`}>{e.event_type}</td>
                    <td className="td whitespace-nowrap">
                      <RecordId>{e.subject_id}</RecordId>
                      {d.fixture === true && (
                        <span className="ml-2">
                          <Pill tone="degraded">test fixture</Pill>
                        </span>
                      )}
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
