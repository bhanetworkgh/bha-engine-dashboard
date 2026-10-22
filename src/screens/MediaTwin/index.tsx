import { useState } from 'react';
import { useData } from '../../app/useData';
import { getMediaDoctrine, getMediaPostLog, type DoctrineChange, type DoctrineData, type MediaPostLogData } from '../../data';
import {
  Card,
  CardHeader,
  EmptyState,
  FigureCell,
  LoadFailed,
  Loading,
  PageHeader,
  Pagination,
  Pill,
  RecordId,
  StatStrip,
  TableFrame,
  Tabs,
  Th,
  relativeTime,
  usePaged,
  useReplayKey,
} from '../../components/ui';

/**
 * Media Twin (2026-09-30, Destiny — HMJV's third section). Until then a
 * placeholder. Its first tab is **Doctrine**: the rules Hardik owns for what
 * vFarm's public surfaces may claim — B93H, TSNR, OWLG and any that follow —
 * as he posts each change to `POST /api/engine/media-doctrine`
 * (docs/contracts/media-doctrine.md). The page shows the version in force for
 * each doctrine and every change behind it, newest first.
 *
 * **Nothing here is coloured by maturity.** NOT_SAFE_TO_CLAIM is a rule doing
 * its job, not a fault, so it is drawn neutral like every other state; colour
 * is kept for a genuinely bad state, and a doctrine has none of those.
 *
 * Its second tab is **Posts** (2026-10-22, H58Q): the post log Jason asked for,
 * one row per post of one picture to one place, read from engine_media_post_log
 * (server/src/mediaPostLog.ts holds the rules). Clips and the weekly platform
 * report are not here yet, and the page does not pretend they are.
 */

const TABS = ['Doctrine', 'Posts'] as const;
type Tab = (typeof TABS)[number];

const when = (iso: string | null) => (iso ? iso.slice(0, 16).replace('T', ' ') : '—');
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : '—');
const maturityLabel = (m: string) => m.toLowerCase().replace(/_/g, ' ');

export default function MediaTwin() {
  const [tab, setTab] = useState<Tab>('Doctrine');
  useReplayKey(tab);
  const { status, data, error } = useData(getMediaDoctrine, [], { kinds: ['media_doctrine'] });
  const posts = useData(getMediaPostLog, [], { kinds: ['media_post_log'] });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="Media Twin"
        subtitle="What vFarm may publicly claim, as Hardik's doctrine sets it"
        below={<Tabs tabs={TABS} value={tab} onChange={setTab} counts={{ Doctrine: data?.summary.doctrines_in_force ? { n: data.summary.doctrines_in_force } : undefined, Posts: posts.data?.counts.rows ? { n: posts.data.counts.rows } : undefined }} />}
      />
      {tab === 'Posts' ? (
        posts.status === 'loading' && !posts.data ? (
          <Loading />
        ) : posts.status === 'error' && !posts.data ? (
          <LoadFailed error={posts.error} />
        ) : !posts.data ? (
          <Loading />
        ) : (
          <Posts data={posts.data} />
        )
      ) : status === 'loading' && !data ? (
        <Loading />
      ) : status === 'error' && !data ? (
        <LoadFailed error={error} />
      ) : !data ? (
        <Loading />
      ) : data.meta.changes === 0 ? (
        <div className="px-6 pb-8 md:px-8">
          <EmptyState>
            No doctrine change has arrived yet. Hardik posts one record each time a doctrine or contract he owns changes, to{' '}
            <code>/api/engine/media-doctrine</code> (the contract is docs/contracts/media-doctrine.md in this repo). The first one appears here the moment it
            lands — there is nothing to press.
          </EmptyState>
        </div>
      ) : (
        <Doctrine data={data} />
      )}
    </div>
  );
}

function Doctrine({ data }: { data: DoctrineData }) {
  const s = data.summary;
  const gate = data.resolved;
  const trace = data.publication_decisions;
  const held = trace.decisions.filter((d) => d.decision !== 'allowed' || !d.applicable);
  const [open, setOpen] = useState<string | null>(null);
  const paged = usePaged(data.changes, 'all');
  return (
    <div className="scroll-thin flex min-h-0 flex-1 flex-col gap-4 overflow-x-hidden overflow-y-auto px-6 pb-6 md:px-8">
      <p className="text-[12px] text-dim">
        {data.meta.changes} change{data.meta.changes === 1 ? '' : 's'} held since {day(data.meta.first_change_at)} · last received{' '}
        {relativeTime(data.meta.last_received_at) ?? '—'}
      </p>
      <Card className="pb-3">
        <CardHeader title="Publication gate" right={<span className="tabular text-[11.5px] text-faint">canonical T0NO resolver · {gate.schema}</span>} />
        <div className="px-4 pb-3 text-[12px] text-dim">
          {gate.claims.length === 0 ? (
            <p>NEEDS_EVIDENCE · no doctrine claim is in force. Do not render or publish.</p>
          ) : held.length ? (
            <p>
              HOLD · {held.length} of {trace.counts.claims} claim{trace.counts.claims === 1 ? '' : 's'} lack a current applicable publication decision.{' '}
              {held.slice(0, 3).map((d) => `${d.doctrine_id}:${d.claim_id}: ${d.reason}`).join(' · ')}
            </p>
          ) : (
            <p>ALLOWED · all {trace.counts.claims} resolved claim{trace.counts.claims === 1 ? '' : 's'} carry a current VFAM.claim_publication_decision for Media Twin.</p>
          )}
        </div>
      </Card>
      <StatStrip cols={4} flush>
        <FigureCell
          label="Doctrines in force"
          value={s.doctrines_in_force}
          caption={s.retired ? `${s.retired} retired, kept as history` : 'none retired'}
          note="One per doctrine id: its newest change is the version in force."
        />
        <FigureCell label="Changes, last 30 days" value={s.changes_last_30_days} caption={`of ${data.meta.changes} held`} note="Dated by when the change was made, not when it was posted." />
        <FigureCell label="Claims set" value={s.claims_in_force} caption="across the versions in force" note="Each claim carries the maturity the doctrine sets for it." />
        <FigureCell label="Contracts bound" value={s.contracts_bound.length} caption={s.contracts_bound.slice(0, 3).join(', ') || 'none named'} note="Every contract id the versions in force name." />
      </StatStrip>

      <Card className="pb-3">
        <CardHeader title="In force" right={<span className="tabular text-[11.5px] text-faint">the newest version of each doctrine</span>} />
        <TableFrame flat grow={false} label="Doctrines in force">
          <thead>
            <tr>
              <Th>doctrine</Th>
              <Th>version</Th>
              <Th>since</Th>
              <Th>approved by</Th>
              <Th>contracts</Th>
              <Th>default patterns</Th>
              <Th>claims</Th>
              <Th>changes</Th>
            </tr>
          </thead>
          <tbody>
            {data.doctrines.map((d) => (
              <tr key={d.doctrine_id}>
                <td className="td">
                  <span className="font-medium text-ink">{d.doctrine_id}</span>
                  {d.doctrine_name && <span className="text-dim"> · {d.doctrine_name}</span>}
                  {d.retired && (
                    <>
                      {' '}
                      <Pill>retired</Pill>
                    </>
                  )}
                </td>
                <td className="td tabular">{d.version}</td>
                <td className="td tabular whitespace-nowrap text-dim">{day(d.changed_at)}</td>
                <td className="td text-dim">{d.approved_by ?? '—'}</td>
                <td className="td td-clip text-dim" style={{ maxWidth: '28ch' }} title={d.contract_ids.join(', ')}>
                  {d.contract_ids.join(', ') || '—'}
                </td>
                <td className="td td-clip text-dim" style={{ maxWidth: '24ch' }} title={d.default_patterns.join(', ')}>
                  {d.default_patterns.join(', ') || '—'}
                </td>
                <td className="td tabular text-dim">{d.claims.length}</td>
                <td className="td tabular text-dim">{d.changes}</td>
              </tr>
            ))}
          </tbody>
        </TableFrame>
      </Card>

      <Card className="pb-3">
        <CardHeader title="Every change" right={<span className="tabular text-[11.5px] text-faint">newest first · click a row for the claims it sets</span>} />
        <TableFrame flat grow={false} label="Doctrine changes">
          <thead>
            <tr>
              <Th>when (UTC)</Th>
              <Th>doctrine</Th>
              <Th>version</Th>
              <Th>change</Th>
              <Th>what changed</Th>
              <Th>posted by</Th>
            </tr>
          </thead>
          <tbody>
            {paged.rows.map((c) => (
              <ChangeRow key={c.change_id} c={c} open={open === c.change_id} onToggle={() => setOpen(open === c.change_id ? null : c.change_id)} />
            ))}
          </tbody>
        </TableFrame>
      </Card>
      <Pagination paged={paged} unit="changes" />
    </div>
  );
}

function ChangeRow({ c, open, onToggle }: { c: DoctrineChange; open: boolean; onToggle: () => void }) {
  return (
    <>
      <tr className="cursor-pointer" onClick={onToggle}>
        <td className="td tabular whitespace-nowrap text-faint">{when(c.changed_at)}</td>
        <td className="td font-medium text-ink">{c.doctrine_id}</td>
        <td className="td tabular whitespace-nowrap">
          {c.previous_version ? (
            <span>
              <span className="text-faint">{c.previous_version} → </span>
              {c.version}
            </span>
          ) : (
            c.version
          )}
        </td>
        <td className="td">
          <Pill>{c.change_type}</Pill>
        </td>
        <td className="td td-clip" style={{ maxWidth: '52ch' }} title={c.summary}>
          {c.summary}
        </td>
        <td className="td text-dim">{c.posted_by ?? '—'}</td>
      </tr>
      {open && (
        <tr>
          <td className="td" colSpan={6}>
            <div className="space-y-3 py-1 text-[12.5px]">
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-faint">
                <span>
                  change <RecordId>{c.change_id}</RecordId>
                </span>
                {c.loop_id && (
                  <span>
                    loop <RecordId>{c.loop_id}</RecordId>
                  </span>
                )}
                <span>approved by {c.approved_by ?? 'not stated'}{c.approved_at ? ` on ${day(c.approved_at)}` : ''}</span>
                <span>received {when(c.received_at)} UTC</span>
                {c.doc_url && (
                  <a className="link" href={c.doc_url} target="_blank" rel="noreferrer">
                    the document ↗
                  </a>
                )}
              </div>
              <p className="whitespace-pre-wrap text-ink">{c.summary}</p>
              {(c.contract_ids.length > 0 || c.default_patterns.length > 0) && (
                <div className="flex flex-wrap gap-x-6 gap-y-1 text-[12px] text-dim">
                  {c.contract_ids.length > 0 && <span>Contracts: {c.contract_ids.join(', ')}</span>}
                  {c.default_patterns.length > 0 && <span>Default patterns: {c.default_patterns.join(', ')}</span>}
                </div>
              )}
              {c.claims.length === 0 ? (
                <p className="text-faint">This change sets no claim-level states.</p>
              ) : (
                <table className="w-full text-[12px]">
                  <thead>
                    <tr className="text-left text-[10.5px] text-faint">
                      <th className="pb-1 pr-3 font-medium">claim</th>
                      <th className="pb-1 pr-3 font-medium">maturity</th>
                      <th className="pb-1 pr-3 font-medium">may say</th>
                      <th className="pb-1 font-medium">may not say</th>
                    </tr>
                  </thead>
                  <tbody>
                    {c.claims.map((k, i) => (
                      <tr key={`${k.claim_id ?? k.label}-${i}`} className="align-top">
                        <td className="py-1 pr-3 text-ink">
                          {k.claim_id && <span className="tabular text-faint">{k.claim_id} </span>}
                          {k.label}
                        </td>
                        <td className="py-1 pr-3 whitespace-nowrap">
                          <Pill>{maturityLabel(k.maturity)}</Pill>
                        </td>
                        <td className="py-1 pr-3 text-dim">{k.allowed_wording ?? '—'}</td>
                        <td className="py-1 text-dim">{k.prohibited_wording ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function Posts({ data }: { data: MediaPostLogData }) {
  const c = data.counts;
  const paged = usePaged(data.rows, 'all');
  return (
    <div className="scroll-thin flex min-h-0 flex-1 flex-col gap-4 overflow-x-hidden overflow-y-auto px-6 pb-6 md:px-8">
      <p className="text-[12px] text-dim">
        One row per post of one vFarm picture to one place. Pictures come only from the{' '}
        <a className="link" href={data.approved_renders_folder.url} target="_blank" rel="noreferrer">
          Approved vFarm renders folder ↗
        </a>
        , the one place bhanetwork.org and /vfarm pull from.
      </p>
      <StatStrip cols={4} flush>
        <FigureCell label="Posts logged" value={c.rows} caption={c.test_rows ? `${c.test_rows} test row${c.test_rows === 1 ? '' : 's'} left out` : 'no test rows'} note="Every row a person or a pipeline logged, tests left out." />
        <FigureCell label="Published" value={c.published} caption={`of ${c.rows}`} note="Live on a platform, with the post's own link or id." />
        <FigureCell label="Queued" value={c.queued} caption={`of ${c.rows}`} note="Approved by Jason and waiting to go out by hand." />
        <FigureCell label="Awaiting approval" value={c.awaiting_approval} caption={`of ${c.rows}`} note="Jason has not decided on the picture yet." />
      </StatStrip>
      {data.rows.length === 0 ? (
        <EmptyState>
          No post has been logged yet. A post is logged through <code>write_media_post_log</code> or <code>POST /api/engine/media-post-log</code>, and only
          once Jason has approved its picture can it be queued or published. Nothing has gone out from here.
        </EmptyState>
      ) : (
        <>
          <Card className="pb-3">
            <CardHeader title="Every post" right={<span className="tabular text-[11.5px] text-faint">newest first</span>} />
            <TableFrame flat grow={false} label="Media Twin posts">
              <thead>
                <tr>
                  <Th>logged (UTC)</Th>
                  <Th>picture</Th>
                  <Th>platform</Th>
                  <Th>claim</Th>
                  <Th>approval</Th>
                  <Th>result</Th>
                  <Th>live post</Th>
                  <Th>read back</Th>
                </tr>
              </thead>
              <tbody>
                {paged.rows.map((r) => (
                  <tr key={r.log_id}>
                    <td className="td tabular whitespace-nowrap text-faint">{when(r.created_at)}</td>
                    <td className="td">
                      <span className="font-medium text-ink">{r.asset_id}</span> <span className="text-dim">{r.asset_version}</span>
                      {r.test && (
                        <>
                          {' '}
                          <Pill>test</Pill>
                        </>
                      )}
                      <div className="text-[11px] text-faint">
                        <RecordId>{r.log_id}</RecordId> · from {r.source_id}
                      </div>
                    </td>
                    <td className="td text-dim">{r.platform}</td>
                    <td className="td text-dim">
                      {r.classification.toLowerCase()} · {r.claim_state}
                    </td>
                    <td className="td">
                      <Pill>{r.approval === 'APPROVE_FOR_EA_PUBLICATION' ? 'approved' : r.approval.toLowerCase()}</Pill>
                    </td>
                    <td className="td">
                      <Pill>{r.publish_result.replace(/_/g, ' ')}</Pill>
                    </td>
                    <td className="td td-clip" style={{ maxWidth: '24ch' }}>
                      {r.target_url ? (
                        <a className="link" href={r.target_url} target="_blank" rel="noreferrer">
                          open ↗
                        </a>
                      ) : (
                        <span className="text-dim">{r.target_id ?? '—'}</span>
                      )}
                    </td>
                    <td className={`td ${r.read_back === 'error' ? 'text-failing' : 'text-dim'}`} title={r.read_back_detail ?? undefined}>
                      {r.read_back.replace(/_/g, ' ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </TableFrame>
          </Card>
          <Pagination paged={paged} unit="posts" />
        </>
      )}
      <Card className="pb-3">
        <CardHeader title="The rules every post is held to" right={<span className="tabular text-[11.5px] text-faint">{data.schema}</span>} />
        <ul className="list-disc space-y-1 px-8 pb-3 text-[12px] text-dim">
          {data.rules.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
