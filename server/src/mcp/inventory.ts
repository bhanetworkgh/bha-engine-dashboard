/**
 * What each mirror kind holds, where it comes from, and how it gets filled.
 *
 * **This module exists because of a specific fault.** On 20 Sep 2026 the Pay
 * Tracker showed nothing. The cause was upstream — an n8n workflow writing zero
 * rows into Airtable — but finding that took four calls through this MCP plus
 * two in another system, because nothing here could compare what a source holds
 * against what the mirror holds. Then, after the upstream fix filled Airtable,
 * the page *still* showed nothing, because a mirror only fills on a resync that
 * no tool could trigger.
 *
 * So: `status` answers "has this been read at all" in one call, `diff` answers
 * "and does it match the source", and `RESYNC_ROUTE` is how the copy is made.
 *
 * **Both maps below are `Record<MirrorKind, …>`, deliberately.** A new mirror
 * kind will not compile until somebody says where it comes from and how it is
 * filled — including saying explicitly that it is filled by nothing. That is
 * the opposite of the failure this module is here to fix, where a kind could
 * exist and quietly have no way to be refreshed.
 */
import * as airtable from '../airtable';
import * as bharag from '../bharag';
import * as health from '../health';
import * as mirror from '../mirror';
import * as pay from '../pay';
import { query } from '../pg';
import * as sources from '../sources';
import * as store from '../store';
import type { Resync } from '../../../src/data/types';
import { McpError } from './source';

export type MirrorKind = mirror.MirrorKind;

/* ------------------------------------------------------------- the sources */

interface SourceTable {
  base: string;
  table: string;
  label: string;
}

/** Where a kind's rows come from. `system` is which service, not which table. */
interface SourceSpec {
  system: 'airtable' | 'bharag' | 'engine-only';
  /** Fixed tables. Empty where the tables are learned at run time. */
  tables: SourceTable[];
  /**
   * Set where the tables cannot be listed without reading something first —
   * the client questions live in whichever table each index row names.
   */
  dynamic?: string;
  note?: string;
}

const at = (loc: { base: string; table: string; label: string }): SourceTable => ({ base: loc.base, table: loc.table, label: loc.label });

export const SOURCE_OF: Record<MirrorKind, SourceSpec> = {
  loops: { system: 'airtable', tables: sources.LOOP_TABLES.map((t) => ({ base: sources.LOOPS_BASE, table: t.table, label: `Open Loops — ${t.label}` })) },
  codex: { system: 'airtable', tables: sources.CODEX_TABLES.map((t) => ({ base: sources.CODEX_BASE, table: t.table, label: `BHA Submissions — ${t.sheet}` })) },
  layer0: { system: 'airtable', tables: [at(sources.CODEX_LAYER0)] },
  patterns: { system: 'airtable', tables: [at(sources.PATTERNS)] },
  commercial: { system: 'airtable', tables: [at(sources.COMMERCIAL)] },
  'ns-asks': { system: 'airtable', tables: [at(sources.NORTH_STAR)] },
  'rt-asks': { system: 'airtable', tables: [at(sources.RESEARCH_TWIN)] },
  'rt-jobs': { system: 'airtable', tables: [at(sources.RESEARCH_JOBS)] },
  client_lanes: { system: 'airtable', tables: [at(sources.CLIENTS_INDEX)] },
  client_questions: {
    system: 'airtable',
    tables: [],
    dynamic: 'Each watched lane keeps its questions in the table its own index row names in `Table ID`, so the set of tables is read from the index rather than listed here. A questions table no index row names is never read.',
  },
  client_requests: { system: 'airtable', tables: [at(sources.CLIENT_REQUESTS)] },
  incidents: {
    system: 'bharag',
    tables: [],
    note: `Not Airtable: the incident ledger is BHARAG's ${bharag.BHARAG_URL}/incidents, read once per lane with that lane's own credential and \`status=open\`. diff_source_vs_mirror compares the ledger's open incidents, lane by lane, against the rows held here as open. It is not Airtable, so AIRTABLE_RETIRED does not stop it being read or resynced.`,
  },
  error_counts: { system: 'airtable', tables: [at(sources.ERROR_COUNTS)] },
  retry_attempts: { system: 'airtable', tables: [at(sources.RETRY_ATTEMPTS)] },
  pay_builders: { system: 'airtable', tables: [at(sources.PAY_BUILDERS)] },
  pay_sessions: { system: 'airtable', tables: [at(sources.PAY_SESSIONS)] },
  pay_statements: { system: 'airtable', tables: [at(sources.PAY_STATEMENTS)] },
  digests: {
    system: 'engine-only',
    tables: [at(mirror.DIGESTS)],
    note: 'Written only by the engine pushing to /api/engine/digests. No page resyncs it, so a gap here means n8n stopped posting rather than that nobody pressed a button.',
  },
  /**
   * The four Bays tables (2026-09-22). All engine-only: n8n writes them here
   * and reads them back here, nothing resyncs them, and after the cutover
   * Airtable holds no newer copy. The base each came out of is named so a
   * reader can still find the history; the mirror is the record from here.
   */
  channel_tracking: {
    system: 'engine-only',
    tables: [{ base: 'apprzpppxE2yV0q84', table: 'tblboJRTsFSkHW0ra', label: 'Channel Tracking' }],
    note: 'One row per tracked Slack channel and the capture doc it is writing into, keyed on channel_id. `Bays — Message Capture` reads it on every Slack message, which is why an empty table here means Slack messages are not being archived — it is the kind to check first when the capture pipeline looks quiet. Written only by the engine posting to /api/engine/channel_tracking.',
  },
  review_returns: {
    system: 'engine-only',
    tables: [{ base: 'appEmdKshNVTl64Zf', table: 'tblStfkeUZH7n2vmt', label: 'Review Returns' }],
    note: 'The send-back rounds on a submitted log, one row per round. It carries no id this dashboard can derive, so n8n supplies "natural_id" in the envelope. Written only by the engine posting to /api/engine/review_returns.',
  },
  lane_backlog: {
    system: 'engine-only',
    tables: [at(sources.LANE_BACKLOG)],
    note: 'In the Bays Tools Router base, keyed on task_id. Written by the engine posting to /api/engine/lane_backlog. The table id is recorded from 23 Sep 2026 because the final import reads it — it was left out while nothing did, on the rule that a constant with no caller is one nobody notices going stale.',
  },
  deep_think_log: {
    system: 'engine-only',
    tables: [at(sources.DEEP_THINK_LOG)],
    note: 'In the Bays Tools Router base. Written by the engine posting to /api/engine/deep_think_log with "natural_id" in the envelope; the final import keys the rows it brings across on their Airtable record id, because the table has no id column of its own.',
  },
  /**
   * The two Airtable-backed kinds added on 2026-09-23. Unlike the four above
   * these are not engine-only: both hold real rows in Airtable, both are swept
   * by a resync, and both are in the final import.
   */
  builder_profiles: {
    system: 'airtable',
    tables: [at(sources.BUILDER_PROFILES)],
    note: 'One row per builder, keyed on user_id — the Slack id. It is what makes onboarding a row rather than a deploy: a loop or a Codex entry is accepted for any builder this table knows, with no Airtable table of their own. Its resync has no button on any page, because nothing in the interface reads it yet; run it from here.',
  },
  pattern_candidates: {
    system: 'airtable',
    tables: [at(sources.PATTERN_CANDIDATES)],
    note: 'A pattern somebody flagged that an architect has not yet turned into one. Same base as Build Patterns, and that page\'s one Resync from Airtable sweeps both.',
  },
};

/* ------------------------------------------------------------ the resyncs */

/**
 * Which resync fills a kind — the same call the page's own button makes.
 *
 * Several kinds share one: pressing Resync on Engine health reads all three of
 * its sources, and on Clients all three of its tables, because that is how the
 * page does it. Saying so here rather than inventing a per-kind pass means the
 * tool cannot fill a table in a way the page never would.
 */
interface ResyncRoute {
  /** What a reader would call it: the page's button. */
  label: string;
  /** The kinds this one pass fills, so the answer can name its siblings. */
  fills: MirrorKind[];
  run: (actor: string) => Promise<Resync>;
}

const patternsRoute: ResyncRoute = { label: 'Build patterns — Resync from Airtable', fills: ['patterns', 'pattern_candidates'], run: (a) => store.resync('patterns', a) };
const clientsRoute: ResyncRoute = { label: 'Clients — Resync from Airtable', fills: ['client_lanes', 'client_questions', 'client_requests'], run: (a) => store.resync('clients', a) };
const codexRoute: ResyncRoute = { label: 'Codex entries — Resync from Airtable', fills: ['codex', 'layer0'], run: (a) => store.resyncCodex(a) };
const rtRoute: ResyncRoute = { label: 'Research Twin — Resync from Airtable', fills: ['rt-asks', 'rt-jobs'], run: (a) => store.resync('rt', a) };
const payRoute: ResyncRoute = { label: 'Pay Tracker — Resync from Airtable', fills: ['pay_builders', 'pay_sessions', 'pay_statements'], run: (a) => pay.resync(a) };
const healthRoute: ResyncRoute = { label: 'Engine health — Resync', fills: ['incidents', 'error_counts', 'retry_attempts'], run: (a) => health.resync(a) };

export const RESYNC_ROUTE: Record<MirrorKind, ResyncRoute | null> = {
  loops: { label: 'Open loops — Resync from Airtable', fills: ['loops'], run: (a) => store.resync('loops', a) },
  codex: codexRoute,
  layer0: codexRoute,
  patterns: patternsRoute,
  commercial: { label: 'Commercial — Resync from Airtable', fills: ['commercial'], run: (a) => store.resync('commercial', a) },
  'ns-asks': { label: 'North Star — Resync from Airtable', fills: ['ns-asks'], run: (a) => store.resync('ns', a) },
  'rt-asks': rtRoute,
  'rt-jobs': rtRoute,
  client_lanes: clientsRoute,
  client_questions: clientsRoute,
  client_requests: clientsRoute,
  incidents: healthRoute,
  error_counts: healthRoute,
  retry_attempts: healthRoute,
  pay_builders: payRoute,
  pay_sessions: payRoute,
  pay_statements: payRoute,
  // Nothing resyncs the digest deliveries: the engine posts them or they do not
  // arrive. Said explicitly, because a null here is a fact and not an omission.
  digests: null,
  /**
   * Nor the four Bays tables (2026-09-22), and for a stronger reason than the
   * digests: after the cutover n8n writes them here and reads them back here,
   * so there is no second copy that could be newer. A resync would have nothing
   * to read and nothing to reconcile against.
   */
  channel_tracking: null,
  review_returns: null,
  lane_backlog: null,
  deep_think_log: null,
  /**
   * These two do resync (2026-09-23). Build patterns' own button sweeps the
   * candidates beside the patterns; Builder Profiles has a pass of its own
   * with no button on any page, because nothing in the interface reads it yet
   * — this tool is how it is run.
   */
  builder_profiles: { label: 'Builder Profiles — resync (no page button; run it from here)', fills: ['builder_profiles'], run: (a) => store.resync('builders', a) },
  pattern_candidates: patternsRoute,
};

export function assertKind(kind: string): MirrorKind {
  if (!mirror.isKind(kind)) {
    throw new McpError('no_such_kind', `"${kind}" is not a mirror kind. One of: ${mirror.KIND_LIST.join(', ')}.`);
  }
  return kind;
}

/* --------------------------------------------------------------- status */

export interface KindStatus {
  kind: MirrorKind;
  table: string;
  label: string;
  rows: number;
  /** The newest `updated_at` in the table, which is when a row last changed. */
  last_changed: string | null;
  first_seen: string | null;
  /**
   * How the rows got here. `engine` is n8n posting to /api/engine/:kind;
   * `airtable` is a resync sweeping the source; `ui` is a change made on a page.
   */
  by_source: Record<string, number>;
  source: {
    system: SourceSpec['system'];
    tables: { base: string; table: string; label: string; link: string }[];
    dynamic: string | null;
    note: string | null;
  };
  resync: { available: boolean; label: string | null; also_fills: MirrorKind[] };
  /** The one sentence worth reading first. */
  verdict: string;
}

/**
 * Every kind, or one.
 *
 * The `verdict` is the field this tool exists for: "never read" and "empty
 * because the source is empty" look identical in a row count, and only one of
 * them is a dashboard fault. Four tool calls went into telling those apart on
 * 20 Sep; this says it in one.
 */
export async function status(only: MirrorKind | null): Promise<{ kinds: KindStatus[]; note: string }> {
  const list = only ? [only] : mirror.KIND_LIST;
  const out: KindStatus[] = [];

  for (const kind of list) {
    const spec = mirror.KINDS[kind];
    const src = SOURCE_OF[kind];
    const route = RESYNC_ROUTE[kind];

    const agg = await query<{ n: string; last: Date | null; first: Date | null }>(
      `SELECT count(*)::text AS n, max(updated_at) AS last, min(first_seen_at) AS first FROM "${spec.table}"`,
    );
    const bySource = await query<{ source: string; n: string }>(`SELECT source, count(*)::text AS n FROM "${spec.table}" GROUP BY source ORDER BY 2 DESC`);
    const rows = Number(agg.rows[0]?.n ?? 0);
    const by_source: Record<string, number> = {};
    for (const r of bySource.rows) by_source[r.source] = Number(r.n);

    const iso = (d: Date | string | null): string | null => (d ? new Date(d).toISOString() : null);
    const last = iso(agg.rows[0]?.last ?? null);

    const verdict =
      rows === 0
        ? route
          ? `Empty. This table has never held a row, so the page reading it shows nothing — and that is either a source with nothing in it or a resync nobody has run. Run diff_source_vs_mirror("${kind}") to tell those apart; "${route.label}" is what fills it.`
          : `Empty, and nothing resyncs this kind — it is filled only by the engine posting to /api/engine/${kind}. An empty table here means those posts are not arriving.`
        : `${rows} row(s), last changed ${last ?? 'never recorded'}.${by_source.engine ? ` ${by_source.engine} arrived from the engine.` : ' None arrived from the engine.'}${by_source.airtable ? ` ${by_source.airtable} came in on a resync.` : ''}`;

    /**
     * Once Airtable is retired every kind's source **is** the engine, and this
     * says so rather than going on naming a base nothing reads (2026-09-22).
     * The tables stay listed, because they are where the history came from and
     * somebody will want to find it; what changes is the claim about where the
     * rows come from now, and that a resync is no longer a thing that can be
     * run.
     */
    const retired = airtable.retired() && src.system === 'airtable';
    out.push({
      kind,
      table: spec.table,
      label: spec.label,
      rows,
      last_changed: last,
      first_seen: iso(agg.rows[0]?.first ?? null),
      by_source,
      source: {
        system: retired ? 'engine-only' : src.system,
        tables: src.tables.map((t) => ({ ...t, link: `https://airtable.com/${t.base}/${t.table}` })),
        dynamic: src.dynamic ?? null,
        note: retired
          ? `${airtable.RETIRED_REASON}${src.note ? ` — ${src.note}` : ''} The table(s) listed are where these rows came from before the cutover, kept here so the history can still be found.`
          : (src.note ?? null),
      },
      resync: retired
        ? { available: false, label: null, also_fills: [] }
        : { available: Boolean(route), label: route?.label ?? null, also_fills: route ? route.fills.filter((k) => k !== kind) : [] },
      verdict: retired && rows === 0 ? `Empty, and Airtable is retired — this kind is filled only by the engine posting to /api/engine/${kind}, so an empty table here means those posts are not arriving.` : verdict,
    });
  }

  return {
    kinds: out,
    note: 'Row counts and timestamps are read from the engine_* tables in this process’s own database. `by_source` is the `source` column each row was written with: `engine` is n8n posting to /api/engine/:kind, `airtable` is a resync sweep, `ui` is a change made on a page. This tool reads nothing external and costs one query per kind — diff_source_vs_mirror is the one that calls the source.',
  };
}

/* ----------------------------------------------------------------- diff */

export interface DiffResult {
  kind: MirrorKind;
  table: string;
  source_rows: number | null;
  mirror_rows: number;
  difference: number | null;
  in_source_only: { key: string; table: string }[];
  in_mirror_only: { key: string; table: string | null }[];
  tables_read: { label: string; table: string; rows: number | null; error: string | null }[];
  keys_shown_cap: number;
  ms: number;
  verdict: string;
  note: string;
}

/** Ten each way. Enough to recognise a pattern, cheap enough to always return. */
const KEY_CAP = 10;

/**
 * Counts the source against the mirror and names up to ten keys on each side.
 *
 * **This is the slow one and the description says so.** It reads the Airtable
 * tables whole — Airtable has no way to ask for record ids alone, and the one
 * field that works as a probe (`Submission ID`) only exists in the seven loop
 * and Codex tables — so this is a full read and it costs what a resync costs to
 * fetch. `get_mirror_status` is the cheap question; this is the one that
 * settles an argument.
 *
 * **A table that could not be read is never counted as empty.** Its error is
 * named, the totals say they are incomplete, and no key is reported missing on
 * the strength of a read that failed. That is the same rule the resyncs follow,
 * and for the same reason: a refusal read as an emptied table deletes rows.
 */
export async function diff(kind: MirrorKind): Promise<DiffResult> {
  const spec = mirror.KINDS[kind];
  const src = SOURCE_OF[kind];
  const t0 = Date.now();

  /**
   * Retired first, because it is the more specific answer (2026-09-22). Once
   * Airtable is retired there is no second copy for either of these tools to
   * compare against or refill from — the mirror is the record — so both refuse
   * by name rather than reading a base nothing depends on any more.
   */
  // BHARAG, not Airtable: compared on its own terms, and never stopped by the
  // Airtable retirement (2026-09-22) — the ledger is still the source.
  if (kind === 'incidents') return diffIncidents(t0);

  if (airtable.retired() && src.system === 'airtable') {
    throw new McpError('airtable_retired', `${airtable.RETIRED_REASON} There is no second copy to compare "${kind}" against: get_mirror_status("${kind}") is what this database holds, and it is the whole of it.`);
  }
  if (src.system !== 'airtable') {
    throw new McpError(
      'not_comparable',
      `"${kind}" does not come from an Airtable table, so there is nothing to count against. ${src.note ?? ''} Use get_mirror_status("${kind}") for what this database holds.`.trim(),
    );
  }
  if (!airtable.airtableConfigured()) {
    throw new McpError('not_configured', 'AIRTABLE_TOKEN is not set on this service, so the source cannot be read at all. This is not an empty source — it is an unread one.');
  }

  /** The tables to read. For the client questions they are learned from the index. */
  let tables = src.tables;
  if (kind === 'client_questions') {
    const lanes = await query<{ t: string; label: string }>(
      `SELECT DISTINCT fields->>'Table ID' AS t, coalesce(fields->>'Lane ID', 'a lane') AS label
         FROM "${mirror.KINDS.client_lanes.table}" WHERE fields->>'Table ID' IS NOT NULL`,
    );
    if (!lanes.rows.length) {
      throw new McpError(
        'index_unread',
        `The questions tables are named by the watched-clients index, and ${mirror.KINDS.client_lanes.table} holds no row with a "Table ID". Resync the clients kind first — without the index there is no list of tables to read, and guessing one would read a table no index row names.`,
      );
    }
    tables = lanes.rows.map((r) => ({ base: sources.CLIENTS_INDEX.base, table: r.t, label: `Client questions — ${r.label}` }));
  }

  const read: DiffResult['tables_read'] = [];
  const sourceIds = new Set<string>();
  const idTable = new Map<string, string>();
  let anyFailed = false;

  for (const t of tables) {
    try {
      const records = await airtable.listRecords(t.base, t.table, 15_000);
      read.push({ label: t.label, table: t.table, rows: records.length, error: null });
      for (const r of records) {
        sourceIds.add(r.id);
        idTable.set(r.id, t.table);
      }
    } catch (e) {
      anyFailed = true;
      read.push({ label: t.label, table: t.table, rows: null, error: e instanceof Error ? e.message : String(e) });
    }
  }

  const held = await query<{ airtable_record_id: string | null; natural_id: string | null }>(
    `SELECT airtable_record_id, natural_id FROM "${spec.table}"`,
  );
  const mirrorIds = new Set(held.rows.map((r) => r.airtable_record_id).filter((v): v is string => Boolean(v)));
  const mirrorRows = held.rows.length;
  const sourceRows = anyFailed ? null : sourceIds.size;

  const inSourceOnly = [...sourceIds].filter((id) => !mirrorIds.has(id)).slice(0, KEY_CAP).map((id) => ({ key: id, table: idTable.get(id) ?? 'unknown' }));
  // Only meaningful where every source table was read: a row absent from a
  // table nobody could read is not a row that is missing upstream.
  const inMirrorOnly = anyFailed
    ? []
    : [...mirrorIds].filter((id) => !sourceIds.has(id)).slice(0, KEY_CAP).map((id) => ({ key: id, table: null }));

  const verdict = anyFailed
    ? `Incomplete: ${read.filter((r) => r.error).length} of ${read.length} source table(s) could not be read, so the source count is not stated and nothing is reported as missing from the source. The named errors are the thing to fix first.`
    : sourceRows === 0 && mirrorRows === 0
      ? 'Both empty. The source holds nothing, so the mirror holding nothing is correct and the page showing nothing is the truth rather than a fault.'
      : sourceRows === mirrorRows && inSourceOnly.length === 0 && inMirrorOnly.length === 0
        ? `Matched: ${sourceRows} row(s) on both sides, same record ids.`
        : sourceRows! > mirrorRows
          ? `The source holds ${sourceRows} and this database holds ${mirrorRows}: ${sourceRows! - mirrorRows} row(s) have not been copied. ${RESYNC_ROUTE[kind] ? `Run resync("${kind}").` : 'Nothing resyncs this kind; the engine has to post them.'}`
          : `This database holds ${mirrorRows} and the source holds ${sourceRows}: ${mirrorRows - sourceRows!} row(s) are here that the source no longer has. A resync would delete them.`;

  return {
    kind,
    table: spec.table,
    source_rows: sourceRows,
    mirror_rows: mirrorRows,
    difference: sourceRows === null ? null : sourceRows - mirrorRows,
    in_source_only: inSourceOnly,
    in_mirror_only: inMirrorOnly,
    tables_read: read,
    keys_shown_cap: KEY_CAP,
    ms: Date.now() - t0,
    verdict,
    note: `Compared on Airtable record ids, which are unique everywhere. Up to ${KEY_CAP} keys are named on each side — enough to see a pattern, not a list to work through. A row the engine wrote before Airtable had one carries no record id and is counted in the mirror total but cannot be compared; ${held.rows.filter((r) => !r.airtable_record_id).length} of the ${mirrorRows} held rows are in that position.`,
  };
}

/**
 * The incident ledger against what is held, lane by lane (2026-09-22).
 *
 * The ledger is read with `status=open`, so the comparison is between the
 * incidents BHARAG calls open now and the rows this database holds as open —
 * not a row count, because closed incidents are kept here on purpose and are
 * never in the ledger's answer. A lane that is not keyed or refused is named
 * and never counted as a lane with nothing open.
 */
async function diffIncidents(t0: number): Promise<DiffResult> {
  const spec = mirror.KINDS.incidents;
  const read: DiffResult['tables_read'] = [];
  const ledger = new Map<string, string>();
  let anyFailed = false;
  for (const lane of Object.keys(bharag.LANE_KEY_VARS)) {
    try {
      const rows = await bharag.openIncidents(lane);
      read.push({ label: `BHARAG incidents — ${lane}`, table: lane, rows: rows.length, error: null });
      for (const r of rows) if (typeof r.entity_id === 'string') ledger.set(r.entity_id, lane);
    } catch (e) {
      anyFailed = true;
      read.push({ label: `BHARAG incidents — ${lane}`, table: lane, rows: null, error: e instanceof Error ? e.message : String(e) });
    }
  }
  const held = await query<{ natural_id: string | null; lane_id: string | null; open_now: boolean | null }>(
    `SELECT natural_id, lane_id, open_now FROM "${spec.table}"`,
  );
  const heldOpen = new Map(held.rows.filter((r) => r.open_now !== false && r.natural_id).map((r) => [r.natural_id!, r.lane_id]));
  const readLanes = new Set(read.filter((r) => !r.error).map((r) => r.table));
  const sourceOnly = [...ledger.keys()].filter((id) => !heldOpen.has(id));
  const mirrorOnly = [...heldOpen.entries()].filter(([id, lane]) => lane && readLanes.has(lane) && !ledger.has(id)).map(([id]) => id);
  const sourceRows = anyFailed ? null : ledger.size;
  const verdict = anyFailed
    ? `Incomplete: ${read.filter((r) => r.error).length} lane(s) could not be read, so nothing is reported missing under them. ${read.filter((r) => r.error).map((r) => `${r.table}: ${r.error}`).join(' · ')}`
    : sourceOnly.length === 0 && mirrorOnly.length === 0
      ? `Matched: the ledger has ${ledger.size} open incident(s) and this database holds the same ${heldOpen.size} as open.`
      : `The ledger has ${ledger.size} open and this database holds ${heldOpen.size} as open: ${sourceOnly.length} open in the ledger are not held as open here, and ${mirrorOnly.length} held as open here are no longer open in the ledger. resync("incidents") reconciles both, and deletes nothing.`;
  return {
    kind: 'incidents',
    table: spec.table,
    source_rows: sourceRows,
    mirror_rows: heldOpen.size,
    difference: sourceRows === null ? null : sourceRows - heldOpen.size,
    in_source_only: sourceOnly.slice(0, KEY_CAP).map((id) => ({ key: id, table: ledger.get(id) ?? 'unknown' })),
    in_mirror_only: mirrorOnly.slice(0, KEY_CAP).map((id) => ({ key: id, table: heldOpen.get(id) ?? null })),
    tables_read: read,
    keys_shown_cap: KEY_CAP,
    ms: Date.now() - t0,
    verdict,
    note: `Compared on the ledger's entity_id, open against open. ${held.rows.length} incident row(s) are held in total; the ones held as closed are history this database keeps and the ledger's open list never returns, so they are not part of the comparison.`,
  };
}
