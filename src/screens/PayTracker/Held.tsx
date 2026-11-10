import { useMemo, useState } from 'react';
import type { PayNote } from '../../data';
import { pctOfDay, releasePayNote, releasePayNotes } from '../../data';
import { Button, EmptyState, Pill, RecordId } from '../../components/ui';

/**
 * Held (9 Nov 2026, Jason's DM 1794237173.152349). Every share of a day held until a stated condition
 * is met, oldest first, with the reason and who decided it. Release moves the whole held share into
 * this month's statement and needs the proof link; the person releasing is the admin login's own
 * Destiny or Jason. Several can be ticked and released on one proof (10 Nov 2026), because one merged
 * change often meets the condition on more than one log; each is still released on its own. Below it, every pay note so far, so a dock is never out of sight.
 *
 * Shares of a day, never money: Jason applies the rate at month end.
 */
const when = (iso: string | null) => (iso ? iso.slice(0, 10) : '—');
const share = (n: number) => pctOfDay(n);
const label: Record<string, string> = { full: 'full', half: 'half', none: 'none now', custom_fraction: 'custom' };
/** What the review suggested (LogStream, 9 Nov 2026), so an override shows: "same" or what it was. */
const suggestedLine = (n: PayNote): string | null => {
  const sg = n.suggested as { line?: string; none?: boolean } | null;
  return sg ? sg.line ?? null : null;
};
const suggestedShort = (n: PayNote): string => {
  const sg = n.suggested as { pay_recommendation?: string; credited_share?: number; none?: boolean } | null;
  if (!sg || sg.none || !sg.pay_recommendation) return '—';
  return sg.pay_recommendation === n.pay_recommendation && sg.credited_share === n.credited_share ? 'same' : `${label[sg.pay_recommendation] ?? sg.pay_recommendation} (${pctOfDay(sg.credited_share)})`;
};

export default function Held({ notes, held, reload }: { notes: PayNote[]; held: PayNote[]; reload: () => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const [proof, setProof] = useState('');
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ tone: 'ok' | 'failing'; text: string } | null>(null);
  const others = useMemo(() => notes.filter((n) => n.held_share <= 0), [notes]);
  const [picked, setPicked] = useState<string[]>([]);
  const [groupProof, setGroupProof] = useState('');
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const releasePicked = async () => {
    setBusy(true);
    setSaid(null);
    try {
      const r = await releasePayNotes(picked, groupProof.trim());
      setSaid({ tone: r.failed ? 'failing' : 'ok', text: r.message });
      setPicked([]);
      setGroupProof('');
      reload();
    } catch (e) {
      setSaid({ tone: 'failing', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const release = async (n: PayNote) => {
    setBusy(true);
    setSaid(null);
    try {
      const r = await releasePayNote({ submission_id: n.submission_id }, proof.trim());
      setSaid({ tone: 'ok', text: r.message });
      setOpen(null);
      setProof('');
      reload();
    } catch (e) {
      setSaid({ tone: 'failing', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-0 flex-1 overflow-auto px-6 pb-8 md:px-8">
      {said && <div className={`card mb-3 px-4 py-3 text-[12.5px] ${said.tone === 'ok' ? 'text-ok' : 'text-failing'}`}>{said.text}</div>}

      <h2 className="mb-2 text-[13px] font-semibold">Held until a condition is met</h2>
      {held.length === 0 ? (
        <EmptyState compact>Nothing is held. No approved log is waiting on a release condition.</EmptyState>
      ) : (
        <div className="flex flex-col gap-2">
          {held.length > 1 && (
            <div className="card flex flex-wrap items-center gap-2 px-4 py-3 text-[12.5px]">
              <span className="text-dim">{picked.length ? `${picked.length} ticked` : 'Tick the logs one proof covers to release them together'}</span>
              {picked.length > 0 && (
                <>
                  <input
                    className="input min-w-[28ch] flex-1"
                    placeholder="One proof link (https) that meets every ticked log's condition"
                    value={groupProof}
                    onChange={(e) => setGroupProof(e.target.value)}
                  />
                  <Button variant="primary" size="sm" disabled={busy || !/^https:\/\/\S+$/.test(groupProof.trim())} onClick={() => void releasePicked()}>
                    {busy ? 'Releasing…' : `Release ${picked.length} into this month`}
                  </Button>
                </>
              )}
            </div>
          )}
          {held.map((n) => (
            <div key={n.submission_id} className="card px-4 py-3 text-[12.5px]">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  {held.length > 1 && (
                    <input type="checkbox" aria-label={`Tick ${n.codex_entry_id ?? n.submission_id}`} checked={picked.includes(n.submission_id)} onChange={() => toggle(n.submission_id)} />
                  )}
                  <RecordId>{n.codex_entry_id ?? n.submission_id}</RecordId>
                  <span className="text-dim">{n.builder ?? 'Unknown builder'}</span>
                  <Pill tone="degraded">{share(n.held_share)} held</Pill>
                  {n.reason_tag && <Pill>{n.reason_tag}</Pill>}
                </div>
                <Button variant="secondary" size="sm" disabled={busy} onClick={() => setOpen(open === n.submission_id ? null : n.submission_id)}>
                  Release
                </Button>
              </div>
              <div className="mt-2">
                <span className="text-dim">Released when: </span>
                {n.release_condition}
              </div>
              {n.reason_note && <div className="mt-1 text-dim">{n.reason_note}</div>}
              <div className="mt-1 text-[11.5px] text-faint">
                {share(n.credited_share)} credited for {n.session_month ?? 'its month'}
                {n.docked_share > 0 ? `, ${share(n.docked_share)} docked` : ''} · decided by {n.decided_by_name ?? n.decided_by} on {when(n.decided_at)}
              </div>
              {open === n.submission_id && (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <input
                    className="input min-w-[28ch] flex-1"
                    placeholder="Proof link (https): the PR, the engine event, the Slack message"
                    value={proof}
                    onChange={(e) => setProof(e.target.value)}
                  />
                  <Button variant="primary" size="sm" disabled={busy || !/^https:\/\/\S+$/.test(proof.trim())} onClick={() => void release(n)}>
                    {busy ? 'Releasing…' : `Release ${share(n.held_share)} into this month`}
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <h2 className="mb-2 mt-6 text-[13px] font-semibold">Every other pay note</h2>
      {others.length === 0 ? (
        <div className="text-[12px] text-faint">None yet. A log with no pay note counts as a full day.</div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead className="text-left text-faint">
              <tr>
                <th className="px-3 py-2">log</th>
                <th className="px-3 py-2">builder</th>
                <th className="px-3 py-2">pay</th>
                <th className="px-3 py-2">credited</th>
                <th className="px-3 py-2">released</th>
                <th className="px-3 py-2">docked</th>
                <th className="px-3 py-2">reason</th>
                <th className="px-3 py-2">suggested</th>
                <th className="px-3 py-2">decided</th>
              </tr>
            </thead>
            <tbody>
              {others.map((n) => (
                <tr key={n.submission_id} className="border-t border-line">
                  <td className="px-3 py-2"><RecordId>{n.codex_entry_id ?? n.submission_id}</RecordId></td>
                  <td className="px-3 py-2 text-dim">{n.builder ?? '—'}</td>
                  <td className="px-3 py-2">{label[n.pay_recommendation] ?? n.pay_recommendation}</td>
                  <td className="tabular px-3 py-2">{share(n.credited_share)}</td>
                  <td className="tabular px-3 py-2" title={n.proof_link ?? undefined}>
                    {n.released_share > 0 ? `${share(n.released_share)} in ${n.release_month}` : '—'}
                  </td>
                  <td className="tabular px-3 py-2" title={n.reason_note ?? undefined}>{n.docked_share > 0 ? share(n.docked_share) : '—'}</td>
                  <td className="px-3 py-2 text-dim">{n.reason_tag ?? '—'}</td>
                  <td className="px-3 py-2 text-faint" title={suggestedLine(n) ?? undefined}>{suggestedShort(n)}</td>
                  <td className="px-3 py-2 text-faint">{n.decided_by_name ?? n.decided_by}, {when(n.decided_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
