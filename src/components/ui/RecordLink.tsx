import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

/**
 * A stable link per record (2026-09-22, Destiny).
 *
 * Bays links people into Airtable today. After the cutover those links point
 * at a base nothing writes to any more, so every record kind a person is sent
 * to needs an address of its own here — `/open-loops/LOOP-…`,
 * `/codex/CODEX-…` — that opens the record.
 *
 * **The address is the record's own id**, never this database's row id and
 * never the Airtable record id. A row id is local to this database and means
 * nothing to n8n or to a person; an Airtable record id *changes* when a loop is
 * moved between builder tables, which is exactly the moment somebody most wants
 * to follow a link. `loop_id` and `Codex Entry ID` travel with the row through
 * both, which is what makes them the right thing to address.
 *
 * One hook for both pages, so the two cannot drift into behaving differently —
 * the same reason the resync control is shared.
 */
export function useRecordLink<T>({
  base,
  rows,
  ready,
  keyOf,
  openId,
  setOpenId,
  onMissing,
}: {
  /** The page's own path, e.g. "/open-loops". */
  base: string;
  /** Every record the page holds, before any filter — a link must open a row a filter is hiding. */
  rows: T[];
  /** False while the rows are still arriving, so a link is not called missing before it was looked for. */
  ready: boolean;
  /** The record's own id, and the internal id the panel opens by. */
  keyOf: (row: T) => { natural: string | null; id: string };
  openId: string | null;
  setOpenId: (id: string | null) => void;
  /** Said once, when the rows are in and the link names nothing they hold. */
  onMissing: (recordId: string) => void;
}): void {
  /**
   * The id out of the path. `recordId` for a named param and `*` for the splat
   * the record pages use — see App.tsx for why a splat is what keeps the page
   * from remounting when the segment appears and disappears.
   */
  const params = useParams();
  const recordId = params.recordId ?? (params['*'] || undefined);
  const navigate = useNavigate();
  const said = useRef<string | null>(null);
  /**
   * Whether the incoming link has been dealt with yet.
   *
   * **This is the whole of what keeps the two effects from fighting**, and it
   * was found by driving a browser at the route rather than by reading the
   * code. Without it, both effects run in the same commit after the rows
   * arrive: the first sets the open record, the second still sees `openId` as
   * null and navigates back to the bare page — which wipes the id out of the
   * path before the first has been reflected. The link opened nothing, and did
   * it silently.
   */
  const [settled, setSettled] = useState(false);

  // The link, opened. Matched on the record's own id first and on the internal
  // id second, so an older link built on a row id still lands.
  useEffect(() => {
    if (!ready) return;
    if (!recordId) {
      setSettled(true);
      return;
    }
    const want = decodeURIComponent(recordId);
    const found = rows.find((r) => {
      const k = keyOf(r);
      return k.natural === want || k.id === want;
    });
    if (found) {
      const id = keyOf(found).id;
      if (openId !== id) setOpenId(id);
    } else if (said.current !== want) {
      /**
       * A link naming a record this dashboard does not hold. Said once per id
       * and never as a redirect: sending somebody quietly to the unfiltered
       * list would look like the record is there and they missed it.
       */
      said.current = want;
      onMissing(want);
    }
    setSettled(true);
    // `rows` and the callbacks are deliberately not dependencies: this runs when
    // the link or the loaded state changes, not on every re-render of the list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordId, ready]);

  /**
   * The address bar follows the open record, so the link is somewhere a person
   * can copy it from rather than something they have to know how to construct.
   *
   * `replace`, so the browser's back button leaves the page as it always has
   * rather than stepping back through every row that was opened on the way.
   */
  useEffect(() => {
    if (!ready || !settled) return;
    const row = openId ? rows.find((r) => keyOf(r).id === openId) : null;
    const want = row ? `${base}/${encodeURIComponent(keyOf(row).natural ?? keyOf(row).id)}` : base;
    if (window.location.pathname !== want) navigate(want, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openId, ready, settled]);
}
