import { useState } from 'react';
import type { Resync } from '../../data';

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
  const reverted = r.overwritten.length ? ` · ${r.overwritten.length} ${r.overwritten.length === 1 ? 'change' : 'changes'} made here and never landed in Airtable ${r.overwritten.length === 1 ? 'was' : 'were'} reverted` : '';
  return { text: `Resync complete in ${secs} · ${totals}${refused}${reverted}`, tone: refused || reverted ? 'failing' : 'ok' };
}

/** The button, in the page header's right slot, the same on every page that has one. */
export function ResyncButton({ busy, onClick }: { busy: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} disabled={busy} className="btn btn-primary gap-1.5">
      {busy ? 'Reading Airtable…' : 'Resync from Airtable'}
    </button>
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
