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
        received_at: d.received_at,
      })),
      rule: 'Cite the item links inside the digest. Raw items are not served here; the digest is the only outside read.',
    };
  },
};

export const OUTSIDE_READ_TOOLS: ToolDefinition[] = [readOutsideDigest];
