/**
 * `read_outside_digest` (14 Nov 2026, Destiny — D4, BHA RSS). Read only, both connections, and in Bays',
 * North Star's, Research Twin's, Genie's and Media Twin's scopes: the daily digest of what came in from outside
 * (news feeds, YouTube, LinkedIn, web pages), written by BHA RSS. Each section is for one reader: post ideas
 * for Media Twin, questions for Research Twin, priority signals for North Star, context for Genie.
 * The raw items stay in BHA RSS's Supabase tables and are never served here.
 */
import * as outside from '../outsideDigest';
import * as mirror from '../mirror';
import type { ToolDefinition } from './tools';
import * as sources from '../outsideSources';
import * as rssReports from '../rssReports';
import { auditClose, auditOpen } from './writeTools';


export const readOutsideDigest: ToolDefinition = {
  name: 'read_outside_digest',
  description:
    "The daily outside digest from BHA RSS: what moved yesterday in the outside sources BHA follows (news and blog feeds, about 150 YouTube channels, LinkedIn profiles, web pages), compiled once a day. Sections: What moved outside; Post ideas for the Media Twin; Questions for Research Twin; Signals for North Star; Context for Genie. Every point carries the link of the item it came from: cite that link, never the digest alone, and never state anything the digest does not say. No arguments: the newest digest. date (YYYY-MM-DD) for one day; days (up to 14) for the newest few. An empty answer means no digest has been received yet, not that nothing happened outside. Read only.",
  inputSchema: {
    type: 'object',
    properties: {
      date: { type: 'string', description: 'One day, YYYY-MM-DD (the day the digest covers).' },
      days: { type: 'number', description: 'How many of the newest digests, 1 to 14. Default 1.' },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, title: 'Read the daily outside digest' },
  handler: async (args, deps) => {
    const t0 = Date.now();
    const date = typeof args.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(args.date.trim()) ? args.date.trim() : undefined;
    const days = typeof args.days === 'number' ? args.days : undefined;
    const r = await outside.read({ date, days });
    await mirror.logWrite({ endpoint: 'mcp:read_outside_digest', kind: 'outside_digests', method: 'MCP', key_label: deps.access === 'write' ? 'MCP_WRITE_TOKEN' : 'MCP_SECRET', outcome: 'read', detail: `${date || `newest ${days ?? 1}`} → ${r.digests.length} digest(s)`, ms: Date.now() - t0 });
    if (!r.digests.length) {
      return {
        ok: true,
        digests: [],
        held: r.held,
        newest: r.newest,
        message: date ? `No outside digest for ${date}. Newest held: ${r.newest ?? 'none yet'}.` : 'No outside digest has been received yet.',
      };
    }
    return {
      ok: true,
      held: r.held,
      newest: r.newest,
      digests: r.digests.map((d) => ({
        digest_date: d.digest_date,
        title: d.title,
        body: d.body,
        items_used: d.items_used,
        sources_used: d.sources_used,
        in_bharag: Boolean(d.bharag_doc_id),
        cost: d.cost ?? null,
        received_at: d.received_at,
      })),
      rule: 'Cite the item links inside the digest. Raw items are not served here; the digest is the only outside read.',
    };
  },
};

export const OUTSIDE_READ_TOOLS: ToolDefinition[] = [readOutsideDigest];

/**
 * `read_outside_sources` and `decide_rss_candidate` (19 Nov 2026, Destiny — Genie rebuild 8.8, outsideSources.ts).
 * The first is a read, both connections. The second is on the write connection, in no agent's scope, Destiny or
 * Jason only: a candidate source joins BHA RSS's list only once a person approves it with its feed address.
 */

export const readOutsideSources: ToolDefinition = {
  name: 'read_outside_sources',
  description:
    "BHA RSS's outside sources with their score from real use (cited in a digest, then used by Media Twin, Research Twin, North Star or Genie), how often each is read, every change to the list with its reason, and the candidate sources waiting on a person. Read only.",
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, title: 'Read the outside sources and their scores' },
  handler: async (_args, deps) => {
    const t0 = Date.now();
    const r = await sources.page();
    await mirror.logWrite({ endpoint: 'mcp:read_outside_sources', kind: 'outside_sources', method: 'MCP', key_label: deps.access === 'write' ? 'MCP_WRITE_TOKEN' : 'MCP_SECRET', outcome: 'read', detail: `${(r.sources as unknown[]).length} sources`, ms: Date.now() - t0 });
    return { ok: true, ...r };
  },
};

export const decideRssCandidate: ToolDefinition = {
  name: 'decide_rss_candidate',
  description:
    "Approves or declines a candidate outside source BHA RSS proposed. Destiny or Jason only (decided_by, a Slack id); refused on any agent token. approve needs kind (rss, youtube, linkedin or web) and feed_url (the https address BHA RSS reads); it joins the list on BHA RSS's next daily tune pass. decline needs a reason and is never proposed again. dry_run checks and writes nothing.",
  inputSchema: {
    type: 'object',
    properties: {
      candidate_id: { type: 'string', description: 'RSCAND-… id, from read_outside_sources.' },
      decision: { type: 'string', enum: ['approve', 'decline'] },
      decided_by: { type: 'string', description: "Destiny's or Jason's Slack id." },
      kind: { type: 'string', enum: ['rss', 'youtube', 'linkedin', 'web'] },
      feed_url: { type: 'string', description: 'The https address BHA RSS should read.' },
      name: { type: 'string', description: 'A display name for the source.' },
      reason: { type: 'string', description: 'Why; required to decline.' },
      dry_run: { type: 'boolean' },
    },
    required: ['candidate_id', 'decision', 'decided_by'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false, title: 'Decide a candidate outside source' },
  handler: async (args, deps) => {
    if (deps.agent) return { ok: false, reason: 'not_permitted', message: 'A person decides candidate sources; this is refused on an agent token.' };
    const audit = await auditOpen({ tool: 'decide_rss_candidate', args, access: deps.access, kind: 'outside_sources', requester: typeof args.decided_by === 'string' ? args.decided_by : null, dry_run: args.dry_run === true });
    try {
      const r = await sources.decideCandidate(args);
      await auditClose(audit, { outcome: args.dry_run === true ? 'dry_run' : 'updated', detail: `${String(args.decision)} ${String(args.candidate_id)}`, natural_id: String(args.candidate_id) });
      return { ...r, audit_id: audit };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const refused = e instanceof sources.SourcesError;
      await auditClose(audit, { outcome: refused ? 'refused' : 'failed', detail: message });
      return { ok: false, reason: refused ? (e.status === 403 ? 'not_permitted' : 'refused') : 'error', message, audit_id: audit, ...(refused ? {} : { raise: true }) };
    }
  },
};

export const OUTSIDE_SOURCE_READ_TOOLS: ToolDefinition[] = [readOutsideSources];
/**
 * `repost_outside_digest` (20 Nov 2026, Destiny): rssReports.repostDigest over MCP, the handler behind
 * POST /api/engine/outside-digest/post, so a held digest's card can be posted again or rewritten in place
 * (update_ts) without a manual call. Write connection, no agent's scope.
 */
export const repostOutsideDigest: ToolDefinition = {
  name: 'repost_outside_digest',
  description:
    "Posts a held outside digest's card again in #bha-engine-digests as Genie, in the current card layout (cost line included), or rewrites an existing card in place with update_ts. digest_date (YYYY-MM-DD, default the newest held); confirm exactly \"REPOST <digest_date>\"; update_ts the card's ts to rewrite instead of posting a new one; dry_run says what it would do. Refused on any agent token.",
  inputSchema: {
    type: 'object',
    properties: {
      digest_date: { type: 'string' },
      confirm: { type: 'string' },
      update_ts: { type: 'string' },
      requester_user_id: { type: 'string' },
      dry_run: { type: 'boolean' },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true, title: 'Post an outside digest card again' },
  handler: async (args, deps) => {
    if (deps.agent) return { ok: false, reason: 'not_permitted', message: 'A person reposts a digest; this is refused on an agent token.' };
    const audit = await auditOpen({ tool: 'repost_outside_digest', args, access: deps.access, kind: 'outside_digests', requester: typeof args.requester_user_id === 'string' ? args.requester_user_id : null, dry_run: args.dry_run === true });
    try {
      const r = await rssReports.repostDigest(args);
      await auditClose(audit, { outcome: args.dry_run === true ? 'dry_run' : r.ok ? 'updated' : 'failed', detail: `${String(r.digest_date ?? args.digest_date ?? 'newest')} ${r.updated ? 'rewritten' : r.posted ? 'posted' : 'not posted'}`, natural_id: String(r.digest_date ?? '') });
      return { ...r, audit_id: audit };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const refused = e instanceof rssReports.RssReportError;
      await auditClose(audit, { outcome: refused ? 'refused' : 'failed', detail: message });
      return { ok: false, reason: refused ? 'refused' : 'error', message, audit_id: audit, ...(refused ? {} : { raise: true }) };
    }
  },
};

export const OUTSIDE_SOURCE_WRITE_TOOLS: ToolDefinition[] = [decideRssCandidate, repostOutsideDigest];
