/**
 * Engine strain: one read of the three states that mean the engine is running short or around a fault,
 * and what each audience may be told about them (27 Oct 2026, Destiny — Jason's 7RZT ask on the 25 Oct log,
 * #workflow-logs-destiny 1792946030.895079: map void/voided state, credit-floor-aware refusals and eval
 * fallback events to what operators, pilots and early buyers see, and how Slack Genie surfaces them).
 *
 * The three states were each recorded already and read by nothing outside the team:
 *   A. a voided Codex log           — `layer0_log_voided` events (layer0Void.ts)
 *   B. a credit-floor refusal/hold  — `openrouter_credit_out` events (creditOut.ts), OpenRouter recovery holds
 *                                     (recovery.ts), draft eval runs stopped for credit (draftEval.ts)
 *   C. a fallback to the backup     — `ai_provider_fallback` events (the n8n delivery workflows), draft eval
 *                                     runs that ran on Anthropic (engine_draft_eval_runs.ran_on, migration 97)
 *
 * `assess` is pure: it takes the counts and decides the state and the audience lines, so the rule is tested
 * without a database. `read` gathers the counts. The audience lines are the contract (the map in the
 * "Engine strain states" note, and docs/contracts/genie-logstream-read.md §Engine strain): outside readers see
 * the effect in plain words, never the mechanics, and never a silence that looks like nothing is wrong.
 */
import { query } from './pg';
import * as recovery from './recovery';

export type StrainState = 'normal' | 'strained' | 'recovering';

export interface StrainCounts {
  /** The window read, in hours. */
  hours: number;
  credit_out_total: number;
  credit_out_last_hour: number;
  credit_out_latest_at: string | null;
  /** OpenRouter failures the recovery watcher is holding now. */
  openrouter_held_now: number;
  openrouter_balance_usd: number | null;
  fallbacks_total: number;
  fallbacks_last_hour: number;
  /** Fallbacks whose answer was checked and was a real answer. */
  fallbacks_answered: number;
  /** Fallbacks the honest check rejected (error payload) or that got no answer. */
  fallbacks_failed: number;
  /** Fallbacks written before the check existed (27 Oct 2026): fallback_ok only meant text came back. */
  fallbacks_unchecked: number;
  draft_evals_on_backup: number;
  draft_evals_stopped_for_credit: number;
  voided_logs: number;
}

export interface StrainAssessment {
  state: StrainState;
  /** One sentence, the answer. */
  summary: string;
  /** Why the state is what it is, each a fact with its number. */
  reasons: string[];
  /** What each audience may be told. Never mechanics outside the team; never "down". */
  audiences: {
    team: string;
    pilot_operator: string;
    early_buyer: string;
    media_twin: string;
    genie: string;
  };
}

const PILOT_LINE =
  'Nothing changes for a pilot operator: the acknowledgement in their channel is fixed text and a person answers within 4 hours.';
const BUYER_LINE = 'Nothing changes for an early buyer: Stage 3 questions are answered by a person by email, manual and not instant.';

/** The rule, pure. Strained: something happened in the last hour or runs are being held now. */
export function assess(c: StrainCounts): StrainAssessment {
  const reasons: string[] = [];
  if (c.openrouter_held_now) reasons.push(`${c.openrouter_held_now} OpenRouter run(s) are held until the balance can pay for them${c.openrouter_balance_usd != null ? ` (last probe $${c.openrouter_balance_usd.toFixed(2)})` : ''}.`);
  if (c.credit_out_last_hour) reasons.push(`OpenRouter refused for credit ${c.credit_out_last_hour} time(s) in the last hour.`);
  if (c.fallbacks_last_hour) reasons.push(`${c.fallbacks_last_hour} answer(s) in the last hour came from the Anthropic backup.`);
  const now = c.openrouter_held_now > 0 || c.credit_out_last_hour > 0 || c.fallbacks_last_hour > 0;
  const earlier = c.credit_out_total > 0 || c.fallbacks_total > 0 || c.draft_evals_stopped_for_credit > 0;
  const state: StrainState = now ? 'strained' : earlier ? 'recovering' : 'normal';
  if (!now && c.credit_out_total) reasons.push(`OpenRouter refused for credit ${c.credit_out_total} time(s) in the last ${c.hours} hours, none in the last hour.`);
  if (!now && c.fallbacks_total) reasons.push(`${c.fallbacks_total} answer(s) in the last ${c.hours} hours came from the Anthropic backup, none in the last hour.`);
  if (c.fallbacks_failed) reasons.push(`${c.fallbacks_failed} fallback(s) did not produce a real answer and were raised.`);
  if (c.fallbacks_unchecked) reasons.push(`${c.fallbacks_unchecked} fallback(s) were recorded before answers were checked, so whether they answered is not known.`);
  if (c.draft_evals_on_backup) reasons.push(`${c.draft_evals_on_backup} draft eval run(s) ran on the Anthropic backup.`);
  if (c.draft_evals_stopped_for_credit) reasons.push(`${c.draft_evals_stopped_for_credit} draft eval run(s) stopped for credit.`);
  if (c.voided_logs) reasons.push(`${c.voided_logs} parked Codex log(s) were voided (replaced or withdrawn); that is housekeeping, not strain.`);

  const summary =
    state === 'strained'
      ? 'The engine is running short of AI credit or answering on its backup right now. Answers may be slower; nothing is lost.'
      : state === 'recovering'
        ? `The engine ran short of AI credit or answered on its backup in the last ${c.hours} hours and is back to normal now.`
        : `The engine is running normally: no credit refusals, holds or backup answers in the last ${c.hours} hours.`;

  const genie =
    state === 'strained'
      ? `Answers may be slower right now while the engine runs short of AI credit; nothing is lost${c.openrouter_held_now ? `, and ${c.openrouter_held_now} held run(s) will be re-run once it can pay` : ''}. If asked how it is answering: on its backup provider.`
      : state === 'recovering'
        ? 'The engine was short of AI credit earlier and is back to normal. Nothing was lost.'
        : 'The engine is running normally.';

  return {
    state,
    summary,
    reasons,
    audiences: {
      team: reasons.length ? reasons.join(' ') : summary,
      pilot_operator: PILOT_LINE,
      early_buyer: BUYER_LINE,
      media_twin:
        'May say the engine\'s agents switch to a backup provider mid-run when the primary runs out (evidence: eval run 49651, 40 of 40). Not safe to claim: any uptime figure, or that the engine never stops.',
      genie,
    },
  };
}

const n = (v: unknown): number => Number(v ?? 0) || 0;

/** The counts, read from the events, the recovery plan and the draft eval runs. */
export async function read(hours = 24): Promise<StrainAssessment & { counts: StrainCounts; voided: Array<Record<string, unknown>>; recent_fallbacks: Array<Record<string, unknown>>; at: string }> {
  const h = Math.max(1, Math.min(168, Math.floor(hours) || 24));
  const notTest = `coalesce(detail->>'test', 'false') <> 'true'`;
  const credit = await query<{ total: string; last_hour: string; latest: string | null }>(
    `SELECT count(*) AS total, count(*) FILTER (WHERE at > now() - interval '1 hour') AS last_hour,
            to_char(max(at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS latest
       FROM engine_events WHERE event_type = 'openrouter_credit_out' AND at > now() - make_interval(hours => $1::int) AND ${notTest}`,
    [h],
  );
  const fb = await query<{ total: string; last_hour: string; answered: string; failed: string; unchecked: string }>(
    `SELECT count(*) AS total, count(*) FILTER (WHERE at > now() - interval '1 hour') AS last_hour,
            count(*) FILTER (WHERE detail->>'answer_check' = 'answered') AS answered,
            count(*) FILTER (WHERE detail->>'answer_check' IN ('error_payload', 'empty') OR (detail->>'answer_check' IS NULL AND detail->>'fallback_ok' = 'false')) AS failed,
            count(*) FILTER (WHERE detail->>'answer_check' IS NULL AND coalesce(detail->>'fallback_ok', '') <> 'false') AS unchecked
       FROM engine_events WHERE event_type = 'ai_provider_fallback' AND at > now() - make_interval(hours => $1::int) AND ${notTest}`,
    [h],
  );
  const recent = await query<Record<string, unknown>>(
    `SELECT to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at, detail->>'workflow' AS workflow,
            coalesce(detail->>'answer_check', 'unchecked') AS answer_check, detail->>'execution_id' AS execution_id
       FROM engine_events WHERE event_type = 'ai_provider_fallback' AND at > now() - make_interval(hours => $1::int) AND ${notTest}
      ORDER BY at DESC LIMIT 10`,
    [h],
  );
  const voided = await query<Record<string, unknown>>(
    `SELECT to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at, subject_id, actor,
            detail->>'reason' AS reason, detail->>'replaced_by' AS replaced_by, (detail->>'auto')::boolean AS auto
       FROM engine_events WHERE event_type = 'layer0_log_voided' AND at > now() - make_interval(hours => $1::int)
      ORDER BY at DESC LIMIT 10`,
    [h],
  );
  const evals = await query<{ on_backup: string; stopped: string }>(
    `SELECT count(*) FILTER (WHERE ran_on = 'Anthropic') AS on_backup, count(*) FILTER (WHERE state = 'stopped_credit') AS stopped
       FROM engine_draft_eval_runs WHERE started_at > now() - make_interval(hours => $1::int)`,
    [h],
  );
  const plan = await recovery.plan();
  const held = plan.waiting.filter((r) => r.dependency === 'openrouter').length + plan.replaying.filter((r) => r.dependency === 'openrouter').length;
  const balance = plan.last_probe?.dependencies?.openrouter?.remaining_usd;

  const counts: StrainCounts = {
    hours: h,
    credit_out_total: n(credit.rows[0]?.total),
    credit_out_last_hour: n(credit.rows[0]?.last_hour),
    credit_out_latest_at: credit.rows[0]?.latest ?? null,
    openrouter_held_now: held,
    openrouter_balance_usd: typeof balance === 'number' ? balance : null,
    fallbacks_total: n(fb.rows[0]?.total),
    fallbacks_last_hour: n(fb.rows[0]?.last_hour),
    fallbacks_answered: n(fb.rows[0]?.answered),
    fallbacks_failed: n(fb.rows[0]?.failed),
    fallbacks_unchecked: n(fb.rows[0]?.unchecked),
    draft_evals_on_backup: n(evals.rows[0]?.on_backup),
    draft_evals_stopped_for_credit: n(evals.rows[0]?.stopped),
    voided_logs: voided.rows.length,
  };
  return { ...assess(counts), counts, voided: voided.rows, recent_fallbacks: recent.rows, at: new Date().toISOString() };
}
