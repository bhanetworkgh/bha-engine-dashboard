/**
 * Announcing a pattern registered from a candidate in #bha-build-patterns
 * (2026-09-24, Destiny).
 *
 * One `chat.postMessage` as Bays (`SLACK_BAYS_BOT_TOKEN`), after the pattern is
 * saved. **The card is the extractor's own look** — `Pat Parse Pattern
 * Response`'s header, "From *builder*" line, bold name, divider and
 * "Pattern ID | System | Reusability" line — cut to what an announcement
 * needs: the one-line problem, who registered it (`<@Slack id>`), the Google
 * Doc and the pattern on the dashboard. The full pattern is a click away, so
 * the card never meets Slack's block limit the way the extractor's does.
 *
 * **A post that fails never undoes the registration.** It is reported beside
 * `doc_created` and `ingested_to_bharag` (red on the panel), logged to stdout,
 * and audited on `engine_mcp_writes` as tool `announce_pattern`, kind `slack`,
 * like every other Slack write this server makes. Success is read from Slack's
 * body: Slack refuses with HTTP 200 and `ok:false`.
 */
import * as slack from './slack';
import { auditOpen, auditClose } from './mcp/writeTools';

/** #bha-build-patterns, where `Pat Post to Build Patterns` posts. */
export const PATTERNS_CHANNEL = 'C0B0668PRNW';

export function dashboardBase(): string {
  return (process.env.PUBLIC_DASHBOARD_URL || 'https://dashboard.bhanetwork.org').replace(/\/+$/, '');
}

/** `Pat Parse Pattern Response`'s clean(). */
function clean(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/\r/g, '')
    .replace(/\t/g, ' ')
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, ' ')
    .trim();
}

/** Slack mrkdwn treats these three as markup; a pattern name is text. */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The problem's first sentence, never more than 300 characters. */
export function oneLine(problem: string): string {
  const flat = clean(problem).replace(/\s*\n+\s*/g, ' ');
  const first = /^(.+?[.!?])(\s|$)/.exec(flat)?.[1] ?? flat;
  return first.length > 300 ? first.slice(0, 299).trimEnd() + '…' : first;
}

export interface AnnounceInput {
  pattern_id: string;
  pattern_row_id: string | number;
  pattern_name: string;
  problem: string;
  bha_system: string;
  reusability: string;
  builder_name: string | null;
  registered_by_user_id: string;
  candidate_id: string | null;
  doc_link: string | null;
  /** Which door the Register came through, for the audit line: the page, or the MCP write connection (2026-09-25). */
  via?: 'page' | 'write';
}

export function card(a: AnnounceInput): { text: string; blocks: Record<string, unknown>[] } {
  const url = `${dashboardBase()}/build-patterns?open=${encodeURIComponent(`row-${a.pattern_row_id}`)}`;
  const problem = oneLine(a.problem);
  const links = [a.doc_link ? `<${a.doc_link}|Google Doc>` : null, `<${url}|Full pattern on the dashboard>`].filter(Boolean).join('   |   ');
  const blocks: Record<string, unknown>[] = [
    { type: 'header', text: { type: 'plain_text', text: '🔧 BHA Build Pattern', emoji: true } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `From *${esc(clean(a.builder_name) || 'unknown builder')}*` }] },
    { type: 'section', text: { type: 'mrkdwn', text: `*${esc(clean(a.pattern_name))}*` } },
    { type: 'divider' },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `*Pattern ID:* \`${clean(a.pattern_id)}\`   |   *System:* ${esc(clean(a.bha_system) || '—')}   |   *Reusability:* ${esc(clean(a.reusability) || '—')}` }],
    },
  ];
  if (problem) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '*Problem*' } });
    blocks.push({ type: 'rich_text', elements: [{ type: 'rich_text_list', style: 'bullet', indent: 0, elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: problem }] }] }] });
  }
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `Registered by <@${a.registered_by_user_id}>${a.candidate_id ? ` from candidate \`${clean(a.candidate_id)}\`` : ''}` }],
  });
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: links }] });
  return { text: `🔧 BHA Build Pattern: ${clean(a.pattern_name)} (${clean(a.pattern_id)})`, blocks };
}

export interface AnnounceResult {
  announced: boolean;
  channel: string;
  ts: string | null;
  permalink: string | null;
  error: string | null;
  audit_id: number | null;
}

export async function announce(a: AnnounceInput): Promise<AnnounceResult> {
  const base: AnnounceResult = { announced: false, channel: PATTERNS_CHANNEL, ts: null, permalink: null, error: null, audit_id: null };
  const { text, blocks } = card(a);
  let audit: number | null = null;
  try {
    audit = await auditOpen({ tool: 'announce_pattern', args: { channel: PATTERNS_CHANNEL, pattern_id: a.pattern_id, candidate_id: a.candidate_id }, access: a.via ?? 'page', kind: 'slack', requester: a.registered_by_user_id, dry_run: false });
  } catch (e) {
    // The pattern is already saved; an audit line that cannot be opened stops the post, not the registration.
    const error = `The announcement was not posted because its audit line could not be written: ${e instanceof Error ? e.message : String(e)}`;
    console.error(`announce_pattern ${a.pattern_id}: ${error}`);
    return { ...base, error };
  }
  const close = async (outcome: string, detail: string, after: Record<string, unknown>) => {
    try {
      await auditClose(audit!, { outcome, detail, natural_id: a.pattern_id, after });
    } catch (e) {
      console.error(`announce_pattern ${a.pattern_id}: audit close failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  if (!slack.slackConfigured()) {
    const error = `${slack.SLACK_TOKEN_VAR} is not set on this server, so the pattern was not announced in #bha-build-patterns.`;
    console.error(`announce_pattern ${a.pattern_id}: ${error}`);
    await close('failed', error, { ok: false });
    return { ...base, error, audit_id: audit };
  }
  const posted = await slack.botCall('chat.postMessage', { channel: PATTERNS_CHANNEL, text, blocks, unfurl_links: false, unfurl_media: false });
  if (!posted.ok) {
    const hint = posted.error === 'not_in_channel' ? ' — Bays is not a member of #bha-build-patterns.' : posted.error === 'invalid_blocks' ? ' — Slack rejected the card’s blocks.' : '';
    const error = `Slack refused the announcement: ${posted.error ?? `HTTP ${posted.http_status}`}${hint}`;
    console.error(`announce_pattern ${a.pattern_id}: ${error}`);
    await close('failed', error, { ok: false, error: posted.error ?? null });
    return { ...base, error, audit_id: audit };
  }
  const ts = typeof posted.ts === 'string' ? posted.ts : null;
  let permalink: string | null = null;
  if (ts) {
    const link = await slack.botCall('chat.getPermalink', { channel: PATTERNS_CHANNEL, message_ts: ts }, 'form');
    if (link.ok && typeof link.permalink === 'string') permalink = link.permalink;
  }
  await close('posted', `posted to ${PATTERNS_CHANNEL} at ${ts ?? '?'}`, { ok: true, ts, permalink });
  return { ...base, announced: true, ts, permalink, audit_id: audit };
}
