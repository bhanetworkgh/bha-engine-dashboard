/**
 * Pattern candidates over MCP (2026-09-25, Destiny): "Draft full pattern" and
 * Register without a browser, so Bays can run the whole flow from Slack.
 *
 * **Not a second implementation.** Both tools call `candidateActions.draftFor`
 * and `candidateActions.register` — the functions `POST
 * /api/pattern-candidates/:id/{draft|register}` call — with `via: 'write'`.
 * The who-may-act rule, the OpenRouter gate, the model and prompt, the
 * create_record path (BP- id, BHARAG, Google Doc), the #bha-build-patterns
 * announcement and the post-register delete are therefore exactly the page's.
 * What differs is only the label on the logs: `mcp:<tool>` and
 * `MCP_WRITE_TOKEN`, with the MCP audit lines at access `write`.
 *
 * **Write connection only**, like every tool that can change a record or spend
 * money: a draft saves nothing, but it is a paid model call and the first half
 * of a Register, so it is not offered on the read URL. In production the two
 * URLs are one (CLAUDE.md section 4), so the connector already in Claude and
 * Bays' allow-list pick both up on a tool refresh.
 *
 * **The acting person is declared**, as on the page: `requester_user_id` is a
 * Slack id with a Builder Profiles row, and the candidate's suggested
 * architect, its builder, Jason or Destiny may act. A refusal is `ok: false`
 * with the page's own reason and message, never a throw, so an agent reads why.
 */
import * as candidateActions from '../candidateActions';
import type { ToolDefinition } from './tools';

const CANDIDATE_ARG = {
  type: 'string',
  description: 'The candidate: its CAND-… id (find_records kind pattern_candidates returns it as natural_id), or row-<id> for a row with no CAND- id.',
};
const REQUESTER_ARG = {
  type: 'string',
  description: 'Slack id of the person acting — the candidate’s suggested architect, its builder, Jason or Destiny. Must have a Builder Profiles row. Declared, not authenticated, exactly as on the page.',
};

function refusal(e: unknown): Record<string, unknown> {
  if (e instanceof candidateActions.CandidateError) return { ok: false, status: e.status, reason: e.reason, message: e.message };
  throw e;
}

function ref(args: Record<string, unknown>): string {
  const v = args.candidate;
  return typeof v === 'string' ? v.trim() : '';
}

function actor(args: Record<string, unknown>): string | null {
  const v = args.requester_user_id;
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

export const draftPatternCandidate: ToolDefinition = {
  name: 'draft_pattern_candidate',
  description:
    'The Build patterns page’s "Draft full pattern", over MCP. Drafts every field of a build pattern for one pattern candidate with the Pattern Extractor’s own model (anthropic/claude-sonnet-5, through OpenRouter) and prompt, from what the candidate actually has: its Summary and every other field it carries, the Slack thread at its Source Link (read as North Star), a Codex entry it names (or codex_entry_id), and any notes you pass. A field those sources do not support comes back empty — nothing is invented. **Saves nothing**: pass the fields (edited if needed) to register_pattern_candidate. Each call is a paid model call and is counted on the candidate. Same who-may-act rule as Register. Refused with not_configured when OPENROUTER_API_KEY is unset.',
  inputSchema: {
    type: 'object',
    properties: {
      candidate: CANDIDATE_ARG,
      requester_user_id: REQUESTER_ARG,
      notes: { type: 'string', description: 'Optional. Anything the builder knows that the candidate row does not carry — sent into the prompt as its own source.' },
      codex_entry_id: { type: 'string', description: 'Optional. A Codex Entry ID (CODEX-…) or Submission ID to read as a source, beside any the candidate names.' },
    },
    required: ['candidate', 'requester_user_id'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true, title: 'Draft a full pattern for a candidate (saves nothing)' },
  handler: async (args) => {
    try {
      return await candidateActions.draftFor(ref(args), {
        actor_user_id: actor(args),
        notes: typeof args.notes === 'string' ? args.notes : null,
        codex_entry_id: typeof args.codex_entry_id === 'string' ? args.codex_entry_id : null,
        via: 'write',
      });
    } catch (e) {
      return refusal(e);
    }
  },
};

export const registerPatternCandidate: ToolDefinition = {
  name: 'register_pattern_candidate',
  description:
    'The Build patterns page’s Register, over MCP. Writes the candidate up as a build pattern through create_record (BP- id minted, BHARAG ingested, Google Doc made), announces it in #bha-build-patterns as Bays, marks the candidate Registered with the Pattern ID, and then **deletes the candidate row** — it now lives on the Build patterns page as the pattern; the whole row is kept in record_deletions first. `fields` are the pattern’s fields: what draft_pattern_candidate returned (edited or not), or your own; leave `fields` out to register from the candidate’s name, Summary and lane alone, as the page’s plain form does. pattern_name is required either way. A candidate already Registered or Declined is refused. dry_run: true runs the pattern guards and writes nothing.',
  inputSchema: {
    type: 'object',
    properties: {
      candidate: CANDIDATE_ARG,
      requester_user_id: REQUESTER_ARG,
      fields: {
        type: 'object',
        description:
          'The pattern: pattern_name, problem, solution, context, bha_system, reusability (Narrow | Moderate | Broad), implementation_checklist (a list, or one step per line), learnings_gotchas, anti_pattern, integration_points, readiness_gates, next_use_case, test_coverage, routing_logic, commercial_impact, research_production_impact, naming_note, roadmap_context. Empty values are not written.',
      },
      dry_run: { type: 'boolean', description: 'Run the guards and return what would be written, without writing, announcing or deleting.' },
    },
    required: ['candidate', 'requester_user_id'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true, title: 'Register a candidate as a build pattern' },
  handler: async (args) => {
    const f = args.fields;
    try {
      return await candidateActions.register(ref(args), {
        actor_user_id: actor(args),
        pattern: f && typeof f === 'object' && !Array.isArray(f) ? (f as Record<string, unknown>) : {},
        dry_run: args.dry_run === true || args.dry_run === 'true',
        via: 'write',
      });
    } catch (e) {
      return refusal(e);
    }
  },
};

export const CANDIDATE_WRITE_TOOLS: ToolDefinition[] = [draftPatternCandidate, registerPatternCandidate];
