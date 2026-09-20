/**
 * The write gate: preview, then token, then act once.
 *
 * **Scaffolding, built ahead of the first tool that needs it.** Nothing
 * destructive ships through it in this change — `resync` deliberately does not
 * use it, because copying rows that already exist from a source this dashboard
 * already reads is not a change anybody needs to approve. The gate is here so
 * that when the first real mutation arrives, the shape is already decided and
 * already tested.
 *
 * **Enforced here, on the server.** Not in a client's confirmation dialog and
 * not in the model's judgement: both of those vary by which client is connected
 * and by what a model decides in the moment. The rule is that a mutating tool
 * called without a token performs no change, and the only thing that can mint a
 * token is a preview this process computed.
 *
 * The three refusals are separate errors on purpose. "Expired", "already used"
 * and "the record changed underneath you" are three different situations and
 * want three different next moves — wait and re-preview, stop and look at what
 * already happened, and re-read the record. A single "invalid token" would
 * collapse all three into a shrug.
 */
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { query } from '../pg';
import { McpError } from './source';

/** Sixty seconds. Long enough to read a preview, short enough that a stale one cannot act. */
const TOKEN_TTL_MS = 60_000;

/** What a preview describes: one record, and what would change on it. */
export interface FieldChange {
  field: string;
  current: unknown;
  proposed: unknown;
}

export interface Operation {
  /** The tool asking. Part of the digest, so a token cannot cross tools. */
  tool: string;
  /** What is being changed, as a reader would name it. */
  target: string;
  changes: FieldChange[];
  /**
   * The record as it is now, whole. Hashed into the digest, so a token stops
   * being valid the moment anything about the record moves — not just the
   * fields this operation names.
   */
  record: unknown;
}

interface Pending {
  digest: string;
  tool: string;
  target: string;
  changes: FieldChange[];
  expires: number;
  used: boolean;
}

const pending = new Map<string, Pending>();

/** Keeps the map from growing on previews nobody ever confirms. */
function sweep(): void {
  const now = Date.now();
  for (const [token, p] of pending) if (p.expires < now + 0 && p.used) pending.delete(token);
  for (const [token, p] of pending) if (p.expires < now - 10 * TOKEN_TTL_MS) pending.delete(token);
}

/**
 * The fingerprint of "this exact operation against this exact record".
 *
 * The record goes in whole, so a token minted against a row somebody has since
 * edited will not verify — which is the "changed underneath it" case, detected
 * rather than trusted.
 */
export function digestOf(op: Operation): string {
  const canonical = JSON.stringify({
    tool: op.tool,
    target: op.target,
    changes: op.changes.map((c) => ({ field: c.field, current: c.current, proposed: c.proposed })),
    record: op.record,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export interface Preview {
  status: 'preview';
  tool: string;
  target: string;
  changes: FieldChange[];
  token: string;
  digest: string;
  expires_at: string;
  expires_in_seconds: number;
  note: string;
}

/**
 * Phase one. Computes the digest, mints a token bound to it, writes nothing.
 *
 * The audit row for a preview is deliberately *not* written: a preview is not a
 * write, and a log that records intentions alongside actions stops being a
 * record of what happened.
 */
export function preview(op: Operation, ttlMs?: number): Preview {
  sweep();
  const digest = digestOf(op);
  const token = randomUUID();
  /**
   * `ttlMs` can only ever make the window *shorter*, never longer — it is
   * clamped to the default. A caller that wants a tighter window can have one;
   * nothing can widen it, so the knob cannot be turned into a way to hold a
   * live token open.
   */
  const ttl = Math.max(1, Math.min(ttlMs ?? TOKEN_TTL_MS, TOKEN_TTL_MS));
  const expires = Date.now() + ttl;
  pending.set(token, { digest, tool: op.tool, target: op.target, changes: op.changes, expires, used: false });
  return {
    status: 'preview',
    tool: op.tool,
    target: op.target,
    changes: op.changes,
    token,
    digest,
    expires_at: new Date(expires).toISOString(),
    expires_in_seconds: Math.round(ttl / 1000),
    note: `Nothing has changed. Call ${op.tool} again with token="${token}" to make exactly this change. The token is good for ${Math.round(
      ttl / 1000,
    )} seconds, works once, and stops working if the record changes in the meantime — re-run without a token to get a fresh preview.`,
  };
}

export type RefusalCode = 'token_unknown' | 'token_expired' | 'token_used' | 'record_changed';

function refuse(code: RefusalCode, message: string): never {
  throw new McpError(code, message);
}

/**
 * Phase two. Verifies the token against a freshly read record, burns it, and
 * hands back what the caller should now do.
 *
 * `op` here must be rebuilt from a **fresh** read of the record, not from the
 * preview — that is what makes the comparison meaningful. Passing the preview's
 * own operation back in would compare a value with itself and prove nothing.
 */
export function redeem(token: string, freshOp: Operation): { digest: string; changes: FieldChange[] } {
  sweep();
  const held = pending.get(token);
  if (!held) {
    refuse(
      'token_unknown',
      'That token is not one this process issued, or it has been swept. Call the tool without a token to get a fresh preview. (Tokens live in memory, so a deploy or a restart invalidates every outstanding one.)',
    );
  }
  if (held.used) {
    refuse(
      'token_used',
      `That token has already been spent — the change it authorised was made at most ${Math.round(
        TOKEN_TTL_MS / 1000,
      )} seconds ago. It is refused rather than repeated, so a retry cannot double-apply. Read the record before trying again; if the first attempt did what you wanted, there is nothing to do.`,
    );
  }
  if (held.expires < Date.now()) {
    pending.delete(token);
    refuse('token_expired', `That token expired at ${new Date(held.expires).toISOString()}. Call the tool without a token for a fresh preview.`);
  }
  if (held.tool !== freshOp.tool) {
    refuse('token_unknown', `That token was issued to ${held.tool} and cannot be spent by ${freshOp.tool}. A token is bound to one operation.`);
  }

  const now = digestOf(freshOp);
  const a = Buffer.from(now);
  const b = Buffer.from(held.digest);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    pending.delete(token);
    refuse(
      'record_changed',
      `The record changed since the preview, so the token no longer matches it and nothing was done. Re-read it and preview again — the change you were about to make was computed against values that are no longer there.`,
    );
  }

  held.used = true;
  return { digest: held.digest, changes: held.changes };
}

/* ----------------------------------------------------------------- audit */

export type Outcome = 'applied' | 'refused' | 'failed' | 'replayed';

export interface AuditRow {
  tool: string;
  args: Record<string, unknown>;
  digest: string;
  token?: string | null;
  idempotency_key?: string | null;
  target?: string | null;
  before?: unknown;
  after?: unknown;
  outcome: Outcome;
  detail?: string | null;
  actor?: string | null;
}

/**
 * Writes the audit row. Called by the gate for every outcome, refusals
 * included — an expired token and a replay are both things worth being able to
 * count later, and a log that only records successes describes a system that
 * never fails.
 *
 * It throws on failure rather than swallowing: if the write cannot be recorded,
 * the write should not happen. That is the opposite of the notification hop on
 * the Early Access route, and deliberately so — a lead nobody announced is
 * still a lead, but a mutation nobody recorded undercuts the premise that the
 * record cannot lie.
 */
export async function audit(row: AuditRow): Promise<number> {
  const r = await query<{ id: string }>(
    `INSERT INTO engine_mcp_writes (tool, arguments, digest, token, idempotency_key, target, before, after, outcome, detail, actor)
     VALUES ($1,$2::jsonb,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11)
     RETURNING id`,
    [
      row.tool,
      JSON.stringify(row.args ?? {}),
      row.digest,
      row.token ?? null,
      row.idempotency_key ?? null,
      row.target ?? null,
      row.before === undefined ? null : JSON.stringify(row.before),
      row.after === undefined ? null : JSON.stringify(row.after),
      row.outcome,
      row.detail ?? null,
      row.actor ?? 'mcp',
    ],
  );
  return Number(r.rows[0].id);
}

/* ------------------------------------------------------------ idempotency */

/**
 * Claims an idempotency key for a tool, or hands back what the first call did.
 *
 * **Required by any tool that creates rather than updates.** An update is
 * idempotent by its nature — setting a status to `contacted` twice leaves it
 * contacted — but a create is not, and a retried create with no key is a
 * duplicate row nobody asked for.
 *
 * The claim is the unique index on `(tool, idempotency_key)`, so two identical
 * creates racing cannot both insert: the loser reads the winner's row.
 */
export async function claim(tool: string, key: string, args: Record<string, unknown>, digest: string): Promise<{ fresh: true; id: number } | { fresh: false; original: { id: number; at: string; outcome: string; after: unknown } }> {
  try {
    const id = await audit({ tool, args, digest, idempotency_key: key, outcome: 'applied', detail: 'claimed, in flight' });
    return { fresh: true, id };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (!/duplicate key|unique constraint/i.test(message)) throw e;
    const held = await query<{ id: string; at: Date; outcome: string; after: unknown }>(
      `SELECT id, at, outcome, after FROM engine_mcp_writes WHERE tool = $1 AND idempotency_key = $2 ORDER BY id LIMIT 1`,
      [tool, key],
    );
    const row = held.rows[0];
    return {
      fresh: false,
      original: { id: Number(row.id), at: new Date(row.at).toISOString(), outcome: row.outcome, after: row.after },
    };
  }
}

/** Fills in what a claimed row actually did, once it has done it. */
export async function settle(id: number, outcome: Outcome, after: unknown, detail?: string): Promise<void> {
  await query(`UPDATE engine_mcp_writes SET outcome = $2, after = $3::jsonb, detail = $4 WHERE id = $1`, [
    id,
    outcome,
    after === undefined ? null : JSON.stringify(after),
    detail ?? null,
  ]);
}

/** For the tests. Clears outstanding previews; touches nothing in the database. */
export function resetTokens(): void {
  pending.clear();
}
