/**
 * `read_genie_builder` (9 Nov 2026, Destiny — the Logstream side of the genie-slack-n8n rail,
 * #bha-coordination 1793566544.600759). Every Genie Builder interaction Genie has reported, one row
 * per interaction_id with its four stages, and the figures the rev 5 proof is read from: how often
 * Genie's work was accepted, modified or rejected, the average usefulness rating, how many were left
 * unreviewed, and test_forced kept apart from live_natural. genieBuilder.read holds the rules. A read.
 */
import * as mirror from '../mirror';
import * as genieBuilder from '../genieBuilder';
import type { ToolDefinition } from './tools';
import { auditClose, auditOpen } from './writeTools';
import { FeedError } from '../systemFeeds';

export const readGenieBuilder: ToolDefinition = {
  name: 'read_genie_builder',
  description:
    'How much the Genie Builder has done, in one read: build_trail (every change Genie made behind an Approve card, with plan, decision, what it built and the asker\'s rating; this is the count of Genie builds), reuse_check (live on every Genie build and every submitted Codex log, with how many found a match and whether pattern-trust ranking has data yet), and the Genie Builder interactions as Genie reported them (rail genie-slack-n8n first): one row per interaction_id with what was asked and by whom, whether it touched anything live and why, who approved and the two-builder check, what n8n built and its debrief, live_effect, and the builder\'s decision and 1 to 5 rating; plus the summary the proof is read from (accepted / modified / rejected, average rating, awaiting review, failed feedback loops), split into live_natural and test_forced. Only a reviewed interaction counts toward the proof, and a test_forced one is never real use. Since 22 Nov 2026 every build is a record, with Genie or without: surface (slack, web_chat, claude_code), tools invoked, the reuse check (reused / extended / forked / built_new and what was found), a not_used record with its reason when Genie was not used, and whether it is marked production. Read this before planning a build and cite a past one by its interaction_id. Filter by rail_id, interaction_id, surface, used_genie, requester_id or words (search). Read only.',
  inputSchema: {
    type: 'object',
    properties: {
      rail_id: { type: 'string', description: 'e.g. genie-slack-n8n.' },
      interaction_id: { type: 'string', description: 'One interaction, Genie\'s request_id.' },
      surface: { type: 'string', enum: ['slack', 'web_chat', 'claude_code', 'other'] },
      used_genie: { type: 'boolean', description: 'false: only builds done without Genie, with their reasons.' },
      requester_id: { type: 'string', description: 'Slack id of who asked for the build.' },
      search: { type: 'string', description: 'Words in the id, plan, build_ref, reason or reuse check.' },
      limit: { type: 'number', description: 'Rows to return, newest first. Default 50, at most 200. The summary is always over every row.' },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, title: 'Genie Builder interactions and their proof figures' },
  handler: async (args, deps) => {
    const t0 = Date.now();
    const limit = typeof args.limit === 'number' ? Math.max(1, Math.min(200, Math.floor(args.limit))) : 50;
    const r = await genieBuilder.read({
      rail_id: typeof args.rail_id === 'string' ? args.rail_id.trim() || null : null,
      interaction_id: typeof args.interaction_id === 'string' ? args.interaction_id.trim() || null : null,
      surface: typeof args.surface === 'string' ? args.surface.trim() || null : null,
      used_genie: typeof args.used_genie === 'boolean' ? args.used_genie : null,
      requester_id: typeof args.requester_id === 'string' ? args.requester_id.trim() || null : null,
      search: typeof args.search === 'string' ? args.search.trim() || null : null,
      limit,
    });
    await mirror.logWrite({
      endpoint: 'mcp:read_genie_builder', kind: 'genie_builder', method: 'MCP',
      key_label: deps.access === 'write' ? 'MCP_WRITE_TOKEN' : 'MCP_SECRET', outcome: 'read',
      detail: `${r.returned} of ${r.held} interaction(s); ${r.summary.all.counted_toward_proof} counted toward the proof`, ms: Date.now() - t0,
    });
    return {
      ok: true,
      ...r,
      how_to_answer: 'To say how many builds Genie has done, quote build_trail.builds and its ratings. To say whether the reuse check runs, quote reuse_check. interactions and summary are the separate Genie Builder record; an empty or filtered read of them never means no builds.',
    };
  },
};

/**
 * `record_genie_build` (22 Nov 2026, Destiny; Jason in #bha-coordination 1795291672.614769 and 1795291916.233199).
 * The same store POST /api/engine/genie-builder uses, as a tool, so Genie (on its own key), Bays and a person on
 * the connector record a build from wherever it happened without a code change on their side. Each call is one
 * message, or up to 50, each one stage. Refused messages write nothing; every call is on engine_mcp_writes.
 */
export const recordGenieBuild: ToolDefinition = {
  name: 'record_genie_build',
  description:
    'Record one stage of a build in the Genie Builder record (genie.builder.interaction.v1), one row per interaction_id. Every build is recorded, with Genie or without. Stages: queued (requester_id, intent, live_touching and reason, genie_plan_id, plan_summary, context_sources, surface slack|web_chat|claude_code|other, and reuse_check {result: reused|extended|forked|built_new, matches:[...], justification} — required, and built_new needs the justification; build_ref names the loop, PR, workflow or Codex id); approval; terminal (status, live_effect, backend_debrief or error_or_stop_reason, submission, tools_invoked: tool names); review (rater_id, builder_decision accepted|modified|rejected, usefulness_rating 1 to 5); not_used (a build done without Genie: requester_id, surface, build_ref, plan_summary of what was built, not_used_category missing_tool|trust|too_slow|ux|not_applicable|other, not_used_reason, reuse_check); production (marked_by: marks the build production, refused unless its reuse check is logged and it was reviewed accepted or modified, or Genie was not used with a reason). Every message carries interaction_id, rail_id (e.g. genie-web-chat, genie-slack, claude-code), stage and proof_type test_forced|live_natural. Read read_genie_builder first to reuse or cite a past build. dry_run checks and writes nothing.',
  inputSchema: {
    type: 'object',
    properties: {
      message: { type: 'object', description: 'One stage message.' },
      messages: { type: 'array', items: { type: 'object' }, description: 'Up to 50 stage messages, in order.' },
      requester_user_id: { type: 'string', description: 'Slack id of the person asking for this record.' },
      thread_ref: { type: 'string', description: 'The chat conversation id or Slack channel:thread the build was asked in. Genie\'s chat app fills it in. Every approved change Genie makes there is then added to this build by itself.' },
      dry_run: { type: 'boolean' },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false, title: 'Record a build in the Genie Builder record' },
  handler: async (args, deps) => {
    const dry = args.dry_run === true;
    const requester = typeof args.requester_user_id === 'string' ? args.requester_user_id.trim() : null;
    const audit = await auditOpen({ tool: 'record_genie_build', args, access: deps.access, kind: 'genie_builder', requester, dry_run: dry });
    const ref = typeof args.thread_ref === 'string' && args.thread_ref.trim() ? args.thread_ref.trim().slice(0, 120) : null;
    const raw = Array.isArray(args.messages) ? args.messages : args.message !== undefined ? [args.message] : [];
    const list = ref ? raw.map((m) => (m && typeof m === 'object' && !Array.isArray(m) && !(m as Record<string, unknown>).thread_ref ? { ...(m as Record<string, unknown>), thread_ref: ref } : m)) : raw;
    if (!list.length) {
      await auditClose(audit, { outcome: 'refused', detail: 'no message', guard_result: { reason: 'no_message' } });
      return { ok: false, written: false, reason: 'no_message', message: 'Send message (one stage) or messages (up to 50). Nothing was written.', audit_id: audit };
    }
    try {
      const r = await genieBuilder.store({ messages: list, dry_run: dry });
      const ids = r.interaction_ids.join(', ');
      await auditClose(audit, { outcome: dry ? 'dry_run' : r.inserted ? 'created' : 'updated', detail: `${r.received} message(s): ${ids}`, natural_id: r.interaction_ids[0] ?? null, after: list });
      return { ok: true, written: !dry, ...r, page: 'https://dashboard.bhanetwork.org/genie?tab=builder', message: dry ? `Checked ${r.received} message(s); nothing was written.` : `Recorded ${r.received} message(s) for ${ids}.`, audit_id: audit };
    } catch (e) {
      const status = e instanceof FeedError ? e.status : 500;
      const message = e instanceof Error ? e.message : String(e);
      await auditClose(audit, { outcome: status < 500 ? 'refused' : 'failed', detail: message, guard_result: { reason: 'refused', status } });
      return { ok: false, written: false, reason: status < 500 ? 'refused' : 'error', message: `${message} Nothing was written.`, ...(status >= 500 ? { raise: true } : {}), audit_id: audit };
    }
  },
};

export const GENIE_BUILDER_READ_TOOLS: ToolDefinition[] = [readGenieBuilder];
export const GENIE_BUILDER_WRITE_TOOLS: ToolDefinition[] = [recordGenieBuild];
