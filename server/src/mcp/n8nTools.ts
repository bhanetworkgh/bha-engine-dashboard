/**
 * `list_n8n_workflows` and `get_n8n_workflow` (2026-09-24, Destiny).
 *
 * The Bays agent needs to see what the engine's workflows are and how one is
 * wired — which it used to do through n8n tools of its own on the retired
 * Tools Router. These read the n8n public API with the `N8N_API_KEY` the
 * Executions page already reads with. **Read only**: nothing here calls
 * `replaceWorkflow`, and CLAUDE.md section 3 still holds — workflows are read,
 * never modified, from here.
 *
 * The workflow view is **trimmed on purpose**. A whole workflow is tens of
 * kilobytes of positions, ids and credential stubs; an agent needs the nodes,
 * what they do, how they connect and what the sticky notes say. Every cap is
 * stated in the answer rather than applied silently.
 */
import * as n8n from '../n8n';
import type { ToolAnnotations, ToolDefinition } from './tools';

const READS_N8N: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

/** Per node, the parameters JSON is cut here; per sticky note, its text here. */
export const PARAMETERS_CAP = 1_500;
export const NOTE_CAP = 3_000;

const STICKY = 'n8n-nodes-base.stickyNote';

function notConfigured(): Record<string, unknown> {
  return { ok: false, reason: 'not_configured', message: `${n8n.N8N_API_VAR} is not set on this server, so n8n cannot be read.` };
}

function failure(e: unknown, step: string): Record<string, unknown> {
  const status = e instanceof n8n.N8nError ? e.status : null;
  return { ok: false, reason: 'n8n_error', step, status, message: e instanceof Error ? e.message : String(e) };
}

interface RawNode {
  name?: unknown;
  type?: unknown;
  disabled?: unknown;
  parameters?: unknown;
}

/**
 * n8n's connections, as `"From [main 0] -> To"` lines. The outer key is the
 * source node, then the connection type (`main`, `ai_tool`, `ai_languageModel`
 * …), then one array per output index, each holding the targets.
 */
export function connectionLines(connections: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [from, byType] of Object.entries(connections ?? {})) {
    if (!byType || typeof byType !== 'object') continue;
    for (const [type, outputs] of Object.entries(byType as Record<string, unknown>)) {
      if (!Array.isArray(outputs)) continue;
      outputs.forEach((targets, index) => {
        if (!Array.isArray(targets)) return;
        for (const t of targets as { node?: unknown }[]) {
          if (t && typeof t.node === 'string') out.push(`${from} [${type} ${index}] -> ${t.node}`);
        }
      });
    }
  }
  return out;
}

export function trimWorkflow(w: { id: string; name: string; active?: boolean; updatedAt?: unknown; nodes: unknown[]; connections: Record<string, unknown> }): Record<string, unknown> {
  const nodes: Record<string, unknown>[] = [];
  const notes: Record<string, unknown>[] = [];
  let paramsCut = 0;
  let notesCut = 0;
  for (const raw of w.nodes as RawNode[]) {
    if (!raw || typeof raw !== 'object') continue;
    const type = String(raw.type ?? '');
    const name = String(raw.name ?? '');
    if (type === STICKY) {
      const content = String((raw.parameters as { content?: unknown } | undefined)?.content ?? '');
      const cut = content.length > NOTE_CAP;
      if (cut) notesCut++;
      notes.push({ name, content: cut ? content.slice(0, NOTE_CAP) : content, ...(cut ? { truncated: true, length: content.length } : {}) });
      continue;
    }
    const json = JSON.stringify(raw.parameters ?? {});
    const cut = json.length > PARAMETERS_CAP;
    if (cut) paramsCut++;
    nodes.push({
      name,
      type,
      disabled: raw.disabled === true,
      // Whole parameters where they fit; a cut one comes back as the text it
      // was cut to, flagged, never as JSON that silently lost its tail.
      parameters: cut ? json.slice(0, PARAMETERS_CAP) : (raw.parameters ?? {}),
      ...(cut ? { parameters_truncated: true, parameters_length: json.length } : {}),
    });
  }
  return {
    ok: true,
    id: w.id,
    name: w.name,
    active: w.active ?? null,
    updatedAt: w.updatedAt ?? null,
    nodes,
    connections: connectionLines(w.connections),
    notes,
    caps: {
      parameters_chars: PARAMETERS_CAP,
      note_chars: NOTE_CAP,
      nodes_with_parameters_cut: paramsCut,
      notes_cut: notesCut,
      ...(paramsCut || notesCut ? { note: 'A cut value is text rather than JSON and carries its full length. The whole workflow is in n8n.' } : {}),
    },
  };
}

export const listN8nWorkflows: ToolDefinition = {
  name: 'list_n8n_workflows',
  description:
    'Every workflow on the n8n instance: id, name and whether it is active — nothing else. Read with N8N_API_KEY; read only. Use it to find the exact id get_n8n_workflow needs.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { ...READS_N8N, title: 'List n8n workflows' },
  handler: async () => {
    if (!n8n.n8nConfigured()) return notConfigured();
    try {
      const r = await n8n.workflows();
      const workflows = r.workflows.map((w) => ({ id: w.id, name: w.name, active: w.active ?? null })).sort((a, b) => a.name.localeCompare(b.name));
      return {
        ok: true,
        count: workflows.length,
        active: workflows.filter((w) => w.active === true).length,
        workflows,
        ...(r.truncated ? { truncated: true, note: 'The listing hit its page ceiling; there are more workflows than these.' } : {}),
      };
    } catch (e) {
      return failure(e, 'GET /api/v1/workflows');
    }
  },
};

export const getN8nWorkflow: ToolDefinition = {
  name: 'get_n8n_workflow',
  description: `One n8n workflow, trimmed to what explains it: id, name, active, updatedAt; nodes (sticky notes left out) as {name, type, disabled, parameters}, parameters JSON capped at ${PARAMETERS_CAP} characters; connections as "From [main 0] -> To" lines; and notes, the sticky notes' text, each capped at ${NOTE_CAP}. Every cut is flagged. Read only.`,
  inputSchema: {
    type: 'object',
    properties: { workflow_id: { type: 'string', description: 'The n8n workflow id, e.g. 5AFqtZQaeKFFiGqe. list_n8n_workflows has them all.' } },
    required: ['workflow_id'],
    additionalProperties: false,
  },
  annotations: { ...READS_N8N, title: 'Read one n8n workflow' },
  handler: async (args) => {
    const id = typeof args.workflow_id === 'string' ? args.workflow_id.trim() : '';
    if (!id) return { ok: false, reason: 'bad_argument', message: '"workflow_id" is required — use list_n8n_workflows to find the exact id.' };
    if (!n8n.n8nConfigured()) return notConfigured();
    try {
      const w = await n8n.workflow(id);
      return trimWorkflow(w);
    } catch (e) {
      if (e instanceof n8n.N8nError && (e.status === 404 || e.status === 400)) {
        return { ok: false, reason: 'workflow_not_found', workflow_id: id, status: e.status, message: `n8n has no workflow "${id}" (${e.message}) — use list_n8n_workflows to find the exact id.` };
      }
      return failure(e, `GET /api/v1/workflows/${id}`);
    }
  },
};

/* ------------------------------------------------ sweep_airtable_nodes */

/**
 * The hidden Airtable writer sweep (2026-09-24, LOOP-1790034076667-8HOF) as a
 * tool, so it can be re-run with the server's own `N8N_API_KEY` — the only
 * place that key lives. Read only: every workflow is read with `GET`, and
 * nothing is changed. `airtableSweep.ts` holds the rules; this is only the
 * door to them.
 */
export const sweepAirtableNodes: ToolDefinition = {
  name: 'sweep_airtable_nodes',
  description:
    'Read EVERY n8n workflow (active and inactive) and name each node that touches Airtable: an Airtable node type, an Airtable credential, or "airtable" / api.airtable.com / a base id app… / a table id tbl… in its parameters, URLs, expressions or Code. Sorted into active_writers (live and would run), inactive_writers (would write if switched on), reads, and references (names an id without calling Airtable), each with read-or-write and how that was decided, and whether the table is one the dashboard now owns. Also every Airtable credential a node names. Read only; changes nothing.',
  inputSchema: {
    type: 'object',
    properties: {
      include_references: { type: 'boolean', description: 'Also list nodes that only name an Airtable id or the word. Default false: they are counted, not listed.' },
      include_evidence: { type: 'boolean', description: 'Add up to three excerpts per node around what matched. Default false.' },
    },
    additionalProperties: false,
  },
  annotations: { ...READS_N8N, title: 'Sweep n8n for Airtable nodes' },
  handler: async (args) => {
    if (!n8n.n8nConfigured()) return notConfigured();
    const sweep = await import('../airtableSweep');
    try {
      const r = await sweep.sweep(
        async () => {
          const l = await n8n.workflows(50);
          if (l.truncated) throw new Error('The workflow listing hit its page ceiling; the sweep would be incomplete, so it was not run.');
          return l.workflows.map((w) => ({ id: w.id, name: w.name, active: w.active }));
        },
        (id) => n8n.workflow(id),
      );
      const row = (f: import('../airtableSweep').Finding) => ({
        workflow_id: f.workflow_id,
        workflow: f.workflow_name,
        active: f.active,
        archived: f.archived,
        node: f.node,
        node_type: f.node_type,
        node_disabled: f.node_disabled || undefined,
        access: f.access,
        how: f.access_basis,
        tables: [...f.tables, ...f.table_names],
        bases: f.bases,
        owned_by_dashboard: f.owned.length || f.owned_base_only.length ? [...f.owned, ...f.owned_base_only] : false,
        ...(args.include_evidence === true ? { evidence: f.evidence } : {}),
      });
      return {
        ok: true,
        swept_at: r.swept_at,
        workflows: r.workflows,
        workflows_active: r.workflows_active,
        workflows_read_failed: r.workflows_read_failed,
        counts: { active_writers: r.active_writers.length, inactive_writers: r.inactive_writers.length, reads: r.reads.length, references: r.references.length },
        active_writers: r.active_writers.map(row),
        inactive_writers: r.inactive_writers.map(row),
        reads: r.reads.map(row),
        ...(args.include_references === true ? { references: r.references.map(row) } : {}),
        credentials_in_use: r.credentials_in_use,
        note: 'Credentials listed are the ones nodes name; the n8n public API has no endpoint that lists every credential, so an Airtable credential no node uses does not appear here.',
      };
    } catch (e) {
      return failure(e, 'sweep');
    }
  },
};
