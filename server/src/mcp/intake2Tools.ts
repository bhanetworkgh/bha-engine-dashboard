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

/**
 * Walk a TEST lead through buyer flow v2 from here (2026-10-17, Destiny: "build a tool that lets
 * you do the full test, the moving and filling").
 *
 *   test_buyer_flow — write connection only, in no agent's scope. One step per call, each through
 *                     the same function the dashboard or the buyer's page calls, so the test is the
 *                     real path: `move` is earlyAccess.moveStage with its gates, `propose` is
 *                     proposal.create, and `buyer_open` / `buyer_accept` / `buyer_question` /
 *                     `buyer_call` are proposal.page and proposal.act on the lead's own proposal
 *                     link (worked out here, never sent back in full). `status` reads.
 *
 * Guards as test_submit_intake2: Destiny or Jason only; **only a lead whose email is an
 * @bhanetwork.org address**; every step but status and dry_run needs confirm exactly
 * "TEST FLOW <buyer_intake_id>". Audited on engine_mcp_writes, refusals included.
 */
import * as earlyAccess from '../earlyAccess';
import * as proposalMod from '../proposal';

type FlowStep = 'status' | 'move' | 'propose' | 'buyer_open' | 'buyer_accept' | 'buyer_question' | 'buyer_call';
const FLOW_STEPS: FlowStep[] = ['status', 'move', 'propose', 'buyer_open', 'buyer_accept', 'buyer_question', 'buyer_call'];

async function flowState(id: string): Promise<Record<string, unknown>> {
  const r = await query<{ stage: number; closed_at: Date | null; form2: boolean; proposal: proposalMod.Proposal | null; pay: Record<string, unknown> | null; history: unknown }>(
    `SELECT stage, closed_at, intake_2 IS NOT NULL AS form2, proposal, stripe_payment AS pay, stage_history AS history FROM engine_vfarm_leads WHERE id::text = $1`,
    [id],
  );
  const row = r.rows[0];
  if (!row) return { found: false };
  const p = row.proposal;
  return {
    stage: row.stage,
    closed: !!row.closed_at,
    form_2_in: row.form2,
    proposal: p ? { proposal_id: p.proposal_id, test: p.test, setup_name: p.setup_name, price_amount: p.price_amount, currency: p.currency, opened_at: p.opened_at, accepted_at: p.accepted_at, actions: p.actions.map((a) => ({ kind: a.kind, at: a.at, text: a.text, posted: !!a.notified?.ts, post_error: a.notified?.error ?? null })) } : null,
    stripe_payment: row.pay ? { state: row.pay.state, mode: row.pay.mode, amount: row.pay.amount, currency: row.pay.currency } : null,
    last_moves: Array.isArray(row.history) ? (row.history as unknown[]).slice(-3) : [],
  };
}

export const testBuyerFlowTool: ToolDefinition = {
  name: 'test_buyer_flow',
  description:
    'Walk a TEST lead through vFarm buyer flow v2, one step per call, through the real functions: move (to stage 1-5, with the dashboard\'s own gates: 3 needs Form 2, 4 an accepted proposal, 5 a paid payment), propose (make or replace the Stage 3 proposal, always a test), buyer_open (open the buyer\'s proposal page as they would), buyer_accept, buyer_question (needs text), buyer_call (text optional) — the buyer\'s own page actions on their own link — and status. Only Destiny or Jason; only a lead whose email is @bhanetwork.org. Every step but status needs confirm exactly "TEST FLOW <buyer_intake_id>". dry_run says what would run and changes nothing. Audited on engine_mcp_writes.',
  inputSchema: {
    type: 'object',
    properties: {
      lead: { type: 'string', description: 'The lead row id, or its buyer_intake_id (VFBUYER-…).' },
      step: { type: 'string', enum: FLOW_STEPS },
      requester_user_id: { type: 'string', description: 'Destiny or Jason.' },
      confirm: { type: 'string', description: 'Exactly "TEST FLOW <buyer_intake_id>".' },
      to_stage: { type: 'number', description: 'move: the stage to move to, 1 to 5.' },
      reason: { type: 'string', description: 'move: why (for example "five checks cleared").' },
      proposal: {
        type: 'object',
        description: 'propose: setup_name, summary, inclusions (array), price_amount (cents), currency, timeline.',
        properties: {
          setup_name: { type: 'string' },
          summary: { type: 'string' },
          inclusions: { type: 'array', items: { type: 'string' } },
          price_amount: { type: 'number' },
          currency: { type: 'string' },
          timeline: { type: 'string' },
        },
      },
      text: { type: 'string', description: 'buyer_question / buyer_call: what the buyer writes.' },
      dry_run: { type: 'boolean' },
    },
    required: ['lead', 'step', 'requester_user_id'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true, title: 'Walk a test lead through the buyer flow' },
  handler: async (args, deps) => {
    const requester = typeof args.requester_user_id === 'string' ? args.requester_user_id.trim() : null;
    const step = String(args.step ?? '') as FlowStep;
    const dry = args.dry_run === true || step === 'status';
    const audit = await auditOpen({ tool: 'test_buyer_flow', args, access: deps.access, kind: 'vfarm_leads', requester, dry_run: dry });
    const refuse = async (reason: string, message: string, extra: Record<string, unknown> = {}) => {
      await auditClose(audit, { outcome: 'refused', detail: `${reason}: ${message}`, guard_result: { reason } });
      return { ok: false, reason, message: `${message} Nothing changed.`, ...extra, audit_id: audit };
    };
    if (!requester || !ADMIN_IDS.includes(requester)) return refuse('not_permitted', 'Only Destiny or Jason can run a test buyer flow.');
    if (!FLOW_STEPS.includes(step)) return refuse('bad_step', `step is one of ${FLOW_STEPS.join(', ')}.`);
    const ref = typeof args.lead === 'string' ? args.lead.trim() : '';
    const r = await query<{ id: string; email: string | null; buyer: string | null; name: string }>(
      `SELECT id::text, email, form_a->>'buyer_intake_id' AS buyer, full_name AS name FROM engine_vfarm_leads WHERE id::text = $1 OR form_a->>'buyer_intake_id' = $1`,
      [ref],
    );
    if (r.rows.length !== 1) return refuse('not_found', r.rows.length ? `"${ref}" names ${r.rows.length} leads.` : `No lead "${ref}" is held.`);
    const lead = r.rows[0];
    if (!/@bhanetwork\.org$/i.test(lead.email ?? '')) return refuse('not_a_test_lead', "This lead's email is not an @bhanetwork.org address, so it may be a real buyer. Run the test flow only on a team test lead.");
    const before = await flowState(lead.id);
    if (dry) {
      await auditClose(audit, { outcome: 'dry_run', record_id: lead.id, natural_id: lead.buyer, before });
      return { ok: true, dry_run: true, step, lead: lead.id, buyer_intake_id: lead.buyer, state: before, audit_id: audit };
    }
    if (args.confirm !== `TEST FLOW ${lead.buyer ?? lead.id}`) return refuse('confirm_required', `Send confirm: "TEST FLOW ${lead.buyer ?? lead.id}".`);
    const who = requester === ADMIN_IDS[0] ? 'Destiny (test_buyer_flow)' : 'Jason (test_buyer_flow)';
    try {
      let detail: Record<string, unknown> = {};
      if (step === 'move') {
        const to = Number(args.to_stage);
        await earlyAccess.moveStage({ id: lead.id }, to, who, typeof args.reason === 'string' ? args.reason : null, 'engine');
        detail = { moved_to: to };
      } else if (step === 'propose') {
        const made = await proposalMod.create(lead.id, (args.proposal ?? {}) as proposalMod.ProposalInput, who);
        detail = { proposal_id: made.proposal?.proposal_id, replaced: made.replaced, link_made: !!made.proposal?.link && made.proposal.link.startsWith('http') };
      } else {
        const st = before.proposal as { proposal_id: string } | null;
        if (!st) return refuse('no_proposal', 'This lead has no proposal yet. Run step propose first.');
        const token = proposalMod.tokenFor(st.proposal_id);
        if (step === 'buyer_open') {
          const html = await proposalMod.page(token);
          if (!html) return refuse('link_opens_nothing', 'The proposal link opened nothing (closed lead or replaced proposal).');
          detail = { page_opened: true, says_test: html.includes('Test proposal'), shows_payment: /stripe|checkout/i.test(html), bytes: html.length };
        } else {
          const kind = step === 'buyer_accept' ? 'accept' : step === 'buyer_question' ? 'question' : 'call';
          const out = await proposalMod.act(token, kind, typeof args.text === 'string' ? args.text : null);
          if (!out) return refuse('link_opens_nothing', 'The proposal link opened nothing.');
          detail = { buyer_saw: out.flash };
        }
      }
      const after = await flowState(lead.id);
      await auditClose(audit, { outcome: 'applied', record_id: lead.id, natural_id: lead.buyer, before, after: { ...detail, state: after } });
      return { ok: true, step, lead: lead.id, buyer_intake_id: lead.buyer, ...detail, state: after, audit_id: audit };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const status = (e as { status?: number }).status;
      await auditClose(audit, { outcome: status && status < 500 ? 'refused' : 'error', detail: message, record_id: lead.id, natural_id: lead.buyer });
      return { ok: false, step, reason: status && status < 500 ? 'refused_by_the_flow' : 'error', message, state: before, audit_id: audit };
    }
  },
};

INTAKE2_WRITE_TOOLS.push(testBuyerFlowTool);
