/**
 * move_buyer_to_form_2 (2 Nov 2026, Destiny): a real vFarm buyer moved from Stage 1 (Form A,
 * interest) to Stage 2 (site specification), which emails them their own Form 2 link.
 *
 * Until now the only way to move a real buyer was the button on the Early Access page:
 * `test_buyer_flow` refuses any lead without an @bhanetwork.org address, and Bays had nothing.
 * Jason asked (#bha-coordination 1793564121.914979) for Shibu's two Form A leads to go to Form 2.
 *
 * - **One move only**: Stage 1 to Stage 2, through `earlyAccess.moveStage`, the page's own function,
 *   so the event, the stage history and the invite email are the page's. Every other stage move
 *   stays on the page, and the buyer-side steps of `test_buyer_flow` stay test-only.
 * - **Jason or Destiny only** (`ADMIN_IDS`), a reason of 3 to 1,000 characters.
 * - **On an agent token it waits for a person**: one of `GATED_TOOLS`, so Bays posts an Approve /
 *   Deny card and moves nothing. The card always goes to #bha-engine-alerts (`ALERTS_ONLY_TOOLS`),
 *   naming the buyer's first name and organisation so the approver can see it is the right lead;
 *   the thread it was asked in is told the outcome. On the connector a person is already acting,
 *   so it moves at once.
 * - **The lead is named by buyer_intake_id, or by words** (a first name or an organisation). Words
 *   that match more than one open Stage 1 lead are refused with each match's buyer_intake_id and
 *   organisation, never a pick.
 * - Audited on `engine_mcp_writes`, kind `vfarm_leads`.
 */
import { query, withTransaction } from '../pg';
import * as events from '../events';
import * as earlyAccess from '../earlyAccess';
import * as approvals from '../approvals';
import { ADMIN_IDS } from '../writeGuards';
import { auditClose, auditOpen } from './writeTools';
import type { ToolDefinition } from './tools';

interface Match {
  id: string;
  buyer: string | null;
  full_name: string | null;
  organization_name: string | null;
  stage: number;
  closed_at: Date | null;
  team_test: boolean;
}

const firstName = (n: string | null) => (n || '').trim().split(/\s+/)[0] || 'not given';
const label = (m: Match) => `${firstName(m.full_name)} (${m.organization_name?.trim() || 'no organisation given'}), ${m.buyer ?? m.id}`;

/** Finds the lead. Exported for the test. */
export async function findLead(ref: string): Promise<{ ok: true; lead: Match } | { ok: false; reason: string; message: string; candidates?: string[] }> {
  const cols = `id::text, form_a->>'buyer_intake_id' AS buyer, full_name, organization_name, stage, closed_at, ${earlyAccess.TEAM_TEST_SQL} AS team_test`;
  if (/^VFBUYER-/i.test(ref) || /^[0-9a-f-]{36}$/i.test(ref)) {
    const r = await query<Match>(`SELECT ${cols} FROM engine_vfarm_leads WHERE form_a->>'buyer_intake_id' = $1 OR id::text = $1`, [ref]);
    if (!r.rows.length) return { ok: false, reason: 'not_found', message: `No lead is held as "${ref}".` };
    if (r.rows.length > 1) return { ok: false, reason: 'ambiguous', message: `"${ref}" names ${r.rows.length} leads.`, candidates: r.rows.map(label) };
    return { ok: true, lead: r.rows[0] };
  }
  const words = ref.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  if (!words.length) return { ok: false, reason: 'no_lead_named', message: 'Name the lead by its buyer_intake_id (VFBUYER-…), a first name or an organisation.' };
  const r = await query<Match>(
    `SELECT ${cols} FROM engine_vfarm_leads
      WHERE closed_at IS NULL AND stage = 1
        AND ${words.map((_, i) => `strpos(lower(COALESCE(full_name, '') || ' ' || COALESCE(organization_name, '')), $${i + 1}) > 0`).join(' AND ')}
      ORDER BY created_at`,
    words,
  );
  if (!r.rows.length) return { ok: false, reason: 'not_found', message: `No open Stage 1 lead matches "${ref}".` };
  if (r.rows.length > 1) return { ok: false, reason: 'ambiguous', message: `"${ref}" matches ${r.rows.length} open Stage 1 leads. Name one by its buyer_intake_id.`, candidates: r.rows.map(label) };
  return { ok: true, lead: r.rows[0] };
}

export const moveBuyerToForm2Tool: ToolDefinition = {
  name: 'move_buyer_to_form_2',
  description:
    'Move a real vFarm buyer from Stage 1 (Form A, interest) to Stage 2 (site specification), which emails them their own Form 2 link. Only this one move. Only Jason or Destiny may ask (requester_user_id), with a reason. lead: the buyer_intake_id (VFBUYER-…), or words from their name or organisation; words matching more than one open Stage 1 lead are refused with the candidates. On Bays\' token nothing moves straight away: an Approve / Deny card is posted in #bha-engine-alerts showing the buyer\'s first name, organisation and id, and the lead moves only when Jason or Destiny presses Approve (pass channel_id and thread_ts so the thread hears the outcome). Tell the person it is waiting and link the card. dry_run says who would move and changes nothing. Audited on engine_mcp_writes.',
  inputSchema: {
    type: 'object',
    properties: {
      lead: { type: 'string', description: 'buyer_intake_id (VFBUYER-…), or a first name or organisation.' },
      requester_user_id: { type: 'string', description: 'Slack id of the person asking: Jason or Destiny.' },
      reason: { type: 'string', description: 'Why, in a sentence (3 to 1,000 characters).' },
      channel_id: { type: 'string', description: 'Where it was asked, so the outcome is posted back there.' },
      thread_ts: { type: 'string', description: 'The thread it was asked in.' },
      dry_run: { type: 'boolean' },
    },
    required: ['lead', 'requester_user_id', 'reason'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true, title: 'Move a buyer to Form 2' },
  handler: async (args, deps) => {
    const requester = typeof args.requester_user_id === 'string' ? args.requester_user_id.trim() : null;
    const dry = args.dry_run === true;
    const ref = typeof args.lead === 'string' ? args.lead.trim() : '';
    const reason = typeof args.reason === 'string' ? args.reason.trim() : '';
    const audit = await auditOpen({ tool: 'move_buyer_to_form_2', args, access: deps.access, kind: 'vfarm_leads', requester, dry_run: dry });
    const refuse = async (why: string, message: string, extra: Record<string, unknown> = {}) => {
      await auditClose(audit, { outcome: 'refused', detail: `${why}: ${message}`, guard_result: { reason: why } });
      return { ok: false, moved: false, reason: why, message: `${message} Nothing was moved.`, ...extra, audit_id: audit };
    };
    if (!requester || !ADMIN_IDS.includes(requester)) return refuse('not_permitted', 'Only Jason or Destiny can move a buyer to Form 2.');
    if (reason.length < 3 || reason.length > 1000) return refuse('reason_required', 'Give a reason of 3 to 1,000 characters.');
    if (!ref) return refuse('no_lead_named', 'Name the lead by its buyer_intake_id, a first name or an organisation.');

    const found = await findLead(ref);
    if (!found.ok) return refuse(found.reason, found.message, found.candidates ? { candidates: found.candidates } : {});
    const lead = found.lead;
    const who = label(lead);
    if (lead.closed_at) return refuse('closed', `${who} is closed. Reopen it on the Early Access page first.`);
    if (lead.stage !== 1) return refuse('not_stage_1', `${who} is in Stage ${lead.stage}, not Stage 1. This tool only moves Stage 1 to Stage 2.`);
    if (!lead.buyer) return refuse('no_buyer_intake_id', `${who} has no buyer_intake_id, so no Form 2 link can be made for it.`);

    if (dry) {
      await auditClose(audit, { outcome: 'dry_run', detail: `would move ${who} to Stage 2`, record_id: lead.id, natural_id: lead.buyer });
      return { ok: true, dry_run: true, would: { buyer_intake_id: lead.buyer, first_name: firstName(lead.full_name), organisation: lead.organization_name, from: 1, to: 2, sends: 'the Form 2 link by email' }, team_test: lead.team_test, audit_id: audit };
    }

    if (approvals.needsApproval()) {
      const asked = approvals.pendingAnswer(
        await approvals.request({
          tool: 'move_buyer_to_form_2',
          args: { ...args, lead: lead.buyer },
          target: lead.buyer,
          summary: `move ${who} from Stage 1 (Form A) to Stage 2 (site specification), which emails them their Form 2 link. Reason given: ${reason}`,
        }),
      );
      await auditClose(audit, { outcome: asked.outcome, detail: asked.detail, record_id: lead.id, natural_id: lead.buyer });
      return { ...asked.answer, buyer_intake_id: lead.buyer, audit_id: audit };
    }

    const approval = approvals.currentApproval();
    const by = approval ? `${approval.approver} (approved ${approval.approval_id}, move_buyer_to_form_2)` : `${requester} (move_buyer_to_form_2)`;
    try {
      const moved = await earlyAccess.moveStage({ id: lead.id }, 2, by, reason, 'engine');
      // The link is the buyer's key to their form: it never goes into an answer an agent may post.
      const raw = moved.intake_2_invite_result ?? null;
      const invite = raw ? { ok: raw.ok, reason: raw.reason, message: raw.message, invite_id: raw.invite_id ?? null } : null;
      const sent = invite !== null && invite.ok === true;
      await auditClose(audit, {
        outcome: sent ? 'applied' : 'applied_with_errors',
        detail: `moved ${who} to Stage 2; Form 2 link ${sent ? 'sent' : `not sent: ${invite ? invite.message : 'no invite outcome'}`}`,
        record_id: lead.id,
        natural_id: lead.buyer,
        before: { stage: 1 },
        after: { stage: 2, invite },
      });
      return {
        ok: sent,
        moved: true,
        buyer_intake_id: lead.buyer,
        stage: 2,
        form_2_link_sent: sent,
        invite,
        ...(sent ? {} : { raise: true, message: 'The lead is in Stage 2, but the Form 2 link did not go out. Send it from the lead panel on the Early Access page (Send invite).' }),
        audit_id: audit,
      };
    } catch (e) {
      const status = (e as { status?: number }).status;
      const message = e instanceof Error ? e.message : String(e);
      await auditClose(audit, { outcome: status && status < 500 ? 'refused' : 'failed', detail: message, record_id: lead.id, natural_id: lead.buyer });
      return { ok: false, moved: false, reason: status && status < 500 ? 'refused_by_the_flow' : 'error', message, ...(status && status < 500 ? {} : { raise: true }), audit_id: audit };
    }
  },
};

/**
 * team_test_lead (2 Nov 2026, Destiny): a team test lead made and removed from here, so the live flow can be
 * proven end to end and then leave no trace. `create` sends a whole Form A through `earlyAccess.storeFormA`,
 * the function the website's Form A reaches, under an @bhanetwork.org address (the engine's team-test rule,
 * so it can never count as a buyer). `delete` copies the row whole into record_deletions and removes it, in
 * one transaction, and only ever a team lead. Jason or Destiny only, each with its own confirm. Not in any
 * agent's scope.
 */
const TEST_ANSWERS = (name: string, email: string, org: string): Record<string, unknown> => ({
  'Full name': name,
  'Email address': email,
  'Organization / household name': org,
  City: 'Lagos',
  'State / Province / Region': 'Lagos',
  Country: 'Nigeria',
  'Which best describes you or your organization?': 'Commercial operator',
  'What is your primary use case for vFarm?': 'Restaurant / food service',
  'What would you like vFarm to help you accomplish?': 'Team test of the live Stage 1 to Stage 2 move. Not a buyer.',
  'What type of environment would the first vFarm most likely operate in? ': 'Indoor commercial',
  'Do you have an indoor or protected space available?': 'Yes',
  'Approximately how much space could you make available?': 'Larger than 4 ft × 6 ft',
  'Is electrical power available near the potential installation area?': 'Yes',
  'Is a water source available near the potential installation area?': 'Yes',
  'How would you most want to monitor or interact with your vFarm?': 'On-unit kiosk / display',
  'When could you realistically consider a vFarm pilot or purchase?': 'Ready to discuss within the next 3 months',
  'Which best describes your current budget readiness?': 'Ready to discuss a paid pilot',
  'How serious is your interest in becoming an early vFarm buyer or pilot partner? ': 5,
  'Would you be willing to provide structured feedback during an Early Access pilot?': 'Yes',
  'Would you consider a small Early Access reservation commitment in exchange for priority consideration as pilot units become available?': 'Yes',
  'How did you hear about vFarm?': 'Bays Horizon team',
});

export const teamTestLeadTool: ToolDefinition = {
  name: 'team_test_lead',
  description:
    'Make or remove a TEAM TEST vFarm lead, to prove the live buyer flow and then clean up. action "create": a whole Form A through the same function the website\'s Form A reaches, at Stage 1, under an @bhanetwork.org email (the engine\'s team-test rule, so it never counts as a buyer); confirm exactly "CREATE TEST LEAD". action "delete": the lead copied whole into record_deletions and removed, only ever an @bhanetwork.org lead; confirm exactly "DELETE <buyer_intake_id>". Jason or Destiny only. dry_run changes nothing. Audited on engine_mcp_writes.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['create', 'delete'] },
      requester_user_id: { type: 'string', description: 'Destiny or Jason.' },
      email: { type: 'string', description: 'create: an @bhanetwork.org address the Form 2 email may go to.' },
      name: { type: 'string', description: 'create: full name. Default "Destiny Arupi".' },
      organisation: { type: 'string', description: 'create: default "BHA Test".' },
      lead: { type: 'string', description: 'delete: the buyer_intake_id.' },
      reason: { type: 'string', description: 'delete: why (3 to 1,000 characters).' },
      confirm: { type: 'string' },
      dry_run: { type: 'boolean' },
    },
    required: ['action', 'requester_user_id'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false, title: 'Make or remove a team test lead' },
  handler: async (args, deps) => {
    const requester = typeof args.requester_user_id === 'string' ? args.requester_user_id.trim() : null;
    const dry = args.dry_run === true;
    const action = args.action;
    const audit = await auditOpen({ tool: 'team_test_lead', args, access: deps.access, kind: 'vfarm_leads', requester, dry_run: dry });
    const refuse = async (why: string, message: string) => {
      await auditClose(audit, { outcome: 'refused', detail: `${why}: ${message}`, guard_result: { reason: why } });
      return { ok: false, reason: why, message: `${message} Nothing changed.`, audit_id: audit };
    };
    if (!requester || !ADMIN_IDS.includes(requester)) return refuse('not_permitted', 'Only Destiny or Jason can make or remove a team test lead.');
    if (deps.agent) return refuse('not_permitted', 'A team test lead is made by a person on the connector, never on an agent token.');

    if (action === 'create') {
      const email = typeof args.email === 'string' ? args.email.trim().toLowerCase() : '';
      if (!/^[^\s@]+@bhanetwork\.org$/.test(email)) return refuse('not_a_team_address', 'email must be an @bhanetwork.org address.');
      if (args.confirm !== 'CREATE TEST LEAD') return refuse('confirm_required', 'Send confirm: "CREATE TEST LEAD".');
      const name = typeof args.name === 'string' && args.name.trim() ? args.name.trim() : 'Destiny Arupi';
      const org = typeof args.organisation === 'string' && args.organisation.trim() ? args.organisation.trim() : 'BHA Test';
      const held = await query<{ buyer: string }>(`SELECT form_a->>'buyer_intake_id' AS buyer FROM engine_vfarm_leads WHERE lower(email) = $1 AND closed_at IS NULL`, [email]);
      if (held.rows.length) return refuse('already_held', `${email} already has a lead (${held.rows.map((r) => r.buyer).join(', ')}). Delete it first.`);
      const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
      const body = {
        buyer_intake_id: `VFBUYER-FORMA-${suffix}`,
        correlation_id: `VFARM-FORMA-${suffix}`,
        early_access_lead_id: `VFLEAD-${Date.now()}-${suffix}`,
        source_campaign: 'team_test',
        submitted_at: new Date().toISOString(),
        answers: TEST_ANSWERS(name, email, org),
      };
      if (dry) {
        await auditClose(audit, { outcome: 'dry_run', detail: `would create ${body.buyer_intake_id} for ${email}` });
        return { ok: true, dry_run: true, would_create: { buyer_intake_id: body.buyer_intake_id, email, name, organisation: org, stage: 1 }, audit_id: audit };
      }
      const w = await earlyAccess.storeFormA(body);
      await auditClose(audit, { outcome: 'applied', detail: `created ${w.buyer_intake_id} (${w.stored})`, record_id: w.id, natural_id: w.buyer_intake_id });
      return { ok: w.stored === 'inserted', created: w.stored === 'inserted', buyer_intake_id: w.buyer_intake_id, stored: w.stored, stage: 1, organisation: org, audit_id: audit };
    }

    if (action === 'delete') {
      const ref = typeof args.lead === 'string' ? args.lead.trim() : '';
      const reason = typeof args.reason === 'string' ? args.reason.trim() : '';
      if (!ref) return refuse('no_lead_named', 'Name the lead by its buyer_intake_id.');
      if (reason.length < 3 || reason.length > 1000) return refuse('reason_required', 'Give a reason of 3 to 1,000 characters.');
      const r = await query<{ id: string; team: boolean }>(`SELECT id::text, ${earlyAccess.TEAM_TEST_SQL} AS team FROM engine_vfarm_leads WHERE form_a->>'buyer_intake_id' = $1`, [ref]);
      if (r.rows.length !== 1) return refuse('not_found', r.rows.length ? `"${ref}" names ${r.rows.length} leads.` : `No lead "${ref}" is held.`);
      if (!r.rows[0].team) return refuse('not_a_team_lead', `${ref} is a real buyer. Only an @bhanetwork.org lead can be removed here.`);
      if (args.confirm !== `DELETE ${ref}`) return refuse('confirm_required', `Send confirm: "DELETE ${ref}".`);
      if (dry) {
        await auditClose(audit, { outcome: 'dry_run', detail: `would delete ${ref}`, natural_id: ref });
        return { ok: true, dry_run: true, would_delete: ref, audit_id: audit };
      }
      const id = r.rows[0].id;
      await withTransaction(async (db) => {
        await db.query(
          `INSERT INTO record_deletions (kind, record_id, natural_id, builder_id, table_id, reason, fields, actor, at)
           SELECT 'vfarm_leads', id::text, form_a->>'buyer_intake_id', NULL, NULL, $2, to_jsonb(l) - 'ip_hash', $3, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
             FROM engine_vfarm_leads l WHERE id::text = $1 AND ${earlyAccess.TEAM_TEST_SQL}`,
          [id, reason, `team_test_lead (${requester})`],
        );
        await db.query(`DELETE FROM engine_vfarm_leads WHERE id::text = $1 AND ${earlyAccess.TEAM_TEST_SQL}`, [id]);
      });
      events.changed('vfarm_leads', id);
      await auditClose(audit, { outcome: 'applied', detail: `deleted ${ref}, copied to record_deletions`, record_id: id, natural_id: ref });
      return { ok: true, deleted: ref, kept_in: 'record_deletions', audit_id: audit };
    }
    return refuse('bad_action', 'action is "create" or "delete".');
  },
};

export const LEAD_MOVE_WRITE_TOOLS: ToolDefinition[] = [moveBuyerToForm2Tool, teamTestLeadTool];
