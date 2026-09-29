/**
 * Data governance (2026-09-29, Destiny — Agent Upgrade Plan steps 5.4 and
 * 5.5, the weakest dimension on the 28 Sep re-score at 3 of 10).
 *
 * Two things live here, because they are the two halves of one question —
 * what this engine keeps about people, and what it lets into BHARAG:
 *
 * 1. **Retention.** Personal text is cleared once its period ends; the row, its
 *    dates, counts and outcome stay, so every past figure still adds up and
 *    nothing breaks the "nothing drops a table" rule. Incidents, executions and
 *    engine history are not personal and are kept whole. A weekly in-process
 *    job applies the policy and writes its counts to `engine_writes`.
 *
 * 2. **The BHARAG write guard.** Every write-back into BHARAG is checked before
 *    it lands: an agent's Q&A only when its outcome is Answered, never Failed or
 *    Thin; secrets redacted wherever they appear; a source tag required and
 *    stamped into the metadata. The dashboard's own ingests go through it
 *    in-process; n8n's ingest nodes call `POST /api/engine/bharag-guard` and
 *    ingest what it hands back. Every decision is a row in
 *    `engine_bharag_guard`, so refusals are counted on the scorecard rather
 *    than lost.
 */
import { query, withTransaction } from './pg';
import { getMeta, setMeta } from './db';
import * as mirror from './mirror';

/* ------------------------------------------------------------ retention */

export interface RetentionRule {
  store: string;
  table: string;
  days: number;
  clears: string;
  keeps: string;
  /** SQL for the row's own date, as timestamptz. */
  dated: string;
  /** Rows not yet cleared. */
  pending: string;
  /** The SET clause. $1 is the run's time as ISO text. */
  set: string;
}

/** An ISO text column read as a time, or null where it is not one. */
const asTime = (expr: string) => `(CASE WHEN ${expr} ~ '^\\d{4}-\\d{2}-\\d{2}' THEN (${expr})::timestamptz END)`;

const ASK_SET = `fields = (fields - 'Question' - 'Answer' - 'Answer Summary') || jsonb_build_object('Retention Cleared At', $1::text)`;
const ASK_PENDING = `NOT (fields ? 'Retention Cleared At')`;
const askDated = asTime(`coalesce(nullif(fields->>'Asked At', ''), created_time)`);

/**
 * The written policy. The periods are Destiny's call (29 Sep): 180 days for
 * anything a person said to an agent, 365 for Early Access leads because they
 * are sales contacts somebody may still be answering. Changing a period is a
 * change to this list and a line in BUILD_LOG, never a setting.
 */
export const RETENTION: RetentionRule[] = [
  {
    store: 'Customer Service Twin turns',
    table: 'engine_cst_turns',
    days: 180,
    clears: "the customer's message, CST's reply, the phone number and the name",
    keeps: 'when, channel, project, intent, outcome, reply time and delivery',
    dated: 'coalesce(occurred_at, received_at)',
    pending: 'retention_cleared_at IS NULL',
    set: `message = NULL, reply = NULL, phone_e164 = NULL, customer_name = NULL, retention_cleared_at = $1::timestamptz,
          turn_payload = CASE WHEN turn_payload IS NULL THEN NULL
                              ELSE (turn_payload - 'message' - 'reply' - 'customer')
                                   || jsonb_build_object('customer', coalesce(turn_payload->'customer', '{}'::jsonb) - 'phone_e164' - 'name') END`,
  },
  {
    store: 'Genie asks',
    table: 'engine_genie_events',
    days: 180,
    clears: 'the question and the answer text',
    keeps: 'when, who asked, lane, source, outcome, duration and hand-off',
    dated: 'occurred_at',
    pending: 'retention_cleared_at IS NULL',
    set: `question = NULL, retention_cleared_at = $1::timestamptz, payload = (payload - 'question') #- '{response,finalOutput}'`,
  },
  { store: 'North Star asks', table: 'engine_ns_asks', days: 180, clears: 'the question, the answer and its summary', keeps: 'every other field', dated: askDated, pending: ASK_PENDING, set: ASK_SET },
  { store: 'Research Twin asks', table: 'engine_rt_asks', days: 180, clears: 'the question, the answer and its summary', keeps: 'every other field', dated: askDated, pending: ASK_PENDING, set: ASK_SET },
  { store: 'Bays asks', table: 'engine_bays_asks', days: 180, clears: 'the question and the answer', keeps: 'every other field', dated: askDated, pending: ASK_PENDING, set: ASK_SET },
  {
    store: 'vFarm Early Access leads',
    table: 'engine_vfarm_leads',
    days: 365,
    clears: 'name, email, organisation, the form answers and the browser string',
    keeps: 'when, where it came from, campaign, status and notes',
    dated: 'created_at',
    pending: 'retention_cleared_at IS NULL',
    // email is NOT NULL and repeats are flagged by it, so a cleared row gets a
    // value unique to itself rather than one every cleared row would share.
    set: `full_name = '(cleared)', email = 'cleared:' || id::text, organization_name = NULL, user_agent = NULL,
          form_a = CASE WHEN form_a IS NULL THEN NULL ELSE form_a - 'answers' END, retention_cleared_at = $1::timestamptz`,
  },
];

/** What the policy does not cover, said rather than left out. */
export const RETENTION_NOT_COVERED = [
  'BHARAG copies of answers: BHARAG has no delete this engine can call, so its own retention is BHARAG\'s to set.',
  'n8n agent memory and execution data: held by n8n and governed by its plan, not by this server.',
  'Incidents, executions, repairs and the write logs: engine history, not personal text, kept whole.',
];

export interface RetentionResult {
  ran_at: string;
  as_of: string;
  dry_run: boolean;
  stores: Array<{ store: string; table: string; days: number; cutoff: string; cleared: number }>;
  cleared: number;
}

class DryRun extends Error {
  constructor(public result: RetentionResult) {
    super('dry run');
  }
}

/**
 * Applies the policy once. `as_of` (dry run only) pretends it is a later date,
 * so the clearing can be proved against the real tables today, when no row is
 * yet old enough, without writing anything.
 */
export async function runRetention(opts: { dry_run?: boolean; as_of?: string } = {}): Promise<RetentionResult> {
  const dry = opts.dry_run === true;
  if (opts.as_of && !dry) throw new Error('as_of is only accepted with dry_run: true — a real run always uses today.');
  const asOf = opts.as_of ? new Date(opts.as_of) : new Date();
  if (Number.isNaN(asOf.getTime())) throw new Error(`as_of "${opts.as_of}" is not a date.`);
  const ranAt = new Date().toISOString();
  const run = async () =>
    withTransaction(async (db) => {
      const stores: RetentionResult['stores'] = [];
      for (const rule of RETENTION) {
        const cutoff = new Date(asOf.getTime() - rule.days * 86_400_000).toISOString();
        const r = await db.query(`UPDATE ${rule.table} SET ${rule.set} WHERE ${rule.pending} AND ${rule.dated} < $2::timestamptz`, [ranAt, cutoff]);
        stores.push({ store: rule.store, table: rule.table, days: rule.days, cutoff, cleared: r.rowCount ?? 0 });
      }
      const result: RetentionResult = { ran_at: ranAt, as_of: asOf.toISOString(), dry_run: dry, stores, cleared: stores.reduce((a, s) => a + s.cleared, 0) };
      if (dry) throw new DryRun(result);
      return result;
    });
  try {
    return await run();
  } catch (e) {
    if (e instanceof DryRun) return e.result;
    throw e;
  }
}

async function recordRun(r: RetentionResult, by: string): Promise<void> {
  await mirror.logWrite({
    endpoint: 'retention',
    kind: 'retention',
    method: 'POST',
    key_label: by,
    outcome: r.dry_run ? 'unchanged' : r.cleared ? 'updated' : 'unchanged',
    detail: `${r.dry_run ? `dry run as of ${r.as_of.slice(0, 10)}, rolled back: ` : ''}${r.stores.map((s) => `${s.store} ${s.cleared}`).join(', ')}`,
  });
  if (!r.dry_run) await setMeta('retention.last_run', JSON.stringify({ at: r.ran_at, cleared: r.cleared, stores: r.stores.map((s) => ({ store: s.store, cleared: s.cleared })) }));
}

export async function runAndRecord(opts: { dry_run?: boolean; as_of?: string }, by: string): Promise<RetentionResult> {
  const r = await runRetention(opts);
  await recordRun(r, by);
  return r;
}

const WEEK = 7 * 86_400_000;
let started = false;

/**
 * Weekly, in-process. Checks every six hours whether a week has passed since
 * the last real run (kept in `meta`, so a restart neither skips nor repeats a
 * week), first look five minutes after boot. A failed run is logged and tried
 * again at the next check; it never stops the server.
 */
export function startRetention(): void {
  if (started) return;
  started = true;
  const tick = async () => {
    try {
      const last = await getMeta('retention.last_run');
      const at = last ? Date.parse(JSON.parse(last).at) : 0;
      if (Date.now() - at < WEEK) return;
      await runAndRecord({}, 'scheduler');
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      console.error(`retention: run failed: ${detail}`);
      await mirror.logWrite({ endpoint: 'retention', kind: 'retention', method: 'POST', key_label: 'scheduler', outcome: 'error', detail });
    }
  };
  setTimeout(() => void tick(), 5 * 60_000).unref();
  setInterval(() => void tick(), 6 * 3_600_000).unref();
}

export async function retentionStatus() {
  const last = await getMeta('retention.last_run');
  return {
    policy: RETENTION.map((r) => ({ store: r.store, days: r.days, clears: r.clears, keeps: r.keeps })),
    not_covered: RETENTION_NOT_COVERED,
    last_run: last ? (JSON.parse(last) as { at: string; cleared: number }) : null,
  };
}

/* ------------------------------------------------- the BHARAG write guard */

/**
 * Secret shapes, each redacted to `[redacted: <name>]`. Deliberately the
 * shapes a credential actually has, not the word "password" anywhere: a doc
 * about rotating a password is fine, a doc holding one is not. A match is
 * redacted, not refused, so one pasted key does not cost a day's archive.
 */
const SECRETS: Array<{ name: string; re: RegExp; keep?: (m: string, ...g: string[]) => string }> = [
  { name: 'private key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g },
  { name: 'slack token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { name: 'slack webhook', re: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/g },
  { name: 'api key (sk-)', re: /\bsk-(?:proj-|svcacct-|ant-|or-)?[A-Za-z0-9_-]{20,}/g },
  { name: 'aws key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'github token', re: /\b(?:ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{20,}/g },
  { name: 'google api key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { name: 'bearer token', re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g },
  { name: 'database url password', re: /\b((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^:\s/@]+:)[^@\s]+@/g, keep: (_m, pre) => `${pre}[redacted: database url password]@` },
  {
    name: 'assigned secret',
    re: /\b((?:api[_-]?key|secret|client[_-]?secret|password|passwd|access[_-]?token|auth[_-]?token|x-api-key|x-dashboard-key)\b\s*[:=]\s*["']?)[A-Za-z0-9_\-./+]{12,}/gi,
    keep: (_m, pre) => `${pre}[redacted: assigned secret]`,
  },
];

export function redactSecrets(text: string): { text: string; found: Record<string, number> } {
  const found: Record<string, number> = {};
  let out = text;
  for (const s of SECRETS) {
    out = out.replace(s.re, (m: string, ...g: unknown[]) => {
      found[s.name] = (found[s.name] ?? 0) + 1;
      return s.keep ? s.keep(m, ...(g.filter((x) => typeof x === 'string') as string[])) : `[redacted: ${s.name}]`;
    });
  }
  return { text: out, found };
}

export type GuardKind = 'qa' | 'record' | 'archive' | 'other';
export const GUARD_KINDS: GuardKind[] = ['qa', 'record', 'archive', 'other'];

export interface GuardInput {
  workspace: string;
  title: string;
  content: string;
  kind: GuardKind;
  outcome?: string | null;
  source: string;
  run_id?: string | null;
  metadata?: Record<string, unknown> | null;
  via: 'dashboard' | 'n8n';
}

export interface GuardResult {
  allow: boolean;
  outcome: 'allowed' | 'redacted' | 'refused';
  reason: string | null;
  title: string;
  content: string;
  metadata: Record<string, unknown>;
  redactions: Record<string, number>;
}

/**
 * Decides one write-back and records the decision. A refusal is an answer, not
 * an error: the caller skips the ingest and the row says why.
 */
export async function guard(input: GuardInput): Promise<GuardResult> {
  const source = (input.source ?? '').trim();
  let reason: string | null = null;
  if (!source) reason = 'no_source: every write-back carries a source tag naming the workflow or tool that sent it.';
  else if (!GUARD_KINDS.includes(input.kind)) reason = `bad_kind: kind must be one of ${GUARD_KINDS.join(', ')}; got "${String(input.kind)}".`;
  else if (input.kind === 'qa' && (input.outcome ?? '').trim().toLowerCase() !== 'answered')
    reason = `not_answered: only an Answered ask is stored as knowledge; this one's outcome is "${input.outcome ?? 'not sent'}".`;
  const t = redactSecrets(input.title ?? '');
  const c = redactSecrets(input.content ?? '');
  const redactions: Record<string, number> = { ...t.found };
  for (const [k, v] of Object.entries(c.found)) redactions[k] = (redactions[k] ?? 0) + v;
  if (!reason && !c.text.trim()) reason = 'empty: there is no content to store.';
  const redacted = Object.keys(redactions).length > 0;
  const outcome: GuardResult['outcome'] = reason ? 'refused' : redacted ? 'redacted' : 'allowed';
  const metadata = {
    ...(input.metadata ?? {}),
    source,
    run_id: input.run_id ?? null,
    guard: 'bharag-guard v1',
    guarded_at: new Date().toISOString(),
    ...(redacted ? { redactions } : {}),
  };
  try {
    await query(
      `INSERT INTO engine_bharag_guard (workspace, source, run_id, kind, answer_outcome, outcome, reason, redactions, title, via)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [input.workspace || null, source || null, input.run_id ?? null, input.kind, input.outcome ?? null, outcome, reason, redacted ? JSON.stringify(redactions) : null, t.text.slice(0, 300), input.via],
    );
  } catch (e) {
    // The decision still stands; only its record failed, and that is said.
    console.error(`bharag-guard: could not record the decision: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { allow: !reason, outcome, reason, title: t.text, content: c.text, metadata, redactions };
}

/** The scorecard's figures: seven days of guard decisions. */
export async function guardSummary() {
  const r = await query<{ outcome: string; n: string }>(
    `SELECT outcome, count(*)::text AS n FROM engine_bharag_guard WHERE at >= now() - interval '7 days' GROUP BY 1`,
  );
  const by = Object.fromEntries(r.rows.map((x) => [x.outcome, Number(x.n)]));
  const reasons = await query<{ reason: string; n: string }>(
    `SELECT split_part(reason, ':', 1) AS reason, count(*)::text AS n FROM engine_bharag_guard
      WHERE at >= now() - interval '7 days' AND outcome = 'refused' GROUP BY 1 ORDER BY 2 DESC`,
  );
  const first = await query<{ first: string | null }>(`SELECT min(at)::text AS first FROM engine_bharag_guard`);
  return {
    allowed: by.allowed ?? 0,
    redacted: by.redacted ?? 0,
    refused: by.refused ?? 0,
    refused_by_reason: reasons.rows.map((x) => ({ reason: x.reason, n: Number(x.n) })),
    recording_since: first.rows[0]?.first ?? null,
  };
}
