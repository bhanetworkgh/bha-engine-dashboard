/**
 * CST help pages over MCP (27 Oct 2026, Destiny). The rules and the store are ../helpPages.ts.
 *
 *   `read_help_pages`        — read, both connections; in Bays', North Star's, Research Twin's and Genie's
 *                              scopes. Every page with its stage, so a draft is never quoted as final.
 *   `write_help_page`        — write connection, no agent's scope, refused on any agent token.
 *                              Destiny or Jason writes the text, the gaps and the sources.
 *   `set_help_page_stage`    — write connection, no agent's scope, refused on any agent token.
 *                              checked (on Hardik's own Slack message), in_corpus (with the BHARAG doc id),
 *                              or back_to_draft.
 *
 * Every write call is on engine_mcp_writes, kind help_pages, refused ones included.
 */
import * as help from '../helpPages';
import * as mirror from '../mirror';
import { auditClose, auditOpen } from './writeTools';
import type { ToolDefinition, ToolDeps } from './tools';

const str = (args: Record<string, unknown>, key: string): string => (typeof args[key] === 'string' ? (args[key] as string).trim() : '');
const PUBLIC = (process.env.PUBLIC_DASHBOARD_URL?.trim() || 'https://dashboard.bhanetwork.org').replace(/\/$/, '');
export const pageUrl = (id: string): string => `${PUBLIC}/cs-twin?tab=help&page=${encodeURIComponent(id)}`;

export const readHelpPages: ToolDefinition = {
  name: 'read_help_pages',
  description:
    "The Customer Service Twin's help pages for vFarm pilot operators (the cst-help-manuals corpus Destiny owns): the operator quick start, rack and reservoir care, and what the assistant can and cannot do. Each page comes with its stage: draft (unreviewed; open gaps named with who owes them), checked (Hardik passed this exact text against Honest Gate) or in_corpus (in BHARAG's cst-help-manuals, the only thing CST answers customers from). customer_safe is true only at in_corpus. Rules travel with the answer: never quote a draft to a customer or pilot operator as BHA's answer, and never fill a gap in. page_id returns one page whole; without it, every page. Each page carries url, the dashboard link to share with the team. Read only.",
  inputSchema: {
    type: 'object',
    properties: {
      page_id: { type: 'string', description: 'One page, e.g. operator-quickstart, rack-care, what-cst-can-do. Leave out for all.' },
      include_text: { type: 'boolean', description: 'Include each page\'s full text when reading all. Default true.' },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, title: 'Read the CST help pages and their stage' },
  handler: async (args, deps) => {
    const t0 = Date.now();
    const id = str(args, 'page_id');
    const r = await help.read();
    let pages = r.pages.map((p) => ({ ...p, url: pageUrl(p.page_id) }));
    if (id) {
      pages = pages.filter((p) => p.page_id === id);
      if (!pages.length) return { ok: false, reason: 'not_found', message: `No help page "${id}".`, pages: r.pages.map((p) => ({ page_id: p.page_id, title: p.title, stage_label: p.stage_label })) };
    } else if (args.include_text === false) {
      pages = pages.map((p) => ({ ...p, body: '' }));
    }
    await mirror.logWrite({ endpoint: 'mcp:read_help_pages', kind: 'help_pages', method: 'MCP', key_label: deps.access === 'write' ? 'MCP_WRITE_TOKEN' : 'MCP_SECRET', outcome: 'read', detail: `${id || 'all'} → ${pages.length} page(s)`, ms: Date.now() - t0 });
    return { ok: true, pages, counts: r.counts, rules: r.rules, list_url: `${PUBLIC}/cs-twin?tab=help` };
  },
};

async function guarded<T extends Record<string, unknown>>(
  tool: string,
  args: Record<string, unknown>,
  deps: ToolDeps,
  run: (dry: boolean) => Promise<{ written: boolean; message: string; page: help.HelpPage } & T>,
): Promise<Record<string, unknown>> {
  const requester = str(args, 'requester_user_id') || null;
  const dry = args.dry_run === true;
  const audit = await auditOpen({ tool, args, access: deps.access, kind: 'help_pages', requester, dry_run: dry });
  if (deps.agent) {
    const message = `An agent (${deps.agent}) may not change a help page: Destiny owns them, and Hardik's check is his own.`;
    await auditClose(audit, { outcome: 'refused', detail: `agent_not_permitted: ${message}`, guard_result: { reason: 'agent_not_permitted' } });
    return { ok: false, written: false, reason: 'agent_not_permitted', message: `${message} Nothing was changed.`, audit_id: audit };
  }
  try {
    const r = await run(dry);
    await auditClose(audit, { outcome: dry ? 'dry_run' : r.written ? 'updated' : 'unchanged', detail: r.message, natural_id: r.page.page_id, after: { ...r.page, body: `${r.page.body.length} characters` } });
    return { ...r, url: pageUrl(r.page.page_id), stage_label: help.stageLabel(r.page), audit_id: audit };
  } catch (e) {
    if (e instanceof help.HelpPageError) {
      await auditClose(audit, { outcome: 'refused', detail: `${e.reason}: ${e.message}`, guard_result: { reason: e.reason } });
      return { ok: false, written: false, reason: e.reason, message: `${e.message} Nothing was changed.`, audit_id: audit };
    }
    const message = e instanceof Error ? e.message : String(e);
    await auditClose(audit, { outcome: 'failed', detail: message });
    return { ok: false, written: false, reason: 'error', message: `${message} Nothing was changed.`, raise: true, audit_id: audit };
  }
}

export const writeHelpPage: ToolDefinition = {
  name: 'write_help_page',
  description: `Create or change one CST help page: its title, its text (markdown: ## headings, - bullets, 1. steps, - [ ] checks, **bold**), its open gaps ([{id, owner, note}]: a part nobody has written yet and who owes it) and its sources. HELD HERE: only Destiny or Jason (requester_user_id). The stage is not set here: a new page is a draft, and changing the text of a checked or in_corpus page puts it back to draft, because Hardik checked other words. Leaving a field out keeps it; gaps: [] clears them. dry_run writes nothing. Refused on any agent token. Audited on engine_mcp_writes.`,
  inputSchema: {
    type: 'object',
    properties: {
      page_id: { type: 'string', description: 'Lower case and hyphens, e.g. rack-care.' },
      title: { type: 'string' },
      body: { type: 'string', description: `Markdown, at most ${help.RULE.body_max} characters.` },
      gaps: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, owner: { type: 'string' }, note: { type: 'string' } }, required: ['id', 'owner', 'note'] } },
      sources: { type: 'string' },
      note: { type: 'string', description: 'What changed and why, for the history.' },
      requester_user_id: { type: 'string', description: 'Slack id of the person writing: Destiny or Jason.' },
      dry_run: { type: 'boolean' },
    },
    required: ['page_id', 'requester_user_id'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false, title: 'Write a CST help page' },
  handler: (args, deps) =>
    guarded('write_help_page', args, deps, (dry) =>
      help.write(
        {
          page_id: str(args, 'page_id'),
          title: typeof args.title === 'string' ? args.title : null,
          body: typeof args.body === 'string' ? args.body : null,
          gaps: args.gaps,
          sources: args.sources === undefined ? undefined : typeof args.sources === 'string' ? args.sources : null,
          note: str(args, 'note') || null,
          requester_user_id: str(args, 'requester_user_id'),
        },
        { dry_run: dry },
      ),
    ),
};

export const setHelpPageStage: ToolDefinition = {
  name: 'set_help_page_stage',
  description: `Move a CST help page along: checked (Hardik passed this exact text against Honest Gate; evidence_link must be Hardik's own Slack message and Slack must confirm he posted it), in_corpus (the checked text is in BHARAG's cst-help-manuals; bharag_doc_id required, and only from checked), or back_to_draft (with a note). HELD HERE: Destiny, Jason or Hardik only; in_corpus by Destiny or Jason. Pass body_sha256 from read_help_pages so a check is never recorded against text that changed since. Nothing here writes to BHARAG. dry_run writes nothing. Refused on any agent token. Audited on engine_mcp_writes.`,
  inputSchema: {
    type: 'object',
    properties: {
      page_id: { type: 'string' },
      action: { type: 'string', enum: [...help.ACTIONS] },
      evidence_link: { type: 'string', description: 'checked: the Slack link to Hardik\'s message passing the page.' },
      bharag_doc_id: { type: 'string', description: 'in_corpus: the document id in cst-help-manuals.' },
      body_sha256: { type: 'string', description: 'The body_sha256 you read. Optional, recommended.' },
      note: { type: 'string' },
      requester_user_id: { type: 'string' },
      dry_run: { type: 'boolean' },
    },
    required: ['page_id', 'action', 'requester_user_id'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true, title: 'Record a CST help page\'s stage' },
  handler: (args, deps) =>
    guarded('set_help_page_stage', args, deps, (dry) =>
      help.setStage(
        {
          page_id: str(args, 'page_id'),
          action: str(args, 'action'),
          requester_user_id: str(args, 'requester_user_id'),
          evidence_link: str(args, 'evidence_link') || null,
          bharag_doc_id: str(args, 'bharag_doc_id') || null,
          body_sha256: str(args, 'body_sha256') || null,
          note: str(args, 'note') || null,
        },
        { dry_run: dry },
      ),
    ),
};

export const HELP_READ_TOOLS: ToolDefinition[] = [readHelpPages];
export const HELP_WRITE_TOOLS: ToolDefinition[] = [writeHelpPage, setHelpPageStage];
