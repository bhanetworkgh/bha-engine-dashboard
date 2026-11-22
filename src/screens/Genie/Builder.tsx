import { useMemo, useState } from 'react';
import { useData } from '../../app/useData';
import { getGenieBuilder, type GenieBuilderFigures, type GenieBuilderInteraction } from '../../data';
import { EmptyState, FacetPicker, FigureCell, LoadFailed, Loading, Pagination, Pill, RecordId, SearchBox, Segmented, StatStrip, facetOptions, usePaged } from '../../components/ui';

/**
 * Genie Builder (2026-11-09, Destiny; widened 22 Nov 2026, Jason in #bha-coordination 1795291672.614769 and
 * 1795291916.233199). Every build is a row, with Genie or without: who asked, where (Slack, the web chat,
 * Claude Code), the tools Genie called, the reuse check (reused, extended, forked or built new, and why), what
 * was built, the builder's review, and whether it is marked production. A build done without Genie is its own
 * row with the reason. Real use and forced tests are counted apart and the page opens on real use: a test is
 * never shown as Genie helping. Rules: server/src/genieBuilder.ts and docs/contracts/genie-builder-interactions.md.
 */

const STAGE: Record<string, string> = {
  queued: 'Planned',
  approval: 'Approved or denied',
  terminal: 'Finished, awaiting review',
  review: 'Reviewed',
  not_used: 'Built without Genie',
  production: 'Marked production',
};
const SURFACE: Record<string, string> = { slack: 'Slack', web_chat: 'Web chat', claude_code: 'Claude Code', other: 'Other' };
const REUSE: Record<string, string> = { reused: 'reused', extended: 'extended', forked: 'forked', built_new: 'built new' };
const NOT_USED: Record<string, string> = { missing_tool: 'missing tool', trust: 'trust', too_slow: 'too slow', ux: 'hard to use', not_applicable: 'not applicable', other: 'other' };
const when = (s: string | null) => (s ? s.replace('T', ' ').slice(0, 16) : '');
const label = (m: unknown) => (typeof m === 'string' ? m : m && typeof m === 'object' ? String((m as Record<string, unknown>).id ?? (m as Record<string, unknown>).name ?? JSON.stringify(m)) : String(m));

function Strip({ f }: { f: GenieBuilderFigures }) {
  const reusedOrExtended = f.reuse.reused + f.reuse.extended + f.reuse.forked;
  return (
    <StatStrip cols={5}>
      <FigureCell label="Builds recorded" value={f.builds} caption={`${f.with_genie} with Genie, ${f.without_genie} without`} note="Every build is a row, done with Genie or without. A build done without Genie carries its reason." />
      <FigureCell label="Reused or extended" value={reusedOrExtended} caption={`${f.reuse.built_new} built new, ${f.no_reuse_check} with no check`} note="The reuse check logged before the build: an existing pattern, flow or build reused, extended or forked, against built new with a reason." />
      <FigureCell label="Counted toward the proof" value={f.counted_toward_proof} caption={`${f.accepted} accepted, ${f.modified} modified, ${f.rejected} rejected`} note="Genie builds that finished and were reviewed with a 1 to 5 rating. Nothing else counts (rev 5, G2)." />
      <FigureCell label="Average rating" value={f.average_rating} unit="/ 5" missing="No rating yet" note="Mean usefulness rating over the counted Genie builds." />
      <FigureCell label="Marked production" value={f.marked_production} caption={`${f.awaiting_review} awaiting review, ${f.feedback_failed} failed feedback`} tone={f.feedback_failed ? 'degraded' : undefined} note="Marked only once the reuse check is logged and the build was reviewed accepted or modified, or Genie was not used and the reason is recorded." />
    </StatStrip>
  );
}

function Detail({ r }: { r: GenieBuilderInteraction }) {
  const reuse = r.reuse_check;
  return (
    <div className="space-y-1">
      <div>
        <span className="text-faint">Rail</span> {r.rail_id} · <span className="text-faint">Asked by</span> {r.requester_id ?? 'not sent'}
        {r.used_genie && (
          <>
            {' '}· <span className="text-faint">Approver</span> {r.approver_id ?? 'not sent'} ({r.approvals_required ?? '?'} required)
          </>
        )}
      </div>
      {r.build_ref && <div><span className="text-faint">Built</span> {r.build_ref}</div>}
      {r.plan_summary && <div><span className="text-faint">{r.used_genie ? 'Plan' : 'What was built'}</span> {r.plan_summary}</div>}
      {!r.used_genie && (
        <div>
          <span className="text-faint">Genie not used because</span> {r.not_used_category ? `${NOT_USED[r.not_used_category] ?? r.not_used_category}: ` : ''}
          {r.not_used_reason}
        </div>
      )}
      {reuse ? (
        <div>
          <span className="text-faint">Reuse check</span> {REUSE[reuse.result] ?? reuse.result}
          {reuse.matches?.length ? `: ${reuse.matches.map(label).join(', ')}` : ''}
          {reuse.justification ? `. ${reuse.justification}` : ''}
        </div>
      ) : (
        <div className="text-degraded">No reuse check logged.</div>
      )}
      {r.tools_invoked?.length ? <div><span className="text-faint">Tools Genie called</span> {r.tools_invoked.join(', ')}</div> : null}
      {r.live_touching_reason && <div><span className="text-faint">Live-touching because</span> {r.live_touching_reason}</div>}
      {r.used_genie && (
        <div>
          <span className="text-faint">Artifact</span> {r.backend_artifact_id ?? 'nothing yet'}
          {r.backend_artifact_version ? ` (${r.backend_artifact_version})` : ''} · <span className="text-faint">Status</span> {r.status ?? 'not finished'} ·{' '}
          <span className="text-faint">Live effect</span> {r.live_effect === null ? 'not sent' : r.live_effect ? 'yes' : 'no'}
        </div>
      )}
      {r.error_or_stop_reason && <div><span className="text-faint">Stopped</span> {r.error_or_stop_reason}</div>}
      {r.review_note && <div><span className="text-faint">Review note</span> {r.review_note}</div>}
      {r.production_marked_at ? (
        <div><span className="text-faint">Marked production</span> {when(r.production_marked_at)} by {r.production_marked_by}</div>
      ) : r.production_blockers.length ? (
        <div><span className="text-faint">Not ready for production:</span> {r.production_blockers.join('; ')}.</div>
      ) : (
        <div><span className="text-faint">Ready to be marked production.</span></div>
      )}
      {r.backend_debrief != null && <pre className="scroll-thin mt-2 max-h-[220px] overflow-auto whitespace-pre-wrap text-[11px]">{JSON.stringify(r.backend_debrief, null, 2)}</pre>}
    </div>
  );
}

function Row({ r, open, onOpen }: { r: GenieBuilderInteraction; open: boolean; onOpen: () => void }) {
  return (
    <>
      <tr className="cursor-pointer border-b border-line align-top last:border-0 hover:bg-hover" onClick={onOpen}>
        <td className="tabular whitespace-nowrap px-4 py-2 text-dim">{when(r.queued_at ?? r.received_at)}</td>
        <td className="px-4 py-2">
          <RecordId>{r.interaction_id}</RecordId>
          {(r.build_ref || r.plan_summary) && <div className="mt-0.5 max-w-[380px] truncate text-[11.5px] leading-snug text-faint">{r.build_ref ?? r.plan_summary}</div>}
        </td>
        <td className="px-4 py-2 text-ink">{r.surface ? SURFACE[r.surface] ?? r.surface : <span className="text-faint">not sent</span>}</td>
        <td className="px-4 py-2 text-ink">{r.used_genie ? 'yes' : <span>no{r.not_used_category ? <div className="text-[11.5px] text-faint">{NOT_USED[r.not_used_category] ?? r.not_used_category}</div> : null}</span>}</td>
        <td className="px-4 py-2 text-ink">{r.reuse_result ? REUSE[r.reuse_result] ?? r.reuse_result : <span className="text-degraded">no check</span>}</td>
        <td className="px-4 py-2 text-ink">
          {STAGE[r.stage_reached]}
          {r.feedback_failed && <div className="text-[11.5px] text-degraded">failed feedback loop</div>}
        </td>
        <td className="px-4 py-2 text-ink">{r.builder_decision ? `${r.builder_decision}, ${r.usefulness_rating}/5` : <span className="text-faint">{r.used_genie ? 'none yet' : 'n/a'}</span>}</td>
        <td className="px-4 py-2"><Pill>{r.proof_type === 'test_forced' ? 'test' : 'real use'}</Pill></td>
      </tr>
      {open && (
        <tr className="border-b border-line bg-hover">
          <td colSpan={8} className="px-4 py-3 text-[12px] leading-relaxed text-dim">
            <Detail r={r} />
          </td>
        </tr>
      )}
    </>
  );
}

export default function Builder() {
  const { status, data, error } = useData(getGenieBuilder, [], { kinds: ['genie_builder'] });
  const [view, setView] = useState<'live_natural' | 'test_forced'>('live_natural');
  const [surface, setSurface] = useState<string | null>(null);
  const [genie, setGenie] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const inView = useMemo(() => (data?.interactions ?? []).filter((r) => (view === 'test_forced' ? r.proof_type === 'test_forced' : r.proof_type !== 'test_forced')), [data, view]);
  const surfaceOf = (r: GenieBuilderInteraction) => (r.surface ? SURFACE[r.surface] ?? r.surface : null);
  const genieOf = (r: GenieBuilderInteraction) => (r.used_genie ? 'With Genie' : 'Without Genie');
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return inView.filter(
      (r) =>
        (!surface || surfaceOf(r) === surface) &&
        (!genie || genieOf(r) === genie) &&
        (!needle || [r.interaction_id, r.plan_summary, r.build_ref, r.not_used_reason, JSON.stringify(r.reuse_check ?? '')].join(' ').toLowerCase().includes(needle)),
    );
  }, [inView, surface, genie, q]);
  const paged = usePaged(rows, `${view}|${surface}|${genie}|${q}`);
  if (status === 'loading' && !data) return <Loading />;
  if (status === 'error' && !data) return <LoadFailed error={error} />;
  if (!data) return <Loading />;
  if (data.held === 0) {
    return (
      <div className="px-6 pb-8 pt-4 md:px-8">
        <EmptyState>
          No build has been recorded yet. Each build lands here as Genie, or the builder who did it without Genie, records it: with the dashboard tool record_genie_build, or
          one message per stage to <code>/api/engine/genie-builder</code>. The contract is docs/contracts/genie-builder-interactions.md.
        </EmptyState>
      </div>
    );
  }
  return (
    <div className="scroll-thin min-h-0 flex-1 overflow-x-hidden overflow-y-auto pt-4">
      <div className="mb-3 flex flex-wrap items-center gap-3 px-6 md:px-8">
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
      <div className="mb-3 flex flex-wrap items-center gap-3 px-6 md:px-8">
        <FacetPicker label="Where" allLabel={`Everywhere (${inView.length})`} value={surface} options={facetOptions(inView, surfaceOf, 'Not sent')} onChange={setSurface} />
        <FacetPicker label="Genie" allLabel={`With or without Genie (${inView.length})`} value={genie} options={facetOptions(inView, genieOf, '')} onChange={setGenie} />
        <div className="min-w-[220px] flex-1">
          <SearchBox value={q} onChange={setQ} placeholder="Search builds, reasons and reuse checks" />
        </div>
      </div>
      <div className="px-6 pb-4 md:px-8">
        {rows.length === 0 ? (
          <EmptyState compact>
            {inView.length === 0 ? (view === 'live_natural' ? 'No real-use build yet: every one held so far is a test.' : 'No test build held.') : 'No build matches these filters.'}
          </EmptyState>
        ) : (
          <div className="card overflow-x-auto">
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="border-b border-line text-left text-[11.5px] text-faint">
                  <th className="px-4 py-2 font-medium">when</th>
                  <th className="px-4 py-2 font-medium">build</th>
                  <th className="px-4 py-2 font-medium">where</th>
                  <th className="px-4 py-2 font-medium">genie</th>
                  <th className="px-4 py-2 font-medium">reuse</th>
                  <th className="px-4 py-2 font-medium">stage</th>
                  <th className="px-4 py-2 font-medium">builder review</th>
                  <th className="px-4 py-2 font-medium">proof</th>
                </tr>
              </thead>
              <tbody>
                {paged.rows.map((r) => (
                  <Row key={r.interaction_id} r={r} open={open === r.interaction_id} onOpen={() => setOpen(open === r.interaction_id ? null : r.interaction_id)} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <Pagination paged={paged} unit="builds" />
    </div>
  );
}
