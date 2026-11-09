/**
 * The review channel's notice goes once the log is complete (9 Nov 2026, Destiny). When a parked log's missing
 * sections are filled in, its Layer 0 row turns `completed`, and the "In review, incomplete" notice Bays posted for
 * it in #bha-log-reviews (or a "Log parked" post from before 30 Oct) is deleted, as Bays, who posted it. The notice
 * is found the way the void path finds it: the bot post in that channel that prints the row as *Row:* `<id>`.
 *
 * Never able to fail or undo the completion: it runs after the write, is never awaited by it, and its outcome is one
 * engine event. A notice that cannot be found or deleted is raised in the engine alerts channel with the reason,
 * never dropped. A notice already gone is success. A voided or still-pending row keeps its notice.
 */
import * as slack from './slack';
import * as engineEvents from './engineEvents';
import * as publishGate from './publishGate';
import { LOG_REVIEW_CHANNEL, findParkedPost, resolve } from './layer0Void';

export function becameComplete(sent: Record<string, unknown> | null | undefined, changed: boolean): boolean {
  return changed && String((sent ?? {}).Status ?? '').trim().toLowerCase() === 'completed';
}

export async function deleteOnComplete(rowId: string): Promise<{ ok: boolean; deleted: boolean; detail: string }> {
  let out: { ok: boolean; deleted: boolean; detail: string };
  let row: Awaited<ReturnType<typeof resolve>> | null = null;
  try {
    row = await resolve(rowId);
    const found = await findParkedPost(row);
    if (!found.ok) out = { ok: false, deleted: false, detail: found.error };
    else if (!found.ts) out = { ok: true, deleted: false, detail: `no review notice for row ${row.id} in ${LOG_REVIEW_CHANNEL}, so nothing to delete` };
    else {
      const r = await slack.botCall('chat.delete', { channel: LOG_REVIEW_CHANNEL, ts: found.ts });
      out = r.ok || r.error === 'message_not_found'
        ? { ok: true, deleted: true, detail: `deleted the review notice ${found.ts} for row ${row.id}` }
        : { ok: false, deleted: false, detail: `Slack would not delete the review notice ${found.ts} for row ${row.id}: ${String(r.error ?? 'unknown error')}` };
    }
  } catch (e) {
    out = { ok: false, deleted: false, detail: `could not read parked row ${rowId}: ${e instanceof Error ? e.message : String(e)}` };
  }
  const subject = row?.submission_id ?? `layer0:${rowId}`;
  await engineEvents
    .record({ event_type: out.ok ? 'layer0_review_notice_deleted' : 'layer0_review_notice_delete_failed', subject_id: subject, actor: 'layer0 completion', detail: { row_id: rowId, ...out }, dedupe_key: out.ok ? `layer0_notice_deleted:${rowId}` : undefined })
    .catch((e) => console.error(`[layer0-notice] event not recorded: ${e instanceof Error ? e.message : String(e)}`));
  if (!out.ok) {
    console.error(`[layer0-notice] ${out.detail}`);
    const p = await publishGate.post(`:warning: The "In review, incomplete" notice for completed log ${subject} (row ${rowId}) was not deleted from <#${LOG_REVIEW_CHANNEL}>: ${out.detail}. The log's completion stands; delete the notice by hand.`).catch((e) => ({ ok: false as const, error: String(e) }));
    if (!p.ok) console.error(`[layer0-notice] the alert was not posted either: ${p.error}`);
  }
  return out;
}

/**
 * Once at boot: a log completed in the last 3 days whose notice has had no outcome yet (no
 * layer0_review_notice_deleted event) gets the same delete. Catches a completion that landed while this process was
 * down or before this hook existed (row 31, completed 9 Nov 15:19 UTC, the deploy after). Never awaited.
 */
export async function sweepRecent(): Promise<{ checked: number; deleted: number; failed: number }> {
  const { query } = await import('./pg');
  const r = await query<{ id: string }>(
    `SELECT h.id::text FROM engine_layer0_holds h
      WHERE h.fields->>'Status' = 'completed' AND h.updated_at::timestamptz > now() - interval '3 days'
        AND NOT EXISTS (SELECT 1 FROM engine_events e WHERE e.event_type = 'layer0_review_notice_deleted' AND e.detail->>'row_id' = h.id::text)
      ORDER BY h.id`,
  );
  const out = { checked: 0, deleted: 0, failed: 0 };
  for (const row of r.rows) {
    out.checked += 1;
    const d = await deleteOnComplete(row.id);
    if (!d.ok) out.failed += 1;
    else if (d.deleted) out.deleted += 1;
  }
  return out;
}
