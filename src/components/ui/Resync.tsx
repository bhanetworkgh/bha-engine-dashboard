import { useEffect, useState } from 'react';
import { getServerStatus, type Resync } from '../../data';
import { Button } from './Button';

/**
 * Resync from Airtable — the control and the line it leaves behind, in one
 * place so the four record pages that have one cannot word it differently.
 *
 * It arrived on Codex on 14 September; Build patterns, Commercial and Clients
 * got the same pass on 15 September. The semantics are identical everywhere:
 * **Airtable is the source of truth for every field it owns and this dashboard
 * does not win a disagreement.** Insert what Airtable has and we do not, update
 * what changed there, delete what is gone. A resync that only ever deleted is
 * what put the Codex page permanently behind its own base, and is the reason
 * this exists at all.
 *
 * It is manual, never on load and never scheduled, because it reads every field
 * of every row and it deletes.
 */

/**
 * One resync, as the line that appears in the corner.
 *
 * Three totals and an elapsed time, and nothing else: a run that changed
 * nothing says so in the same shape as one that changed everything. A table
 * that could not be read is never folded into a zero — it is counted and named
 * in the line, and the run reads as a failure, because "not read" and "empty"
 * are the distinction this whole pass exists to keep. The per-table breakdown
 * stays in the server log, in full, where somebody goes when a total looks
 * wrong.
 */
export function resyncToast(r: Resync): { text: string; tone: 'ok' | 'failing' } {
  const secs = `${(r.ms / 1000).toFixed(1)}s`;
  const unread = r.tables.filter((t) => !t.read);
  const totals = `${r.inserted} inserted, ${r.updated} updated, ${r.deleted} deleted`;
  if (!r.ran) return { text: `Resync failed after ${secs} · ${r.note}`, tone: 'failing' };
  if (unread.length) {
    const named = unread.map((t) => t.label).join(', ');
    return {
      text: `Resync finished in ${secs} · ${totals} · ${named} could not be read, so nothing under ${unread.length === 1 ? 'it' : 'them'} changed`,
      tone: 'failing',
    };
  }
  /**
   * A change of our own that Airtable never had, reverted. Correct — Airtable
   * owns the field — and never silent, because a decision made here
   * disappearing without mention is the thing this dashboard exists to stop.
   */
  /**
   * Rows Airtable handed over that this database would not store. Every table
   * was read and the run did not fail, but what is on screen is still not what
   * Airtable holds, so the line says so rather than letting the totals imply
   * the two agree. The reason for each is in the server log.
   */
  const refused = r.refused ? ` · ${r.refused} ${r.refused === 1 ? 'row was' : 'rows were'} refused by this database` : '';
  const reverted = r.overwritten.length ? ` · ${r.overwritten.length} ${r.overwritten.length === 1 ? 'change' : 'changes'} made here ${r.overwritten.length === 1 ? 'was' : 'were'} reverted` : '';
  return { text: `Resync complete in ${secs} · ${totals}${refused}${reverted}`, tone: refused || reverted ? 'failing' : 'ok' };
}

/**
 * Whether Airtable is retired on this server (2026-09-22).
 *
 * Read once for the whole app and shared, rather than each page asking: six
 * pages carry a resync button and six requests for one boolean on every
 * navigation is a cost for nothing. It cannot change without a deploy — it is
 * an environment variable — so a value read once is a value that stays right
 * for as long as the tab is open.
 *
 * `null` while it is still being asked, and on a failure it stays `null` and
 * the button is drawn. That direction is deliberate: a button that is there
 * when it need not be costs a 410 and a sentence, and one that is missing when
 * it is needed costs somebody the final import with nothing on screen saying
 * where it went.
 */
let retiredOnce: Promise<boolean> | null = null;

export function useAirtableRetired(): boolean | null {
  const [retired, setRetired] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    retiredOnce ??= getServerStatus()
      .then((s) => s.airtable_retired === true)
      .catch(() => {
        retiredOnce = null;
        return false;
      });
    void retiredOnce.then((v) => {
      if (live) setRetired(v);
    });
    return () => {
      live = false;
    };
  }, []);
  return retired;
}

/**
 * The button, in the page header's right slot (2026-09-23, Destiny): drawn
 * only where the page's pass reads a live source, and labelled by that source.
 * Engine health reads the incident ledger from BHARAG, so it keeps a "Resync
 * from BHARAG" button. Every other page's pass read the retired store alone,
 * so on those pages the button draws nothing — the call sites stay, the
 * button does not.
 */
export function ResyncButton({ busy, onClick, alsoReads }: { busy: boolean; onClick: () => void; /** The live source this page's pass reads, e.g. "BHARAG". None, no button. */ alsoReads?: string }) {
  if (!alsoReads) return null;
  return (
    <Button onClick={onClick} loading={busy} className="gap-1.5" title={`Reads ${alsoReads} and brings this page up to date with it`}>
      {busy ? `Reading ${alsoReads}…` : `Resync from ${alsoReads}`}
    </Button>
  );
}

/**
 * Running one: the button's busy state, the refetch afterwards so what is on
 * screen is what the resync left behind, and the toast either way.
 */
export function useResync({
  run,
  reload,
  setToast,
}: {
  run: () => Promise<Resync>;
  reload: () => Promise<void>;
  setToast: (t: { text: string; tone: 'ok' | 'failing' }) => void;
}): { busy: boolean; start: () => void } {
  const [busy, setBusy] = useState(false);
  const start = () => {
    if (busy) return;
    setBusy(true);
    void (async () => {
      try {
        const r = await run();
        await reload();
        setToast(resyncToast(r));
      } catch (e) {
        setToast({ text: e instanceof Error ? e.message : 'The resync did not run.', tone: 'failing' });
      } finally {
        setBusy(false);
      }
    })();
  };
  return { busy, start };
}
