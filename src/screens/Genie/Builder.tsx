import { useState } from 'react';
import { useData } from '../../app/useData';
import { getGenieBuilder, type GenieBuilderFigures, type GenieBuilderInteraction } from '../../data';
import { EmptyState, FigureCell, LoadFailed, Loading, Pill, RecordId, Segmented, StatStrip } from '../../components/ui';

/**
 * Genie Builder (2026-11-09, Destiny — the Logstream side of the genie-slack-n8n rail). One row per
 * interaction Genie reports to POST /api/engine/genie-builder, each with its four stages, and the
 * figures the rev 5 proof is read from. Real use and forced tests are counted apart and the page
 * opens on real use: a test is never shown as Genie helping. Nothing is drawn before the first
 * interaction lands. Rules: server/src/genieBuilder.ts and docs/contracts/genie-builder-interactions.md.
 */

const STAGE: Record<string, string> = { queued: 'Queued', approval: 'Approved or denied', terminal: 'Finished, awaiting review', review: 'Reviewed' };
const when = (s: string | null) => (s ? s.replace('T', ' ').slice(0, 16) : '');

function Strip({ f }: { f: GenieBuilderFigures }) {
  return (
    <StatStrip cols={5}>
      <FigureCell label="Counted toward the proof" value={f.counted_toward_proof} caption={`of ${f.interactions} interactions`} note="Finished and reviewed with a 1 to 5 rating. Nothing else counts (rev 5, G2)." />
      <FigureCell label="Accepted" value={f.accepted} caption={`${f.modified} modified, ${f.rejected} rejected`} note="The builder's decision on what Genie and n8n produced, over the counted interactions." />
      <FigureCell label="Average rating" value={f.average_rating} unit="/ 5" missing="No rating yet" note="Mean usefulness rating over the counted interactions." />
      <FigureCell label="Awaiting review" value={f.awaiting_review} caption={`${f.feedback_failed} failed feedback`} tone={f.feedback_failed ? 'degraded' : undefined} note="Finished with no review yet. After 48 hours with none it is a failed feedback loop, never closed." />
      <FigureCell label="Live effect" value={f.live_effect} caption={`${f.self_approval_refused} self-approvals refused`} note="Finished with a publish or live edit that actually ran. Self-approvals are the two-builder gate refusing the requester." />
    </StatStrip>
  );
}

function Row({ r, open, onOpen }: { r: GenieBuilderInteraction; open: boolean; onOpen: () => void }) {
  return (
    <>
      <tr className="cursor-pointer border-b border-line align-top last:border-0 hover:bg-hover" onClick={onOpen}>
        <td className="tabular whitespace-nowrap px-4 py-2 text-dim">{when(r.queued_at ?? r.received_at)}</td>
        <td className="px-4 py-2">
          <RecordId>{r.interaction_id}</RecordId>
          {r.plan_summary && <div className="mt-0.5 max-w-[420px] text-[11.5px] leading-snug text-faint">{r.plan_summary}</div>}
        </td>
        <td className="px-4 py-2 text-ink">{r.intent ?? <span className="text-faint">not sent</span>}</td>
        <td className="px-4 py-2">{r.live_touching === null ? <span className="text-faint">not sent</span> : r.live_touching ? <Pill>live-touching</Pill> : 'no'}</td>
        <td className="px-4 py-2 text-ink">
          {r.approval_decision ? `${r.approval_decision}${r.two_builder_check ? `, ${r.two_builder_check.replace(/_/g, ' ')}` : ''}` : <span className="text-faint">none yet</span>}
        </td>
        <td className="px-4 py-2 text-ink">{STAGE[r.stage_reached]}{r.feedback_failed && <div className="text-[11.5px] text-degraded">failed feedback loop</div>}</td>
        <td className="px-4 py-2 text-ink">{r.builder_decision ? `${r.builder_decision}, ${r.usefulness_rating}/5` : <span className="text-faint">none yet</span>}</td>
        <td className="px-4 py-2"><Pill>{r.proof_type === 'test_forced' ? 'test' : 'real use'}</Pill></td>
      </tr>
      {open && (
        <tr className="border-b border-line bg-hover">
          <td colSpan={8} className="px-4 py-3 text-[12px] leading-relaxed text-dim">
            <div><span className="text-faint">Rail</span> {r.rail_id} · <span className="text-faint">Requester</span> {r.requester_id ?? 'not sent'} · <span className="text-faint">Approver</span> {r.approver_id ?? 'not sent'} ({r.approvals_required ?? '?'} required)</div>
            {r.live_touching_reason && <div><span className="text-faint">Live-touching because</span> {r.live_touching_reason}</div>}
            <div><span className="text-faint">Built</span> {r.backend_artifact_id ?? 'nothing yet'}{r.backend_artifact_version ? ` (${r.backend_artifact_version})` : ''} · <span className="text-faint">Status</span> {r.status ?? 'not finished'} · <span className="text-faint">Live effect</span> {r.live_effect === null ? 'not sent' : r.live_effect ? 'yes' : 'no'}</div>
            {r.error_or_stop_reason && <div><span className="text-faint">Stopped</span> {r.error_or_stop_reason}</div>}
            {r.review_note && <div><span className="text-faint">Review note</span> {r.review_note}</div>}
            {r.backend_debrief != null && <pre className="scroll-thin mt-2 max-h-[220px] overflow-auto whitespace-pre-wrap text-[11px]">{JSON.stringify(r.backend_debrief, null, 2)}</pre>}
          </td>
        </tr>
      )}
    </>
  );
}

export default function Builder() {
  const { status, data, error } = useData(getGenieBuilder, [], { kinds: ['genie_builder'] });
  const [view, setView] = useState<'live_natural' | 'test_forced'>('live_natural');
  const [open, setOpen] = useState<string | null>(null);
  if (status === 'loading' && !data) return <Loading />;
  if (status === 'error' && !data) return <LoadFailed error={error} />;
  if (!data) return <Loading />;
  if (data.held === 0) {
    return (
      <div className="px-6 pb-8 pt-4 md:px-8">
        <EmptyState>
          No Genie Builder interaction has arrived yet. Genie sends one message per stage (queued, approval, finished, builder review) to{' '}
          <code>/api/engine/genie-builder</code> once Kaiqi wires the genie-slack-n8n rail; the contract is docs/contracts/genie-builder-interactions.md. Each interaction
          appears here the moment it lands, and the proof figures are read from these rows.
        </EmptyState>
      </div>
    );
  }
  const rows = data.interactions.filter((r) => (view === 'test_forced' ? r.proof_type === 'test_forced' : r.proof_type !== 'test_forced'));
  return (
    <div className="scroll-thin min-h-0 flex-1 overflow-x-hidden overflow-y-auto pt-4">
      <div className="mb-3 flex items-center gap-3 px-6 md:px-8">
        <Segmented
          value={view}
          onChange={setView}
          ariaLabel="Real use or tests"
          options={[
            { value: 'live_natural' as const, label: 'Real use', count: data.summary.live_natural.interactions },
            { value: 'test_forced' as const, label: 'Tests', count: data.summary.test_forced.interactions },
          ]}
        />
        <span className="text-[12px] text-faint">Tests are never counted as Genie helping in real use.</span>
      </div>
      <Strip f={data.summary[view]} />
      <div className="px-6 pb-8 md:px-8">
        {rows.length === 0 ? (
          <EmptyState compact>{view === 'live_natural' ? 'No real-use interaction yet: every one held so far is a test.' : 'No test interaction held.'}</EmptyState>
        ) : (
          <div className="card overflow-x-auto">
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="border-b border-line text-left text-[11.5px] text-faint">
                  <th className="px-4 py-2 font-medium">queued</th>
                  <th className="px-4 py-2 font-medium">interaction</th>
                  <th className="px-4 py-2 font-medium">intent</th>
                  <th className="px-4 py-2 font-medium">live</th>
                  <th className="px-4 py-2 font-medium">approval</th>
                  <th className="px-4 py-2 font-medium">stage</th>
                  <th className="px-4 py-2 font-medium">builder review</th>
                  <th className="px-4 py-2 font-medium">proof</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <Row key={r.interaction_id} r={r} open={open === r.interaction_id} onOpen={() => setOpen(open === r.interaction_id ? null : r.interaction_id)} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
