/**
 * What this process has said and served since it booted, in a bounded ring.
 *
 * Render keeps the real logs and they are searchable there. This exists because
 * an MCP client cannot reach them: diagnosing the 20 Sep faults meant asking a
 * person to go and read a log, which is exactly the hop this server is supposed
 * to remove.
 *
 * **It is a ring in memory and the tool says so.** It starts empty at every
 * boot and every deploy, it holds the last few thousand lines and no more, and
 * a window that predates the buffer is reported as "not retained" rather than
 * as "nothing happened". An empty list that reads as "no errors" is the failure
 * worth designing out here — the same rule the unread-lane note follows on
 * Engine health.
 */

export type Level = 'log' | 'warn' | 'error';

export interface LogEntry {
  at: string;
  kind: 'request' | 'line';
  level: Level;
  /** Requests only. */
  method?: string;
  route?: string;
  status?: number;
  ms?: number;
  text: string;
}

/** Roughly a megabyte of text at typical line lengths, and a hard stop. */
const CAPACITY = 4000;

const ring: LogEntry[] = [];
let dropped = 0;
let bootedAt = new Date().toISOString();
let installed = false;

function push(e: LogEntry): void {
  ring.push(e);
  if (ring.length > CAPACITY) {
    ring.splice(0, ring.length - CAPACITY);
    dropped += 1;
  }
}

/** Every /api and /mcp request this process has answered. */
export function recordRequest(method: string, route: string, status: number, ms: number): void {
  push({
    at: new Date().toISOString(),
    kind: 'request',
    level: status >= 500 ? 'error' : status >= 400 ? 'warn' : 'log',
    method,
    route,
    status,
    ms,
    text: `${method} ${route} → ${status} in ${ms}ms`,
  });
}

function flatten(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return `${a.name}: ${a.message}`;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(' ');
}

/**
 * Taps `console` so the lines this server already writes are searchable.
 *
 * The originals are still called, so Render's log is unchanged and this is
 * additive rather than a redirection. Installed once from boot; calling it
 * twice is a no-op, because a second tap would record every line twice.
 */
export function install(): void {
  if (installed) return;
  installed = true;
  bootedAt = new Date().toISOString();
  for (const level of ['log', 'warn', 'error'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]): void => {
      try {
        const text = flatten(args);
        // The request lines are recorded with their own shape already; a
        // console echo of one would be the same event twice.
        if (text) push({ at: new Date().toISOString(), kind: 'line', level, text: text.slice(0, 2000) });
      } catch {
        // Recording a log line must never be the reason a log line is lost.
      }
      original(...(args as []));
    };
  }
}

/* ---------------------------------------------------------------- search */

export interface LogQuery {
  route?: string | null;
  /** '2xx' | '4xx' | '5xx' | 'errors' — 'errors' is 4xx and 5xx together. */
  status_class?: string | null;
  minutes?: number;
  limit?: number;
  contains?: string | null;
}

export interface LogSearch {
  retained: {
    installed: boolean;
    booted_at: string;
    held: number;
    capacity: number;
    oldest_held: string | null;
    lines_dropped_from_the_front: number;
  };
  window: { minutes: number; from: string };
  matched: number;
  entries: LogEntry[];
  truncated: boolean;
  note: string;
}

export function search(q: LogQuery): LogSearch {
  const minutes = Math.max(1, Math.min(24 * 60, q.minutes ?? 60));
  const limit = Math.max(1, Math.min(200, q.limit ?? 50));
  const from = Date.now() - minutes * 60_000;
  const cls = q.status_class?.trim().toLowerCase() || null;
  const route = q.route?.trim().toLowerCase() || null;
  const contains = q.contains?.trim().toLowerCase() || null;

  const hits = ring.filter((e) => {
    if (Date.parse(e.at) < from) return false;
    if (route && !(e.route ?? '').toLowerCase().includes(route) && !e.text.toLowerCase().includes(route)) return false;
    if (contains && !e.text.toLowerCase().includes(contains)) return false;
    if (cls) {
      if (e.status === undefined) return false;
      const band = `${Math.floor(e.status / 100)}xx`;
      if (cls === 'errors') {
        if (e.status < 400) return false;
      } else if (band !== cls) return false;
    }
    return true;
  });

  // Newest first, like every list in this dashboard.
  const newest = hits.slice().reverse();
  const entries = newest.slice(0, limit);
  const oldest = ring.length ? ring[0].at : null;

  const windowPredatesBuffer = Date.parse(bootedAt) > from;
  const note = !installed
    ? 'The log tap is not installed in this process, so nothing has been recorded. This is not "no errors" — it is "not retained here". Render holds the real log.'
    : hits.length === 0
      ? `Nothing in the buffer matches. ${
          windowPredatesBuffer
            ? `The window asked for reaches back before this process booted at ${bootedAt}, and the buffer starts empty at every boot and deploy — so anything older than that is not retained here rather than absent. `
            : ''
        }${dropped ? `${dropped} line(s) have already been pushed out of the front of the ring. ` : ''}Render holds the full log if the answer matters.`
      : `${hits.length} entr${hits.length === 1 ? 'y' : 'ies'} matched; ${entries.length} returned, newest first. The buffer is in memory only: it starts empty at every boot and holds the last ${CAPACITY} lines.`;

  return {
    retained: { installed, booted_at: bootedAt, held: ring.length, capacity: CAPACITY, oldest_held: oldest, lines_dropped_from_the_front: dropped },
    window: { minutes, from: new Date(from).toISOString() },
    matched: hits.length,
    entries,
    truncated: hits.length > entries.length,
    note,
  };
}
