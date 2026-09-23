/**
 * The in-process change bus behind the live pages (2026-09-23, Destiny).
 *
 * Every write path calls `changed(kind, id, db)` once its row is stored, and
 * GET /api/events streams each change to every open page as a Server-Sent
 * Event. A page re-reads its own route when a kind it shows changes, so an
 * approval, a Paid tick or a new lead is on screen in an open tab without a
 * reload and without anybody pressing anything.
 *
 * **One process, so no broker.** The service runs as a single Render instance
 * and every write lands in this process, so an EventEmitter is the whole of
 * it. A second instance would need a shared channel (Postgres LISTEN/NOTIFY
 * would do, with no new dependency) and this file is where it would go.
 *
 * **An event carries what changed, never the row.** `{kind, id, at}` and
 * nothing else: the page re-reads through its own route, behind its own
 * cookie, so the stream cannot become a second read path that drifts from the
 * first, and nothing on it is worth reading to somebody who should not have it.
 *
 * **Emitted after the commit, never before.** A page told before the commit
 * would re-read the row as it was and then hear nothing more, so a write
 * inside a transaction queues its event on `afterCommit` and a rollback drops
 * it. A write outside one emits at once.
 */
import { EventEmitter } from 'node:events';
import { afterCommit, type Queryable } from './pg';

export interface ChangeEvent {
  /** A mirror kind (`codex`, `pay_sessions`, …) or a non-mirror one (`vfarm_leads`, `repairs`, `executions`, `registry`). */
  kind: string;
  /** The row's own id where there is one; null for a change to many rows at once. */
  id: number | string | null;
  at: string;
}

const bus = new EventEmitter();
// Every open tab is one listener. The default cap of ten is a leak warning for
// a library, not a limit that means anything for a dashboard six people use.
bus.setMaxListeners(0);

/** Announces one change, after `db`'s transaction commits when there is one. */
export function changed(kind: string, id: number | string | null = null, db?: Queryable | null): void {
  afterCommit(db, () => {
    const e: ChangeEvent = { kind, id, at: new Date().toISOString() };
    bus.emit('change', e);
  });
}

/** Subscribes to every change. Returns the unsubscribe. */
export function onChange(fn: (e: ChangeEvent) => void): () => void {
  bus.on('change', fn);
  return () => {
    bus.off('change', fn);
  };
}

/** How many streams are open, for the boot line and the status route. */
export function listeners(): number {
  return bus.listenerCount('change');
}
