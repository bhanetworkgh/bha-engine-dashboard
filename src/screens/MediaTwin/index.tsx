import { useState } from 'react';
import { useData } from '../../app/useData';
import { getMediaDoctrine, type DoctrineChange, type DoctrineData } from '../../data';
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
 * Media Twin's own output — posts, clips, the weekly platform report — is not
 * here yet, and the page does not pretend it is.
 */

const TABS = ['Doctrine'] as const;
type Tab = (typeof TABS)[number];

const when = (iso: string | null) => (iso ? iso.slice(0, 16).replace('T', ' ') : '—');
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : '—');
const maturityLabel = (m: string) => m.toLowerCase().replace(/_/g, ' ');

export default function MediaTwin() {
  const [tab, setTab] = useState<Tab>('Doctrine');
  useReplayKey(tab);
  const { status, data, error } = useData(getMediaDoctrine, [], { kinds: ['media_doctrine'] });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="Media Twin"
        subtitle="What vFarm may publicly claim, as Hardik's doctrine sets it"
        below={<Tabs tabs={TABS} value={tab} onChange={setTab} counts={{ Doctrine: data?.summary.doctrines_in_force ? { n: data.summary.doctrines_in_force } : undefined }} />}
      />
      {status === 'loading' && !data ? (
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
  const [open, setOpen] = useState<string | null>(null);
  const paged = usePaged(data.changes, 'all');
  return (
    <div className="scroll-thin flex min-h-0 flex-1 flex-col gap-4 overflow-x-hidden overflow-y-auto px-6 pb-6 md:px-8">
      <p className="text-[12px] text-dim">
        {data.meta.changes} change{data.meta.changes === 1 ? '' : 's'} held since {day(data.meta.first_change_at)} · last received{' '}
        {relativeTime(data.meta.last_received_at) ?? '—'}
      </p>
      <StatStrip cols={4}>
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
