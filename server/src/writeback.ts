/**
 * Loop status write-back: the dashboard tells n8n a loop changed, and n8n
 * writes it to Airtable.
 *
 * Why this exists. On 2026-09-13 the dashboard was migrated off Airtable onto
 * Postgres and `airtable.ts` was deleted deliberately — this server should not
 * hold an Airtable token. That removed the write-through, and left a real gap:
 * `Bays — Daily Open Loops Sweep` reads **Airtable**, so a loop closed here
 * updated Postgres and Airtable still said `Open`, and the loop came back in
 * the next 08:00 digest as though nothing had happened.
 *
 * This closes it without putting the token back. n8n already holds it. The
 * dashboard posts an intent — loop id, the status it should now have, and
 * which table the row is in — and n8n does the write.
 *
 * The contract below was read from the live workflow (BHA — Dashboard Loop
 * Write-Back, GES8UIM3dJRbrLSx) on 2026-09-14, not assumed:
 *
 *   POST {WRITEBACK_URL}
 *   header x-api-key: {N8N_WRITEBACK_KEY}
 *   body   { loop_id, status, builder_id?, source_table?, actor }
 *
 *   200  { ok: true, loop_id, table_id, record_id, previous_status,
 *          new_status, changed, updated_by, updated_at }
 *   400  { ok: false, error: 'invalid_request', reason, loop_id, table_id }
 *   404  { ok: false, error: 'loop_not_found', loop_id, table_id }
 *
 * It never answers with a silent ok, which is the whole point: a close that
 * did not land comes back as 400 or 404 with a reason, and that reason is
 * shown on the loop rather than swallowed.
 *
 * **Nothing here throws.** The Postgres write has already happened by the time
 * this is called and is the dashboard's own record; a write-back that fails
 * must be recorded and shown, never allowed to undo or block it.
 */
import { nowIso } from './db';
import { LOOP_STATUS_TO_AIRTABLE, LOOP_TABLES, SLACK_TO_BUILDER, loopTable } from './sources';
import type { LoopStatus, LoopWriteback } from '../../src/data/types';

/**
 * Where the write-back workflow lives.
 *
 * Same arrangement as ASK_BAYS_URL: the environment wins, and the constant is
 * the fallback so a local run works without setting anything. The key has no
 * such fallback — see below.
 */
const URL_FALLBACK = 'https://bayshorizonnetwork.app.n8n.cloud/webhook/dashboard-loop-writeback';

export const WRITEBACK_URL = process.env.N8N_WRITEBACK_URL?.trim() || URL_FALLBACK;
export const WRITEBACK_URL_FROM_ENV = Boolean(process.env.N8N_WRITEBACK_URL?.trim());

/**
 * No fallback, and no default. A guessed key would be refused by n8n as an
 * unauthorised request, which reads on the page like the workflow rejecting
 * the loop rather than like this server being misconfigured. Missing is
 * reported as missing, by name.
 */
const KEY = process.env.N8N_WRITEBACK_KEY?.trim() || null;

export function writebackConfigured(): boolean {
  return Boolean(KEY);
}

/**
 * Five seconds. The workflow does two Airtable calls — a search and an update
 * — and nothing else, so a healthy round trip is well under a second. A
 * request still running at five is a request that is not coming back in time
 * to be useful to the person waiting on the click.
 */
const TIMEOUT_MS = 5_000;

/** The Slack user id the workflow's roster keys its tables on, from the builder whose table the loop is in. */
const BUILDER_TO_SLACK: Record<string, string> = Object.fromEntries(Object.entries(SLACK_TO_BUILDER).map(([slack, builder]) => [builder, slack]));

/** The seven tables the workflow will accept. Sending anything else earns a 400, so it is caught here instead. */
const LOOP_TABLE_IDS = new Set(LOOP_TABLES.map((t) => t.table));

export interface WritebackInput {
  /** The dashboard's id for the row, for the log line. */
  record_id: string;
  /** Airtable's `loop_id` field. The key the workflow searches on. */
  loop_id: string | null;
  /** The status the dashboard has just set, in its own words. */
  status: LoopStatus;
  /** Which builder's table the row is in, as this database records it. */
  builder: string | null;
  table_id: string | null;
  /**
   * Whether Airtable has a row for this loop at all. A loop opened in the
   * dashboard does not until the engine writes it back with a record id.
   */
  in_airtable: boolean;
  /** Who made the change here. One shared login, so this is that account. */
  actor: string;
}

function skipped(status: string, reason: string): LoopWriteback {
  return { state: 'skipped', status, reason, http: null, changed: null, at: nowIso() };
}
function failed(status: string, reason: string, http: number | null): LoopWriteback {
  return { state: 'failed', status, reason, http, changed: null, at: nowIso() };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The reason out of a failure body, whichever shape it came in. */
function reasonOf(json: Record<string, unknown>, res: Response): string {
  const reason = typeof json.reason === 'string' && json.reason.trim() ? json.reason.trim() : null;
  const error = typeof json.error === 'string' && json.error.trim() ? json.error.trim() : null;
  const message = typeof json.message === 'string' && json.message.trim() ? json.message.trim() : null;
  if (reason && error) return `${error}: ${reason}`;
  return reason ?? error ?? message ?? `the workflow answered ${res.status} without saying why`;
}

/**
 * Posts one loop status change. Returns what happened, always — there is no
 * failure path that leaves this with nothing to show.
 *
 * One retry, and only where a retry can help: a network error, a timeout, or a
 * 5xx. A 400 and a 404 are decisions about the payload and will be made again
 * identically, so retrying them only doubles the delay in front of the person
 * waiting for the page to come back.
 */
export async function writeLoopStatus(input: WritebackInput): Promise<LoopWriteback> {
  const status = LOOP_STATUS_TO_AIRTABLE[input.status];

  // A loop that exists only here has no row to update. Skipped before anything
  // is sent, rather than sent and answered with a 404 that would read on the
  // page as though something had gone wrong.
  if (!input.in_airtable) {
    return skipped(status, 'This loop was opened in the dashboard and Airtable has no row for it yet, so there is nothing to write back to. It gets one when the engine writes it to Airtable and pushes it back here.');
  }
  const loopId = (input.loop_id ?? '').trim();
  if (!loopId) return skipped(status, 'This loop carries no loop_id, which is the only thing the write-back can find the Airtable row by.');
  if (!loopId.startsWith('LOOP-')) return skipped(status, `"${loopId}" is not a LOOP- id, so the write-back has nothing to match on in Airtable.`);

  // Loud, by name, and on every attempt rather than only at boot: this is the
  // one failure that will not fix itself, and it is silent from the engine's
  // side — n8n never hears about the loop at all.
  if (!KEY) {
    return log(input, failed(status, 'N8N_WRITEBACK_KEY is not set on this server, so the change could not be sent to n8n and Airtable still holds the old status.', null));
  }

  // source_table is the reliable half of the pair: the row records the table it
  // was mirrored from, and the workflow takes it in preference to the roster
  // lookup. builder_id is sent alongside where it resolves, so a row with no
  // table recorded still has something to be found by.
  const table = input.table_id && LOOP_TABLE_IDS.has(input.table_id) ? input.table_id : (loopTable(input.builder ?? '')?.table ?? null);
  const slack = input.builder ? (BUILDER_TO_SLACK[input.builder] ?? null) : null;
  if (!table && !slack) {
    return log(input, failed(status, `This loop records neither an Open Loops table nor a builder the write-back roster knows (builder: ${input.builder ?? 'none'}), so there is no way to say which table to write to.`, null));
  }

  const body = JSON.stringify({
    loop_id: loopId,
    status,
    ...(slack ? { builder_id: slack } : {}),
    ...(table ? { source_table: table } : {}),
    actor: input.actor,
  });

  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res: Response;
    let text: string;
    try {
      res = await fetch(WRITEBACK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'x-api-key': KEY },
        body,
        signal: controller.signal,
      });
      text = await res.text();
    } catch (e) {
      const timedOut = e instanceof Error && e.name === 'AbortError';
      const reason = timedOut ? 'the write-back workflow did not answer within five seconds' : 'could not reach the write-back workflow';
      if (attempt === 0) {
        await sleep(300);
        continue;
      }
      return log(input, failed(status, `${reason}, so Airtable still holds the old status.`, null));
    } finally {
      clearTimeout(timer);
    }

    let json: Record<string, unknown>;
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      // Not JSON at all. n8n's own 403 for a bad key lands here as often as not.
      if (res.status >= 500 && attempt === 0) {
        await sleep(300);
        continue;
      }
      return log(input, failed(status, `the write-back workflow answered ${res.status} with a body that was not JSON.`, res.status));
    }

    if (res.ok && json.ok === true) {
      return log(input, {
        state: 'ok',
        status,
        reason: null,
        http: res.status,
        // false means the row already held that status. A success, not an error.
        changed: json.changed === true,
        at: nowIso(),
      });
    }

    // A 5xx is worth one more try; a 400 or a 404 will answer the same way.
    if (res.status >= 500 && attempt === 0) {
      await sleep(300);
      continue;
    }
    return log(input, failed(status, reasonOf(json, res), res.status));
  }

  // Unreachable: the loop above returns on every path of its last pass.
  return log(input, failed(status, 'the write-back did not complete.', null));
}

/** One line per attempt, with the loop, the code and the reason — as asked for, and as the page shows. */
function log(input: WritebackInput, r: LoopWriteback): LoopWriteback {
  const where = `${input.loop_id ?? input.record_id} → ${r.status}`;
  if (r.state === 'ok') console.log(`writeback ${where}: ok${r.changed === false ? ' (already that status in Airtable)' : ''}`);
  else console.error(`writeback ${where}: FAILED${r.http ? ` (HTTP ${r.http})` : ''} — ${r.reason ?? 'no reason given'}`);
  return r;
}
