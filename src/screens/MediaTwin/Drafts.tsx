import { useState } from 'react';
import type { TwinDraft, TwinDraftsData } from '../../data';
import { Card, CardHeader, EmptyState, FigureCell, Pill, StatStrip, relativeTime } from '../../components/ui';

/**
 * Drafts (2026-11-01, Destiny): everything the Media Twin wrote, newest first. Each draft shows
 * the card it went out with, the text for each platform, the claim check (with the sentence that
 * tripped it), Jason's Approve or Reject per platform with his note, and which revision it is.
 * A read. Decisions are made on the Slack card in #bha-media-twin; nothing posts from here.
 * Colour only where something is wrong: a blocked claim. Approved is the accent, never green.
 */

const PLATFORM_LABEL: Record<string, string> = { linkedin: 'LinkedIn', x: 'X', facebook: 'Facebook', instagram: 'Instagram' };
const STATUS_LABEL: Record<string, string> = { in_review: 'waiting on Jason', partly_decided: 'partly decided', approved: 'approved', rejected: 'rejected', superseded: 'replaced by a revision', draft: 'draft' };
const OCCASION_LABEL: Record<string, string> = { build_update: 'build update', new_month: 'new month', holiday: 'holiday', trend: 'trend', other: 'other' };
const when = (iso: string | null) => (iso ? iso.slice(0, 16).replace('T', ' ') : '—');

export function Drafts({ data }: { data: TwinDraftsData }) {
  const c = data.counts;
  if (!data.posts.length)
    return (
      <div className="px-6 pb-8 md:px-8">
        <EmptyState>
          No draft yet. The Media Twin writes one each morning at 6am New York time from yesterday's Codex logs, the Slack sweep and the news, and
          posts it to #bha-media-twin for Jason. Each one lands here the moment it is written.
        </EmptyState>
      </div>
    );
  return (
    <div className="scroll-thin flex min-h-0 flex-1 flex-col gap-4 overflow-x-hidden overflow-y-auto pb-6">
      <StatStrip cols={5}>
        <FigureCell label="Drafts" value={c.drafts} note="Every draft written, revisions included" />
        <FigureCell label="Waiting on Jason" value={c.waiting_on_decision} note="At least one platform not yet decided" />
        <FigureCell label="Approved" value={c.approved} note="Every platform approved" />
        <FigureCell label="Rejected" value={c.rejected} note="Every platform rejected" />
        <FigureCell label="Blocked claims" value={c.blocked} tone={c.blocked ? 'degraded' : undefined} note="Drafts carrying a claim that cannot be approved" />
      </StatStrip>
      <div className="flex flex-col gap-4 px-6 md:px-8">
        {data.posts.map((p) => (
          <DraftCard key={p.post_id} post={p} />
        ))}
        <ul className="list-disc pl-5 text-[12px] text-dim">
          {data.rules.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function DraftCard({ post }: { post: TwinDraft }) {
  const platforms = Object.keys(post.platforms);
  const [open, setOpen] = useState(platforms[0] ?? '');
  const d = post.platforms[open];
  const img = post.images.find((i) => i.platform === open) ?? post.images.find((i) => open === 'facebook' && i.platform === 'instagram') ?? post.images[0];
  return (
    <Card className="pb-4">
      <CardHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            <span>{post.card.headline?.replace(/\*/g, '') || post.post_id}</span>
            <Pill>{OCCASION_LABEL[post.occasion] ?? post.occasion}</Pill>
            {post.revision > 1 ? <Pill>revision {post.revision}</Pill> : null}
            <Pill tone={post.status === 'approved' ? 'accent' : 'default'}>{STATUS_LABEL[post.status] ?? post.status}</Pill>
            {post.claim_check_status === 'blocked' ? <Pill tone="failing">blocked claim</Pill> : post.claim_check_status === 'flagged' ? <Pill>flagged claim</Pill> : null}
            {post.test ? <Pill>test</Pill> : null}
          </span>
        }
        right={<span className="text-[12px] text-dim">{post.post_id} · {relativeTime(post.created_at) ?? when(post.created_at)}</span>}
      />
      <div className="grid gap-4 px-5 md:grid-cols-[220px_1fr]">
        <div>
          {img ? (
            <a href={img.url} target="_blank" rel="noreferrer">
              <img src={img.url} alt={`${PLATFORM_LABEL[open] ?? open} card`} className="w-full rounded-[10px] border border-line" />
            </a>
          ) : (
            <div className="rounded-[10px] border border-dashed border-line p-4 text-[12px] text-dim">No image rendered for this draft.</div>
          )}
          {post.angle ? <p className="mt-2 text-[12px] text-dim">Angle: {post.angle}</p> : null}
          {post.parent_post_id ? <p className="mt-1 text-[12px] text-dim">Rewrites {post.parent_post_id}</p> : null}
        </div>
        <div className="min-w-0">
          <div className="mb-2 flex flex-wrap gap-1">
            {platforms.map((k) => {
              const x = post.platforms[k];
              return (
                <button key={k} type="button" onClick={() => setOpen(k)} className={`tag ${open === k ? 'tag-accent' : ''}`}>
                  {PLATFORM_LABEL[k] ?? k} · {x.decision === 'pending' ? 'waiting' : x.decision}
                </button>
              );
            })}
          </div>
          {d ? (
            <div className="space-y-2 text-[13px]">
              <p className="whitespace-pre-wrap leading-relaxed">{d.text}</p>
              {d.thread.length ? (
                <ol className="list-decimal space-y-1 pl-5 text-dim">
                  {d.thread.map((t, i) => (
                    <li key={i} className="whitespace-pre-wrap">{t}</li>
                  ))}
                </ol>
              ) : null}
              <p className="text-[12px] text-dim">
                Claim check: {d.claim_check_status}
                {d.publish_at ? ` · would post ${d.publish_at} New York time` : ''}
              </p>
              {d.claim_findings.length ? (
                <ul className="list-disc pl-5 text-[12px] text-dim">
                  {d.claim_findings.map((f, i) => (
                    <li key={i}>
                      <span className={f.status === 'blocked' ? 'text-failing' : ''}>{f.status}</span>: “{f.text}” — {f.why}
                    </li>
                  ))}
                </ul>
              ) : null}
              {d.decision !== 'pending' ? (
                <p className="text-[12px]">
                  {d.decision === 'approved' ? 'Approved' : 'Rejected'} by {d.decided_by === 'U0A9V97949F' ? 'Jason' : d.decided_by === 'U0AEW3TBYH1' ? 'Destiny' : d.decided_by} {when(d.decided_at)}
                  {d.note ? ` — “${d.note}”` : ''}
                </p>
              ) : null}
            </div>
          ) : null}
          {post.decisions.length ? (
            <details className="mt-3 text-[12px] text-dim">
              <summary className="cursor-pointer">Every decision ({post.decisions.length})</summary>
              <ul className="mt-1 space-y-1">
                {post.decisions.map((x, i) => (
                  <li key={i}>
                    {when(x.at)} · {PLATFORM_LABEL[x.platform] ?? x.platform} · {x.decision} by {x.by_name}
                    {x.note ? ` — “${x.note}”` : ''}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      </div>
    </Card>
  );
}
