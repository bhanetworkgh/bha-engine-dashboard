/**
 * The Media Twin weekly readiness report (9 Nov 2026, Destiny; Jason's ask of 7 Nov, #bha-coordination
 * 1793995604.721569): at the end of the approver-of-record week, a short readiness summary logged in the Codex that
 * answers his three questions in his order, with the platforms' numbers beside it.
 *
 * Two doors, both behind x-dashboard-key, both called by n8n's `Media Twin — Weekly Readiness`:
 *   - `facts({from, to})`: everything the week holds, counted here and never estimated: each day's final draft and how
 *     each platform got out (as generated, rewritten after a reject, edited by hand, not posted), every reject note,
 *     hand edit, failed auto-post and claim-check finding, the automatic checks the claim check already runs, each live
 *     post's latest numbers, and followers at the start and end of the week. Question 1 is answered from these counts;
 *     questions 2 and 3 are written by the Media Twin agent from the notes listed here.
 *   - `log(body)`: the report becomes a Codex log under Destiny's name, Session Type Media, `Log Kind: Report` (a new
 *     field name). Destiny, 9 Nov: it goes straight in, not for review and not into pay. A report row has its own stage
 *     ("Reports" on the Codex page), never Awaiting approval, and paySync skips it. Keyed on its Submission ID
 *     (`MTWR-<to>`), so a repeat updates the same log rather than making a second. Then it is sent to BHARAG.
 */
import { query } from './pg';
import * as mediaPosts from './mediaPosts';
import * as engineWrite from './engineWrite';
import * as mirror from './mirror';
import * as bharag from './bharag';
import { FeedError } from './systemFeeds';

export const DESTINY = 'U0AEW3TBYH1';
export const REPORT_KIND = 'Report';
const PLATFORMS = ['x', 'facebook', 'instagram', 'linkedin'] as const;
type P = (typeof PLATFORMS)[number];
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const dashboardUrl = (): string => (process.env.PUBLIC_DASHBOARD_URL || 'https://dashboard.bhanetwork.org').replace(/\/+$/, '');

function range(b: Record<string, unknown>): { from: string; to: string } {
  const from = String(b.from ?? '').trim();
  const to = String(b.to ?? '').trim();
  if (!DAY.test(from) || !DAY.test(to)) throw new FeedError(422, 'from and to are required, as YYYY-MM-DD.');
  if (from > to) throw new FeedError(422, 'from is after to.');
  return { from, to };
}

/** What the automatic claim check already runs on every draft, by name, so question 3 can say which checks exist. */
export function automaticChecks(): { id: string; what: string }[] {
  return [
    ...mediaPosts.BLOCKED.map((b) => ({ id: b.id, what: `Blocked: ${b.why}` })),
    ...mediaPosts.FLAGGED.map((f) => ({ id: f.id, what: `Flagged for Jason: ${f.why}` })),
    { id: 'reliability_target', what: 'Target: a reliability claim stated as today’s behaviour cannot be approved until the Stage 1 gate has evidence; framed as what we are building or testing, it passes.' },
    { id: 'failure_story_needs_record', what: 'A failure story (failed, broke, acting up, missed it) needs a loop or Codex id in the draft’s sources.' },
    { id: 'performance_number', what: 'Flagged for Jason: a number about how the farm performs or what it earns.' },
    { id: 'x_length', what: 'X: a tweet over 280 characters is refused on a hand edit.' },
  ];
}

type Draft = Awaited<ReturnType<typeof mediaPosts.read>>['posts'][number];

export async function facts(b: Record<string, unknown>) {
  const { from, to } = range(b);
  const all = (await mediaPosts.read({ limit: 500 })).posts;
  const inWeek = all.filter((p) => !p.test && String(p.run_date).slice(0, 10) >= from && String(p.run_date).slice(0, 10) <= to);
  const byId = new Map(inWeek.map((p) => [p.post_id, p] as const));
  const finals = inWeek.filter((p) => p.status !== 'superseded');

  const ids = inWeek.map((p) => p.post_id);
  const failures = ids.length
    ? (
        await query<{ subject_id: string; at: Date; platform: string | null; error: string | null }>(
          `SELECT subject_id, at, detail->>'platform' AS platform, detail->>'error' AS error FROM engine_events
            WHERE event_type = 'media_post_auto_failed' AND subject_id = ANY($1) ORDER BY at`,
          [ids],
        )
      ).rows.map((r) => ({ post_id: r.subject_id, platform: r.platform, at: r.at.toISOString(), error: r.error }))
    : [];

  const rejects: { post_id: string; revision: number; platform: string; note: string | null; at: string | null }[] = [];
  const edits: { post_id: string; platform: string; reason: string; at: string }[] = [];
  const findings: { post_id: string; platform: string; status: string; rule: string; text: string }[] = [];
  for (const p of inWeek) {
    for (const k of PLATFORMS) {
      const x = p.platforms?.[k];
      if (!x) continue;
      if (x.decision === 'rejected') rejects.push({ post_id: p.post_id, revision: p.revision, platform: k, note: x.note ?? null, at: x.decided_at ?? null });
      for (const e of x.edits ?? []) edits.push({ post_id: p.post_id, platform: k, reason: e.reason, at: e.at });
      for (const f of x.claim_findings ?? []) findings.push({ post_id: p.post_id, platform: k, status: f.status, rule: f.rule, text: f.text });
    }
  }

  const rootOf = (p: Draft): Draft => {
    let cur = p;
    while (cur.parent_post_id && byId.has(cur.parent_post_id)) cur = byId.get(cur.parent_post_id)!;
    return cur;
  };

  const days = finals.map((p) => {
    const chain: Draft[] = [];
    let cur: Draft | undefined = p;
    while (cur) {
      chain.unshift(cur);
      cur = cur.parent_post_id ? byId.get(cur.parent_post_id) : undefined;
    }
    const platforms = Object.fromEntries(
      PLATFORMS.map((k) => {
        const x = p.platforms?.[k];
        const rejected = chain.slice(0, -1).some((d) => d.platforms?.[k]?.decision === 'rejected');
        const edited = (x?.edits ?? []).length > 0;
        const failed = failures.some((f) => f.post_id === p.post_id && f.platform === k);
        const outcome = !x || x.decision !== 'approved' ? 'not_approved' : !x.posted_url ? 'approved_not_posted' : edited ? 'edited' : rejected ? 'rewritten' : 'as_generated';
        return [k, { outcome, posted_url: x?.posted_url ?? null, posted_at: x?.posted_at ?? null, decided_at: x?.decided_at ?? null, auto_post_failed_first: failed, metrics: (p.metrics ?? []).find((m) => (m as { platform?: string }).platform === k) ?? null }];
      }),
    );
    return { run_date: String(p.run_date).slice(0, 10), post_id: p.post_id, first_draft: rootOf(p).post_id, revision: p.revision, headline: String((p.card as { headline?: string })?.headline ?? '').replace(/\*/g, ''), status: p.status, platforms };
  });

  const counts = Object.fromEntries(
    PLATFORMS.map((k) => {
      const c = { days: days.length, as_generated: 0, rewritten: 0, edited: 0, approved_not_posted: 0, not_approved: 0, auto_post_failed_first: 0 };
      for (const d of days) {
        const x = (d.platforms as Record<P, { outcome: keyof typeof c; auto_post_failed_first: boolean }>)[k];
        c[x.outcome] += 1;
        if (x.auto_post_failed_first) c.auto_post_failed_first += 1;
      }
      return [k, c];
    }),
  );

  const totals = Object.fromEntries(
    PLATFORMS.map((k) => {
      const t: Record<string, number | null> = { impressions: null, reach: null, likes: null, comments: null, shares: null, saves: null, clicks: null };
      let posts = 0;
      for (const d of days) {
        const m = (d.platforms as Record<P, { metrics: Record<string, unknown> | null }>)[k].metrics;
        if (!m) continue;
        posts += 1;
        for (const key of Object.keys(t)) {
          const v = m[key];
          if (typeof v === 'number') t[key] = (t[key] ?? 0) + v;
        }
      }
      return [k, { posts_with_numbers: posts, ...t }];
    }),
  );

  const acct = (
    await query<{ platform: string; first_at: Date; first: number | null; last_at: Date; last: number | null }>(
      `SELECT subject_id AS platform,
              (array_agg(at ORDER BY at))[1] AS first_at, (array_agg((detail->>'followers')::int ORDER BY at))[1] AS first,
              (array_agg(at ORDER BY at DESC))[1] AS last_at, (array_agg((detail->>'followers')::int ORDER BY at DESC))[1] AS last
         FROM engine_events
        WHERE event_type = 'media_account_metrics' AND at >= $1::date AND at < ($2::date + 2)
        GROUP BY subject_id`,
      [from, to],
    )
  ).rows;
  const followers = Object.fromEntries(
    PLATFORMS.map((k) => {
      const a = acct.find((r) => r.platform === k);
      return [k, a ? { start: a.first, start_at: a.first_at.toISOString(), end: a.last, end_at: a.last_at.toISOString() } : null];
    }),
  );

  return {
    // A read: counted as unchanged on engine_writes, never as an insert.
    inserted: 0,
    updated: 0,
    unchanged: 1,
    schema: 'media.weekly.facts.v1',
    from,
    to,
    days,
    counts,
    rejects,
    edits,
    auto_post_failures: failures,
    claim_findings: findings,
    automatic_checks: automaticChecks(),
    metrics: { totals, followers, note: 'Latest read per live post; LinkedIn is not read until its API access is approved. A null is not recorded, never zero.' },
  };
}

/** The report as a Codex log under Destiny's name, straight in: its own Reports stage, no review and no pay. */
export async function log(b: Record<string, unknown>) {
  const { from, to } = range(b);
  const text = String(b.summary_text ?? '').trim();
  if (text.length < 40) throw new FeedError(422, 'summary_text is required: the report as it should read in the Codex.');
  const dry = b.dry_run === true;
  const submission = `MTWR-${to}`;
  const entry = `CODEX-${to.replace(/-/g, '')}-destiny-arupi-media-twin-readiness`;
  const now = new Date().toISOString();
  const description = `Media Twin weekly readiness, ${from} to ${to}`;
  const fields: Record<string, unknown> = {
    'Submission ID': submission,
    'Codex Entry ID': entry,
    'Builder Name': 'Destiny Arupi',
    'Builder User ID': DESTINY,
    Timestamp: now,
    'Session Type': 'Media',
    'Log Kind': REPORT_KIND,
    'Session Description': description,
    Summary: text,
    'Orchestrator Layer2 Review': text,
    'Pillar Tags': 'media, media-twin',
    'Submission Source': 'Media Twin',
    'Processed At': now,
    'Report Week From': from,
    'Report Week To': to,
  };
  const url = `${dashboardUrl()}/codex/${encodeURIComponent(entry)}`;
  if (dry) return { ok: true, dry_run: true, written: false, codex_entry_id: entry, submission_id: submission, url, fields };

  const written = await engineWrite.postRecord('codex', { fields, builder_id: 'destiny' } as mirror.MirrorInput, { endpoint: '/api/engine/media-weekly/log', method: 'POST', key_label: 'DASHBOARD_INBOUND_KEY', note: 'Media Twin weekly readiness report' });
  if (!written.ok) throw new FeedError(422, `The Codex log was not written: ${JSON.stringify(written).slice(0, 300)}`);

  const r = await bharag.ingest(
    'codex',
    {
      title: `BHA Codex — Destiny Arupi — ${now}`,
      content: ['CODEX', `Codex Entry ID: ${entry}`, `Timestamp: ${now}`, 'Builder: Destiny Arupi', 'Source: Media Twin weekly readiness report', 'Flag: Internal/Private Log', '', text].join('\n'),
      source_type: 'manual',
      content_type: 'doc',
      project_tags: ['media', 'media-twin', 'readiness'],
      metadata: { codex_entry_id: entry, builder_name: 'Destiny Arupi', session_timestamp: now, submission_source: 'Media Twin', log_kind: REPORT_KIND, week_from: from, week_to: to },
    },
    { kind: 'record', source: 'media-weekly:log' },
  );
  return { ok: true, written: true, row_id: written.id, codex_entry_id: entry, submission_id: submission, url, ingested_to_bharag: r.ok, bharag: r.detail };
}
