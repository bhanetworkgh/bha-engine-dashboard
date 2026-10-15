/**
 * Fill and send Form 2 for a test lead from here (2026-10-15, Destiny: "that form is too long,
 * please test it from the dashboard somehow").
 *
 *   test_submit_intake2 — write connection only, in no agent's scope. Builds one valid answer
 *                         for every one of the 31 questions from the field list itself
 *                         (src/data/intake2.ts), so it can never drift from the form, and sends
 *                         them through intake2.submit — the function the buyer's own link calls.
 *                         So the test is the real path: the answers land on the lead, the event is
 *                         written, #vfarm-early-access gets its post and the buyer the receipt.
 *
 * Guards: Destiny or Jason only; **a lead whose email is not an @bhanetwork.org address is
 * refused**, so a real buyer's form can never be filled from here; the lead must be in Stage 2
 * with a Form 2 link; confirm must be exactly "SUBMIT TEST <buyer_intake_id>". Every answer
 * starts "TEST" where the field takes free text. `with_file: true` also uploads one small PDF to
 * question 5 through the link's own upload, which proves the Drive folder. dry_run checks the
 * answers against the form's own validation and writes nothing. Audited on engine_mcp_writes.
 */
import { query } from '../pg';
import * as intake2 from '../intake2';
import { INTAKE2_FIELDS, type Intake2Field } from '../../../src/data/intake2';
import { ADMIN_IDS } from '../writeGuards';
import { auditClose, auditOpen } from './writeTools';
import type { ToolDefinition } from './tools';

/** One valid answer per question, in the shape the form posts. Exported for the test. */
export function sampleAnswers(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of INTAKE2_FIELDS as readonly Intake2Field[]) {
    switch (f.kind) {
      case 'longtext':
        out[f.id] = `TEST answer for "${f.label}"`;
        break;
      case 'integer':
        out[f.id] = String(Math.max(1, f.min));
        break;
      case 'select': {
        const choice = f.options[0];
        const wantsDetail = f.detail && (!f.detail.when || f.detail.when === choice);
        out[f.id] = wantsDetail ? { choice, detail: `TEST ${f.detail!.label}` } : { choice };
        break;
      }
      case 'multi':
        out[f.id] = f.detail && !f.detail.when ? { choices: [f.options[0]], detail: `TEST ${f.detail.label}` } : { choices: [f.options[0]] };
        break;
      case 'group': {
        const g: Record<string, unknown> = {};
        for (const p of f.parts) {
          if (p.kind === 'number') g[p.key] = '1';
          else if (p.kind === 'select') g[p.key] = (p.options ?? [])[0];
          else if (p.kind === 'multi') g[p.key] = [(p.options ?? [])[0]];
          else if (p.kind === 'month') g[p.key] = '2026-12';
          else g[p.key] = `TEST ${p.label}`;
        }
        out[f.id] = g;
        break;
      }
      case 'file':
        break;
    }
  }
  return out;
}

/** A one-page PDF, small enough to read in a text editor. */
function tinyPdf(): Buffer {
  const objs = [
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj',
    '4 0 obj<</Length 52>>stream\nBT /F1 12 Tf 20 50 Td (TEST site sketch) Tj ET\nendstream endobj',
    '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj',
  ];
  let body = '%PDF-1.4\n';
  const offs: number[] = [];
  for (const o of objs) {
    offs.push(Buffer.byteLength(body));
    body += o + '\n';
  }
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

export const testSubmitIntake2Tool: ToolDefinition = {
  name: 'test_submit_intake2',
  description:
    'Fill Form 2 (the 31-question site and deployment specification) for a TEST lead and send it through the buyer link\'s own submit, so the whole path runs for real: answers on the lead, the completed event, the #vfarm-early-access post and the buyer\'s receipt email. One valid answer per question is built from the form\'s own field list, free text starting "TEST". Only Destiny or Jason; only a lead whose email is an @bhanetwork.org address (a real buyer is refused); the lead must be in Stage 2 with a Form 2 link. lead: the lead\'s row id or its buyer_intake_id (VFBUYER-…). confirm: exactly "SUBMIT TEST <buyer_intake_id>". with_file: also upload a one-page test PDF to question 5 through the link. dry_run: validate the answers and write nothing. A second call with the same answers is a retry (already: true). Audited on engine_mcp_writes.',
  inputSchema: {
    type: 'object',
    properties: {
      lead: { type: 'string', description: 'The lead row id, or its buyer_intake_id (VFBUYER-…).' },
      requester_user_id: { type: 'string', description: 'Destiny or Jason.' },
      confirm: { type: 'string', description: 'Exactly "SUBMIT TEST <buyer_intake_id>".' },
      with_file: { type: 'boolean', description: 'Also upload one small test PDF to question 5.' },
      dry_run: { type: 'boolean' },
    },
    required: ['lead', 'requester_user_id'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true, title: 'Send a test Form 2' },
  handler: async (args, deps) => {
    const requester = typeof args.requester_user_id === 'string' ? args.requester_user_id.trim() : null;
    const dry = args.dry_run === true;
    const audit = await auditOpen({ tool: 'test_submit_intake2', args, access: deps.access, kind: 'vfarm_leads', requester, dry_run: dry });
    const refuse = async (reason: string, message: string) => {
      await auditClose(audit, { outcome: 'refused', detail: `${reason}: ${message}`, guard_result: { reason } });
      return { ok: false, submitted: false, reason, message: `${message} Nothing was sent.`, audit_id: audit };
    };
    if (!requester || !ADMIN_IDS.includes(requester)) return refuse('not_permitted', 'Only Destiny or Jason can send a test Form 2.');
    const ref = typeof args.lead === 'string' ? args.lead.trim() : '';
    const r = await query<{ id: string; email: string | null; stage: number | null; buyer: string | null; invite_id: string | null; done: boolean }>(
      `SELECT id::text, email, stage, form_a->>'buyer_intake_id' AS buyer, intake_2_invite->>'invite_id' AS invite_id, intake_2 IS NOT NULL AS done
         FROM engine_vfarm_leads WHERE id::text = $1 OR form_a->>'buyer_intake_id' = $1`,
      [ref],
    );
    if (r.rows.length !== 1) return refuse('not_found', r.rows.length ? `"${ref}" names ${r.rows.length} leads.` : `No lead "${ref}" is held.`);
    const lead = r.rows[0];
    if (!/@bhanetwork\.org$/i.test(lead.email ?? '')) return refuse('not_a_test_lead', `This lead's email is not an @bhanetwork.org address, so it may be a real buyer. Test Form 2 only on a team test lead.`);
    if (lead.stage !== 2 || !lead.invite_id || !lead.buyer) return refuse('no_form_2_link', 'The lead is not in Stage 2 with a Form 2 link. Move it to Stage 2 first, which sends the invite.');
    const answers = sampleAnswers();
    const v = intake2.validate(answers, []);
    if (v.errors.length) {
      await auditClose(audit, { outcome: 'error', detail: `the built answers failed the form's own validation: ${JSON.stringify(v.errors).slice(0, 800)}` });
      return { ok: false, submitted: false, reason: 'built_answers_invalid', errors: v.errors, audit_id: audit };
    }
    if (dry) {
      await auditClose(audit, { outcome: 'dry_run', record_id: lead.id, natural_id: lead.buyer });
      return { ok: true, dry_run: true, lead: lead.id, buyer_intake_id: lead.buyer, already_submitted: lead.done, questions_answered: Object.keys(v.answers).length, of: INTAKE2_FIELDS.length, audit_id: audit };
    }
    if (args.confirm !== `SUBMIT TEST ${lead.buyer}`) return refuse('confirm_required', `Send confirm: "SUBMIT TEST ${lead.buyer}".`);
    const token = intake2.tokenFor(lead.invite_id);
    let file: Record<string, unknown> | null = null;
    try {
      if (args.with_file === true && !lead.done) {
        const up = await intake2.upload(token, 5, 'TEST-site-sketch.pdf', 'application/pdf', tinyPdf());
        (answers as Record<string, unknown>)[INTAKE2_FIELDS.find((f) => f.n === 5)!.id] = [up.file_id];
        file = { uploaded: true, file_id: up.file_id, link: up.link ?? null };
      }
      const out = await intake2.submit(token, { answers }, 'mcp:test_submit_intake2');
      const after = await query<{ notified: unknown; receipt: unknown }>(
        `SELECT intake_2->'notified' AS notified, intake_2->'confirmation_email' AS receipt FROM engine_vfarm_leads WHERE id = $1`,
        [lead.id],
      );
      const result = { ok: true, submitted: !out.already, already: out.already, submission_id: out.submission_id, submitted_at: out.submitted_at, lead: lead.id, buyer_intake_id: lead.buyer, file, channel_post: after.rows[0]?.notified ?? null, receipt_email: after.rows[0]?.receipt ?? null };
      await auditClose(audit, { outcome: out.already ? 'unchanged' : 'applied', record_id: lead.id, natural_id: lead.buyer, after: result });
      return { ...result, audit_id: audit };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const errors = e instanceof intake2.Intake2Error ? (e as unknown as { errors?: unknown }).errors : undefined;
      await auditClose(audit, { outcome: 'error', detail: message, record_id: lead.id, natural_id: lead.buyer });
      return { ok: false, submitted: false, reason: 'submit_failed', message, errors, file, audit_id: audit };
    }
  },
};

export const INTAKE2_WRITE_TOOLS: ToolDefinition[] = [testSubmitIntake2Tool];
