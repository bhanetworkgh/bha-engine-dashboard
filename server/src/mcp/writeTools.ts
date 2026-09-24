/**
 * The MCP write tools (2026-09-24, Destiny).
 *
 * The dashboard is the record for every engine table now that Airtable is
 * retired, and Destiny (through Claude) and the Bays n8n Agent both need to
 * create, change and archive records directly. These five tools do it, and they
 * exist **only on the write connection** — `/mcp/<MCP_WRITE_TOKEN>`. The read
 * connection never registers them.
 *
 * Three rules, each held in exactly one place so they cannot drift:
 *
 *   **One write path.** A create is `engineWrite.postRecord` and an update is
 *   `engineWrite.patchRecord` — the functions `POST /api/engine/:kind` and
 *   `PATCH /api/engine/:kind/:id` call. The natural id, `created_time`, the
 *   status ledger, the `source` column and the `engine_writes` line all happen
 *   identically whichever door a write came through.
 *
 *   **One set of guards.** `writeGuards.ts`, ported from the Bays Tools Router.
 *   A refusal writes nothing and says what to send to proceed.
 *
 *   **Every call is audited**, refused and dry-run ones included, to
 *   `engine_mcp_writes` — the table the write gate made. The audit row is
 *   written **before** the change and completed after it, so a write whose
 *   audit cannot be recorded never happens.
 */
import { createHash } from 'node:crypto';
import { query } from '../pg';
import * as mirror from '../mirror';
import * as engineWrite from '../engineWrite';
import * as bharag from '../bharag';
import * as google from '../google';
import * as guards from '../writeGuards';
import { McpError } from './source';
import type { ToolDefinition, ToolDeps } from './tools';

/* ------------------------------------------------------------- the audit */

interface AuditOpen {
  tool: string;
  args: Record<string, unknown>;
  access: 'read' | 'write' | 'page';
  kind: string | null;
  requester: string | null;
  dry_run: boolean;
}

export async function auditOpen(a: AuditOpen): Promise<number> {
  const digest = createHash('sha256').update(JSON.stringify({ tool: a.tool, args: a.args })).digest('hex');
  const r = await query<{ id: string }>(
    `INSERT INTO engine_mcp_writes (tool, arguments, digest, access, kind, dry_run, requester_user_id, outcome, actor, target)
     VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7, 'pending', $8, $9) RETURNING id`,
    [a.tool, JSON.stringify(a.args), digest, a.access, a.kind, a.dry_run, a.requester, `mcp:${a.access}${a.requester ? `:${a.requester}` : ''}`, a.kind],
  );
  return Number(r.rows[0].id);
}

export async function auditClose(
  id: number,
  c: { outcome: string; detail?: string | null; record_id?: string | number | null; natural_id?: string | null; before?: unknown; after?: unknown; guard_result?: unknown },
): Promise<void> {
  await query(
    `UPDATE engine_mcp_writes SET outcome = $2, detail = $3, record_id = $4, natural_id = $5, before = $6::jsonb, after = $7::jsonb, guard_result = $8::jsonb,
            target = COALESCE(target, '') || CASE WHEN $4::text IS NULL THEN '' ELSE ' ' || $4::text END
      WHERE id = $1`,
    [
      id,
      c.outcome,
      c.detail ?? null,
      c.record_id === null || c.record_id === undefined ? null : String(c.record_id),
      c.natural_id ?? null,
      c.before === undefined ? null : JSON.stringify(c.before),
      c.after === undefined ? null : JSON.stringify(c.after),
      c.guard_result === undefined ? null : JSON.stringify(c.guard_result),
    ],
  );
}

/* ------------------------------------------------------------- helpers */

function s(args: Record<string, unknown>, key: string): string | null {
  const v = args[key];
  return typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null;
}

function b(args: Record<string, unknown>, key: string): boolean {
  const v = args[key];
  return v === true || (typeof v === 'string' && v.trim().toLowerCase() === 'true');
}

function kindOf(args: Record<string, unknown>): guards.WritableKind {
  const k = s(args, 'kind');
  if (!k) throw new McpError('bad_argument', `"kind" is required. One of: ${guards.WRITABLE_KINDS.join(', ')}.`);
  const spec = guards.writable(k);
  if (!spec) throw new McpError('bad_argument', `"${k}" is not a kind the write tools can write. One of: ${guards.WRITABLE_KINDS.join(', ')}. list_writable_kinds says what each takes.`);
  return spec;
}

/** delete_record's kind: every writable kind, plus the delete-only ones. */
function deletableKindOf(args: Record<string, unknown>): guards.WritableKind {
  const k = s(args, 'kind');
  if (!k) throw new McpError('bad_argument', `"kind" is required. One of: ${guards.DELETABLE_KINDS.join(', ')}.`);
  const spec = guards.deletable(k);
  if (!spec) throw new McpError('bad_argument', `"${k}" is not a kind delete_record can delete. One of: ${guards.DELETABLE_KINDS.join(', ')}.`);
  return spec;
}

function fieldsOf(args: Record<string, unknown>): Record<string, unknown> {
  const f = args.fields;
  if (!f || typeof f !== 'object' || Array.isArray(f)) throw new McpError('bad_argument', '"fields" is required and must be an object, keyed by the field names exactly as the table stores them (list_writable_kinds names them).');
  return f as Record<string, unknown>;
}

/** The one row an `id` or `natural_id` names, or a refusal naming the problem. */
async function target(kind: mirror.MirrorKind, args: Record<string, unknown>, ctx: engineWrite.WriteCtx): Promise<mirror.LookupRow> {
  const id = s(args, 'id');
  const natural = s(args, 'natural_id');
  if (!id && !natural) throw new McpError('bad_argument', 'Name the row with "id" (the row id the lookup returns) or "natural_id" (its own key — loop_id, pattern_id, CAND-…).');
  let rowId = id;
  if (!rowId) {
    try {
      rowId = await engineWrite.resolveRow(kind, natural!, ctx);
    } catch (e) {
      throw new McpError(e instanceof mirror.MirrorError && e.status === 409 ? 'ambiguous' : 'not_found', e instanceof Error ? e.message : String(e));
    }
  }
  if (!/^\d+$/.test(rowId)) throw new McpError('bad_argument', `"id": "${rowId}" is not a row id. It is this table's own number, as the lookup returns it; use natural_id for the row's own key.`);
  const row = await mirror.readRow(kind, rowId);
  if (!row) throw new McpError('not_found', `${kind} holds no row ${rowId}.`);
  return row;
}

function ctxFor(tool: string, deps: ToolDeps): engineWrite.WriteCtx {
  if (deps.access === 'page') return { endpoint: `page:${tool}`, method: 'PAGE', key_label: 'session cookie', t0: Date.now(), note: `via the page (${tool})` };
  return { endpoint: `mcp:${tool}`, method: 'MCP', key_label: deps.access === 'write' ? 'MCP_WRITE_TOKEN' : 'MCP_SECRET', t0: Date.now(), note: `via MCP ${tool}` };
}

function refused(r: guards.Refusal, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ok: false, written: false, reason: r.reason, message: r.message, ...(r.detail ? { detail: r.detail } : {}), checks: r.checks, ...extra };
}

/* ------------------------------------------------------------ BHARAG */

function line(label: string, v: unknown): string {
  const t = v === null || v === undefined ? '' : Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return t.trim() ? `${label}: ${t.trim()}` : '';
}

/**
 * The document a created row becomes in BHARAG, in the shape the n8n ingest
 * nodes send, so a record reads the same in BHARAG whichever producer made it.
 */
function documentFor(kind: string, f: Record<string, unknown>, drafter: string): bharag.IngestDocument | null {
  const v = (k: string) => (f[k] === undefined || f[k] === null ? '' : String(f[k]));
  if (kind === 'patterns') {
    // LBP - Normalise Pattern Fields' docTitle and docContent.
    return {
      title: `Build Pattern -- ${v('pattern_name')} -- ${drafter}`,
      content: [
        `BHA Build Pattern: ${v('pattern_name')}`,
        `Pattern ID: ${v('pattern_id')}`,
        `Drafted by: ${drafter} (via the dashboard MCP)`,
        `System: ${v('bha_system')} | Reusability: ${v('reusability')}`,
        `Problem: ${v('problem')}`,
        `Solution: ${v('solution')}`,
        `Context: ${v('context')}`,
        line('Learnings / Gotchas', f.learnings_gotchas),
        line('Readiness Gates', f.readiness_gates),
        line('Implementation Checklist', f.implementation_checklist),
        line('Integration Points', f.integration_points),
        line('Test Coverage', f.test_coverage),
        line('Routing Logic', f.routing_logic),
        line('Anti-Pattern', f.anti_pattern),
        line('Naming Note', f.naming_note),
        line('Next Use Case', f.next_use_case),
        line('Roadmap Context', f.roadmap_context),
        line('Research / Production Impact', f.research_production_impact),
        `Commercial Impact: ${v('commercial_impact')}`,
        `Source: ${drafter} via the dashboard MCP -- ${v('created_at')}`,
      ]
        .filter(Boolean)
        .join('\n\n'),
      source_type: 'manual',
      content_type: 'doc',
      project_tags: ['build-pattern', 'log-engine'],
      metadata: { pattern_id: v('pattern_id') },
    };
  }
  if (kind === 'commercial') {
    const skip = new Set(['card_id', 'opportunity_title']);
    return {
      title: `Commercial Opportunity — ${v('opportunity_title')} — ${drafter}`,
      content: [`Commercial Opportunity: ${v('opportunity_title')}`, `Card ID: ${v('card_id')}`, ...Object.keys(f).filter((k) => !skip.has(k)).map((k) => line(k, f[k]))].filter(Boolean).join('\n\n'),
      source_type: 'manual',
      content_type: 'doc',
      project_tags: ['commercial-opportunity', 'log-engine'],
      metadata: { card_id: v('card_id') },
    };
  }
  if (kind === 'codex') {
    // Submit Actions' Assemble RAG Payload: the generated codex is the document.
    const builder = v('Builder Name') || 'unknown';
    const ts = v('Timestamp') || new Date().toISOString();
    const body = v('Orchestrator Layer2 Review') || v('Summary');
    if (!body.trim()) return null;
    return {
      title: `BHA Codex — ${builder} — ${ts}`,
      content: ['CODEX', `Codex Entry ID: ${v('Codex Entry ID') || 'Not generated'}`, `Timestamp: ${ts}`, `Builder: ${builder}`, 'Source: Bays', 'Flag: Internal/Private Log', '', body].join('\n'),
      source_type: v('Submission Source').toLowerCase() === 'loom' ? 'loom' : 'otter',
      content_type: 'narration',
      project_tags: v('Pillar Tags')
        .split(',')
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean),
      metadata: { codex_entry_id: v('Codex Entry ID') || null, builder_name: builder, session_timestamp: ts, submission_source: v('Submission Source') || 'otter', codex_doc_url: null },
    };
  }
  return null;
}

/**
 * Where a build pattern's Google Doc goes: the folder n8n's
 * `LBP - Create Pattern Doc` wrote into, verbatim (2026-09-24).
 */
export const PATTERN_DOC_FOLDER = '1o_EkaqsC9C1opq1to5mAmt63eUPFn55b';

/* -------------------------------------------------------------- the tools */

const WRITE_ANNOTATIONS = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;

const GUARD_ARGS = {
  dry_run: { type: 'boolean', description: 'Run every guard and return exactly what would be written, without writing.' },
  requester_user_id: { type: 'string', description: 'Slack id of the person asking. Required to change, archive or delete a loop (the Tools Router’s permission rule).' },
};

const listWritableKinds: ToolDefinition = {
  name: 'list_writable_kinds',
  description:
    'Every kind the write tools can write: its table, its natural id field and how an id is minted, the fields required on create, the allowed values of every fixed-vocabulary field (and the values the table actually holds, read live), whether it can be archived or hard-deleted, which BHARAG workspace a create is ingested into and whether that key is set, and every guard that applies. Columns and row counts are read from the database, the rules from the server’s own kind registry — nothing here is written by hand. Call this first.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, title: 'What can be written, and under which rules' },
  handler: async () => {
    const kinds = [];
    for (const spec of Object.values(guards.WRITABLE)) {
      const m = mirror.KINDS[spec.kind];
      const cols = [...(await mirror.columnsOf(spec.kind))].sort();
      const count = await query<{ n: string }>(`SELECT count(*)::text AS n FROM ${m.table}`);
      const held: Record<string, Record<string, number>> = {};
      for (const field of Object.keys(spec.selects)) {
        const r = await query<{ v: string | null; n: string }>(`SELECT fields->>$1 AS v, count(*)::text AS n FROM ${m.table} GROUP BY 1 ORDER BY 2 DESC LIMIT 20`, [field]);
        held[field] = Object.fromEntries(r.rows.map((x) => [x.v ?? '(empty)', Number(x.n)]));
      }
      kinds.push({
        kind: spec.kind,
        table: m.table,
        label: m.label,
        rows: Number(count.rows[0]?.n ?? 0),
        columns: cols,
        natural_id: m.naturalField ? `fields["${m.naturalField}"]` : '"natural_id" in the call, beside fields',
        id_minted: spec.id_minted,
        required_on_create: spec.required,
        allowed_values: spec.selects,
        values_held: held,
        archive: spec.archive ? `sets ${spec.archive.field} = ${spec.archive.value}; the row stays` : 'none — this kind has no archived state a page understands; update its status or delete it',
        hard_delete: spec.deletable ? 'allowed, with confirm "DELETE <natural_id>"' : 'refused for this kind',
        bharag_ingest_on_create: spec.ingest ? { workspace: spec.ingest, key_variable: bharag.INGEST_KEY_VARS[spec.ingest], configured: bharag.ingestConfigured(spec.ingest) } : null,
        extra_arguments: spec.envelope ?? null,
        guards: spec.guards,
      });
    }
    return {
      kinds,
      note: 'Every write goes through the same server function as POST/PATCH /api/engine/:kind and is logged to engine_mcp_writes, refused and dry-run calls included. Kinds not listed here (incidents, pay, the twins’ ledgers, registry tables) are not writable over MCP.',
    };
  },
};

const createRecord: ToolDefinition = {
  name: 'create_record',
  description:
    'Create one record. Runs every guard for the kind first — for loops the lane set, lane-owner gate and duplicate gate the Bays Tools Router runs — and writes nothing if one refuses, returning ok:false with the reason (possible_duplicate, lane_owner_mismatch, missing_required, invalid_value, already_exists) and what to send to proceed. Never overwrites: a natural id already held is refused. On success returns the stored row, its id and natural_id. For codex, patterns and commercial the new record is also ingested into its BHARAG workspace, reported separately as ingested_to_bharag. A pattern also gets its Google Doc (title "Build Pattern -- <pattern_name> -- <drafted_by>", the same text BHARAG receives, in the build patterns Drive folder), reported as doc_created and doc_id — a Doc that fails never undoes the record.',
  inputSchema: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: guards.WRITABLE_KINDS },
      fields: { type: 'object', description: 'Field names exactly as the table stores them, e.g. { "What": "…", "Raised By": "Destiny Arupi", "lane_tag": "BAYS", "Assignee Slack User ID": "U0AEW3TBYH1" } for a loop.' },
      natural_id: { type: 'string', description: 'Only for a kind whose id is not a field (pattern_candidates: CAND-<ms>-<4>). Minted when absent.' },
      builder_id: { type: 'string', description: 'Codex only: whose log it is.' },
      confirmed_new: { type: 'boolean', description: 'The person has confirmed this is not one of the possible duplicates returned.' },
      confirmed_assignee: { type: 'boolean', description: 'The person has confirmed the assignee even though they do not own the lane.' },
      drafted_by: { type: 'string', description: 'Patterns and commercial: who drafted it, for the document title ("Build Pattern -- <pattern_name> -- <drafted_by>"). Default "Bays".' },
      ...GUARD_ARGS,
    },
    required: ['kind', 'fields'],
    additionalProperties: false,
  },
  annotations: { ...WRITE_ANNOTATIONS, title: 'Create a record, behind the Tools Router guards' },
  handler: async (args, deps) => {
    const spec = kindOf(args);
    const fields = fieldsOf(args);
    const dry = b(args, 'dry_run');
    const requester = s(args, 'requester_user_id');
    const audit = await auditOpen({ tool: 'create_record', args, access: deps.access, kind: spec.kind, requester, dry_run: dry });

    const plan = await guards.planCreate(spec.kind, fields, {
      natural_id: s(args, 'natural_id'),
      builder_id: s(args, 'builder_id'),
      confirmed_new: b(args, 'confirmed_new'),
      confirmed_assignee: b(args, 'confirmed_assignee'),
      requester_user_id: requester,
    });
    if (!plan.ok) {
      await auditClose(audit, { outcome: 'refused', detail: `${plan.reason}: ${plan.message}`, guard_result: plan });
      return refused(plan, { audit_id: audit });
    }
    const drafter = s(args, 'drafted_by') ?? 'Bays';
    if (dry) {
      await auditClose(audit, { outcome: 'dry_run', natural_id: plan.natural_id, after: plan.input, guard_result: plan.checks });
      const wouldDoc =
        spec.kind === 'patterns'
          ? { would_create_doc: { folder_id: PATTERN_DOC_FOLDER, title: `Build Pattern -- ${String((plan.input.fields as Record<string, unknown> | undefined)?.pattern_name ?? '')} -- ${drafter}`, google_configured: google.googleConfigured() } }
          : {};
      return { ok: true, dry_run: true, written: false, kind: spec.kind, natural_id: plan.natural_id, would_write: plan.input, ...wouldDoc, checks: plan.checks, audit_id: audit };
    }

    let written: engineWrite.PostResult;
    try {
      written = await engineWrite.postRecord(spec.kind, plan.input, ctxFor('create_record', deps));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await auditClose(audit, { outcome: 'rejected', detail: message, natural_id: plan.natural_id, guard_result: plan.checks });
      return { ok: false, written: false, reason: 'rejected_by_store', message, checks: plan.checks, audit_id: audit };
    }
    const row = await mirror.readRow(spec.kind, written.id);

    let ingest: { attempted: boolean; ok: boolean; detail: string } | null = null;
    if (spec.ingest && row) {
      const doc = documentFor(spec.kind, row.fields, drafter);
      if (!doc) ingest = { attempted: false, ok: false, detail: 'The row carries no text to ingest (no Orchestrator Layer2 Review or Summary), so nothing was sent.' };
      else {
        const r = await bharag.ingest(spec.ingest, doc);
        ingest = { attempted: true, ok: r.ok, detail: r.detail };
      }
    }

    // The pattern's Google Doc: after the save, and never able to undo it.
    let gdoc: { doc_created: boolean; doc_id: string | null; doc_link?: string; doc_error?: string } | null = null;
    if (spec.kind === 'patterns' && row) {
      const doc = documentFor('patterns', row.fields, drafter)!;
      if (!google.googleConfigured()) gdoc = { doc_created: false, doc_id: null, doc_error: google.notConfiguredMessage() };
      else {
        try {
          const d = await google.createDoc(PATTERN_DOC_FOLDER, doc.title, doc.content);
          gdoc = d.content_written
            ? { doc_created: true, doc_id: d.doc_id, doc_link: d.link }
            : { doc_created: false, doc_id: d.doc_id, doc_link: d.link, doc_error: `The Doc was created but its text was not written: ${d.error}` };
        } catch (e) {
          gdoc = { doc_created: false, doc_id: null, doc_error: e instanceof Error ? e.message : String(e) };
        }
      }
    }

    const notes = [
      ingest && !ingest.ok ? 'It is NOT in BHARAG yet — see bharag.detail.' : null,
      gdoc && !gdoc.doc_created ? 'Its Google Doc was NOT made — see doc_error.' : null,
    ].filter(Boolean);
    await auditClose(audit, {
      outcome: written.outcome,
      detail:
        [ingest ? `bharag: ${ingest.ok ? 'ingested' : 'not ingested'} — ${ingest.detail}` : null, gdoc ? `doc: ${gdoc.doc_created ? `created ${gdoc.doc_id}` : `not created — ${gdoc.doc_error}`}` : null]
          .filter(Boolean)
          .join(' | ') || null,
      record_id: written.id,
      natural_id: written.natural_id,
      after: row,
      guard_result: plan.checks,
    });
    return {
      ok: true,
      saved: true,
      ...(ingest ? { ingested_to_bharag: ingest.ok, bharag: ingest } : {}),
      ...(gdoc ?? {}),
      kind: spec.kind,
      id: written.id,
      natural_id: written.natural_id,
      outcome: written.outcome,
      row,
      checks: plan.checks,
      audit_id: audit,
      ...(notes.length ? { note: `The record is saved. ${notes.join(' ')} This is not full success.` } : {}),
    };
  },
};

const updateRecord: ToolDefinition = {
  name: 'update_record',
  description:
    'Change part of one record: only the fields sent change, and a field sent as null is removed. Name the row by id or natural_id. The same merge PATCH /api/engine/:kind/:id does. Loops need requester_user_id and follow the Tools Router’s permission rule (an admin, the assignee, or an unassigned loop); a lane must be one of the locked set. Returns the row before and after.',
  inputSchema: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: guards.WRITABLE_KINDS },
      id: { type: 'string', description: 'The row id the lookup returns.' },
      natural_id: { type: 'string', description: 'The row’s own key (loop_id, pattern_id, CAND-…, Job ID, …).' },
      fields: { type: 'object', description: 'Only the keys to change, e.g. { "Status": "In Progress" }.' },
      ...GUARD_ARGS,
    },
    required: ['kind', 'fields'],
    additionalProperties: false,
  },
  annotations: { ...WRITE_ANNOTATIONS, title: 'Change part of a record' },
  handler: async (args, deps) => {
    const spec = kindOf(args);
    const fields = fieldsOf(args);
    const dry = b(args, 'dry_run');
    const requester = s(args, 'requester_user_id');
    const ctx = ctxFor('update_record', deps);
    const audit = await auditOpen({ tool: 'update_record', args, access: deps.access, kind: spec.kind, requester, dry_run: dry });
    let row: mirror.LookupRow;
    try {
      row = await target(spec.kind, args, ctx);
    } catch (e) {
      await auditClose(audit, { outcome: 'refused', detail: e instanceof Error ? e.message : String(e), natural_id: s(args, 'natural_id') });
      throw e;
    }
    const plan = await guards.planUpdate(spec.kind, row, fields, requester);
    if (!plan.ok) {
      await auditClose(audit, { outcome: 'refused', detail: `${plan.reason}: ${plan.message}`, record_id: row.id, natural_id: row.natural_id, before: row, guard_result: plan });
      return refused(plan, { id: row.id, natural_id: row.natural_id, audit_id: audit });
    }
    if (dry) {
      const preview = { ...row.fields };
      for (const [k, v] of Object.entries(plan.fields)) {
        if (v === null) delete preview[k];
        else preview[k] = v;
      }
      await auditClose(audit, { outcome: 'dry_run', record_id: row.id, natural_id: row.natural_id, before: row, after: { ...row, fields: preview }, guard_result: plan.checks });
      return { ok: true, dry_run: true, written: false, id: row.id, natural_id: row.natural_id, would_merge: plan.fields, fields_after: preview, checks: plan.checks, audit_id: audit };
    }
    try {
      const r = await engineWrite.patchRecord(spec.kind, String(row.id), plan.fields, ctx, s(args, 'natural_id'));
      const after = await mirror.readRow(spec.kind, row.id);
      await auditClose(audit, { outcome: r.changed ? 'updated' : 'unchanged', record_id: row.id, natural_id: row.natural_id, before: row, after, guard_result: plan.checks });
      return { ok: true, saved: true, changed: r.changed, kind: spec.kind, id: row.id, natural_id: row.natural_id, before: row.fields, row: after, checks: plan.checks, audit_id: audit };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await auditClose(audit, { outcome: 'rejected', detail: message, record_id: row.id, natural_id: row.natural_id, before: row, guard_result: plan.checks });
      return { ok: false, written: false, reason: 'rejected_by_store', message, checks: plan.checks, audit_id: audit };
    }
  },
};

const archiveRecord: ToolDefinition = {
  name: 'archive_record',
  description:
    'Soft-delete one record: set the closed state the page already understands and keep the row. For loops that is Status = Closed, behind the same permission rule as an update. A kind with no archived state a page understands is refused rather than given one — list_writable_kinds says which. The reason is recorded on the audit line.',
  inputSchema: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: guards.WRITABLE_KINDS },
      id: { type: 'string' },
      natural_id: { type: 'string' },
      reason: { type: 'string', description: 'Why it is being archived. Required.' },
      ...GUARD_ARGS,
    },
    required: ['kind', 'reason'],
    additionalProperties: false,
  },
  annotations: { ...WRITE_ANNOTATIONS, idempotentHint: true, title: 'Archive a record (the row stays)' },
  handler: async (args, deps) => {
    const spec = kindOf(args);
    const reason = s(args, 'reason');
    if (!reason) throw new McpError('bad_argument', '"reason" is required: why this record is being archived. It is kept on the audit line.');
    const dry = b(args, 'dry_run');
    const requester = s(args, 'requester_user_id');
    const ctx = ctxFor('archive_record', deps);
    const audit = await auditOpen({ tool: 'archive_record', args, access: deps.access, kind: spec.kind, requester, dry_run: dry });
    if (!spec.archive) {
      const r: guards.Refusal = { ok: false, reason: 'not_writable', message: `${spec.kind} has no archived state a page understands, so there is nothing to set. Change its status with update_record, or remove it with delete_record.`, checks: [] };
      await auditClose(audit, { outcome: 'refused', detail: r.message });
      return refused(r, { audit_id: audit });
    }
    let row: mirror.LookupRow;
    try {
      row = await target(spec.kind, args, ctx);
    } catch (e) {
      await auditClose(audit, { outcome: 'refused', detail: e instanceof Error ? e.message : String(e), natural_id: s(args, 'natural_id') });
      throw e;
    }
    const plan = await guards.planUpdate(spec.kind, row, { [spec.archive.field]: spec.archive.value }, requester);
    if (!plan.ok) {
      await auditClose(audit, { outcome: 'refused', detail: `${plan.reason}: ${plan.message}`, record_id: row.id, natural_id: row.natural_id, before: row, guard_result: plan });
      return refused(plan, { id: row.id, natural_id: row.natural_id, audit_id: audit });
    }
    if (dry) {
      await auditClose(audit, { outcome: 'dry_run', detail: reason, record_id: row.id, natural_id: row.natural_id, before: row, guard_result: plan.checks });
      return { ok: true, dry_run: true, written: false, id: row.id, natural_id: row.natural_id, would_set: plan.fields, checks: plan.checks, audit_id: audit };
    }
    const r = await engineWrite.patchRecord(spec.kind, String(row.id), plan.fields, { ...ctx, note: `via MCP archive_record: ${reason}` });
    const after = await mirror.readRow(spec.kind, row.id);
    await auditClose(audit, { outcome: r.changed ? 'archived' : 'unchanged', detail: reason, record_id: row.id, natural_id: row.natural_id, before: row, after, guard_result: plan.checks });
    return { ok: true, saved: true, archived: true, changed: r.changed, kind: spec.kind, id: row.id, natural_id: row.natural_id, row: after, audit_id: audit };
  },
};

const deleteRecord: ToolDefinition = {
  name: 'delete_record',
  description:
    'Hard-delete one record. Refused unless "confirm" is exactly "DELETE <natural_id>" (or "DELETE <id>" for a row with no natural id), and refused outright for kinds that cannot be deleted (codex; pay and ledger kinds are not writable at all). rt-asks is delete-only: removable here, never created or edited over MCP. The whole row is kept in record_deletions before it goes. Prefer archive_record where the kind has an archived state.',
  inputSchema: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: guards.DELETABLE_KINDS },
      id: { type: 'string' },
      natural_id: { type: 'string' },
      confirm: { type: 'string', description: 'Exactly "DELETE <natural_id>".' },
      reason: { type: 'string', description: 'Why. Required; kept on the deletion log and the audit line.' },
      ...GUARD_ARGS,
    },
    required: ['kind', 'confirm', 'reason'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true, title: 'Hard-delete a record (confirmed by its id)' },
  handler: async (args, deps) => {
    const spec = deletableKindOf(args);
    const reason = s(args, 'reason');
    if (!reason) throw new McpError('bad_argument', '"reason" is required: why this record is being deleted. It is kept with the row in record_deletions.');
    const dry = b(args, 'dry_run');
    const requester = s(args, 'requester_user_id');
    const ctx = ctxFor('delete_record', deps);
    const audit = await auditOpen({ tool: 'delete_record', args, access: deps.access, kind: spec.kind, requester, dry_run: dry });
    if (!spec.deletable) {
      const r: guards.Refusal = { ok: false, reason: 'not_writable', message: `${spec.kind} cannot be hard-deleted over MCP. A Codex entry is removed only from the Codex page, confirmed by typing its id back, where the whole flow is.`, checks: [] };
      await auditClose(audit, { outcome: 'refused', detail: r.message });
      return refused(r, { audit_id: audit });
    }
    let row: mirror.LookupRow;
    try {
      row = await target(spec.kind, args, ctx);
    } catch (e) {
      await auditClose(audit, { outcome: 'refused', detail: e instanceof Error ? e.message : String(e), natural_id: s(args, 'natural_id') });
      throw e;
    }
    const expected = `DELETE ${row.natural_id ?? row.id}`;
    const checks: guards.Check[] = [];
    if (s(args, 'confirm') !== expected) {
      checks.push({ guard: 'confirm', result: 'fail' });
      const r: guards.Refusal = { ok: false, reason: 'bad_request', message: `"confirm" must be exactly "${expected}". Nothing was deleted.`, checks };
      await auditClose(audit, { outcome: 'refused', detail: r.message, record_id: row.id, natural_id: row.natural_id, before: row });
      return refused(r, { audit_id: audit });
    }
    checks.push({ guard: 'confirm', result: 'pass' });
    if (spec.kind === 'loops') {
      const denied = guards.loopPermission(row, requester, checks);
      if (denied) {
        await auditClose(audit, { outcome: 'refused', detail: denied.message, record_id: row.id, natural_id: row.natural_id, before: row, guard_result: denied });
        return refused(denied, { audit_id: audit });
      }
    }
    if (dry) {
      await auditClose(audit, { outcome: 'dry_run', detail: reason, record_id: row.id, natural_id: row.natural_id, before: row, guard_result: checks });
      return { ok: true, dry_run: true, written: false, would_delete: row, checks, audit_id: audit };
    }
    const gone = await mirror.deleteRow(spec.kind, row.id, reason, `mcp:${deps.access}${requester ? `:${requester}` : ''}`);
    await mirror.logWrite({ endpoint: ctx.endpoint, kind: spec.kind, method: ctx.method, key_label: ctx.key_label, airtable_record_id: row.airtable_record_id, natural_id: row.natural_id, outcome: 'deleted', detail: `row ${row.id} deleted via MCP: ${reason}` });
    await auditClose(audit, { outcome: gone ? 'deleted' : 'not_found', detail: reason, record_id: row.id, natural_id: row.natural_id, before: row, after: null, guard_result: checks });
    return { ok: Boolean(gone), deleted: Boolean(gone), kind: spec.kind, id: row.id, natural_id: row.natural_id, kept_in: 'record_deletions', audit_id: audit };
  },
};

export const WRITE_TOOLS: ToolDefinition[] = [listWritableKinds, createRecord, updateRecord, archiveRecord, deleteRecord];
