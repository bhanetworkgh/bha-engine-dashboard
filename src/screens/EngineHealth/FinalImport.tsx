import { useState } from 'react';
import { FINAL_IMPORT_GROUPS, runFinalImport, type FinalImport, type FinalImportGroup } from '../../data';
import { useAirtableRetired } from '../../components/ui';

/**
 * Final import from Airtable (2026-09-22, Destiny) — one button, every
 * Airtable-backed kind, and a report that names what it did not take.
 *
 * It sits on Engine health rather than on a record page because it is not
 * about any one record kind: it is the last act of the engine cutover, and the
 * question it answers — did anything written in Airtable by hand get lost —
 * is an engine-health question.
 *
 * **It is not a resync and is deliberately not styled as one.** A resync is
 * Airtable-wins and deletes what Airtable no longer has; run after the cutover
 * it would take a loop Bays closed here and reopen it, because the Airtable row
 * still says Open. This keeps what has changed here since the cutover, lists
 * every such row with both values, and deletes nothing.
 *
 * The one number that matters on it is **kept, newer here**: those are the rows
 * a person has to look at. Everything else is arithmetic.
 */

/** Each group, and what a reader would call it. The order the button runs them in. */
const GROUP_LABEL: Record<FinalImportGroup, string> = {
  loops: 'Open loops',
  codex: 'Codex entries',
  patterns: 'Build patterns',
  commercial: 'Commercial',
  clients: 'Clients',
  ns: 'North Star',
  rt: 'Research Twin',
  pay: 'Pay Tracker',
  engine_events: 'Engine health — error_counts and retry_attempts',
};

type State =
  | { phase: 'idle' }
  | { phase: 'running'; done: FinalImport[]; now: FinalImportGroup }
  | { phase: 'done'; done: FinalImport[]; failed: { group: FinalImportGroup; message: string }[] };

export default function FinalImportPanel() {
  const [state, setState] = useState<State>({ phase: 'idle' });
  const retired = useAirtableRetired();

  /**
   * Once Airtable is retired the import has already happened and its routes
   * answer 410, so the panel comes off the page with the resync buttons. Drawn
   * while the answer is still `null`, on the same rule the buttons follow: a
   * control that is there when it need not be costs a sentence, and one that is
   * missing when it is needed costs somebody the import.
   */
  if (retired) return null;

  /**
   * The groups run **one after another, never in parallel.** Nine groups at
   * once is nine full sweeps of somebody else's API from one click, which is
   * how a careful pass turns into a rate limit — and the workspace is over its
   * cap already, which is why this exists at all.
   *
   * A group that throws is recorded and the rest still run: one base being
   * unreadable is not a reason to leave the other eight unimported, and the
   * failure is named rather than folded into a zero.
   */
  async function start() {
    const done: FinalImport[] = [];
    const failed: { group: FinalImportGroup; message: string }[] = [];
    for (const group of FINAL_IMPORT_GROUPS) {
      setState({ phase: 'running', done: [...done], now: group });
      try {
        done.push(await runFinalImport(group));
      } catch (e) {
        failed.push({ group, message: e instanceof Error ? e.message : 'The import did not run.' });
      }
    }
    setState({ phase: 'done', done, failed });
  }

  const running = state.phase === 'running';
  const results = state.phase === 'idle' ? [] : state.done;
  const total = (k: 'inserted' | 'updated' | 'unchanged' | 'kept_newer_here' | 'refused') => results.reduce((n, r) => n + r[k], 0);
  const kept = results.flatMap((r) => r.kept);
  const unread = results.flatMap((r) => r.tables.filter((t) => !t.read).map((t) => ({ ...t, group: r.group })));

  return (
    <div className="card mx-6 mb-4 shrink-0 px-5 py-4 md:mx-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-[80ch]">
          <div className="text-[13px] font-medium text-ink">Final import from Airtable</div>
          <p className="mt-1 text-[11.5px] leading-relaxed text-faint">
            The last read of Airtable, for after the monthly cap resets. It takes anything written there by hand that
            this database never saw, and <span className="text-ink">keeps what has changed here</span> since the cutover
            rather than overwriting it — a loop closed here stays closed even though the Airtable row still says open.
            Nothing is deleted. Every row it kept is listed below with both values, so a person can decide.
          </p>
        </div>
        <button type="button" onClick={start} disabled={running} className="btn btn-primary shrink-0 gap-1.5">
          {running ? `Importing ${GROUP_LABEL[state.now]}…` : state.phase === 'done' ? 'Run it again' : 'Final import from Airtable'}
        </button>
      </div>

      {state.phase !== 'idle' && (
        <>
          <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 md:grid-cols-5">
            <Figure label="Inserted" value={total('inserted')} hint="Airtable had it, we did not" />
            <Figure label="Updated" value={total('updated')} hint="taken from Airtable" />
            <Figure label="Unchanged" value={total('unchanged')} hint="the two already agreed" />
            {/*
              The one figure that needs somebody, so it is the one with a tone.
              Never red: keeping a change made here is the correct outcome and
              the thing this pass exists to do — it is worth reading, not worth
              alarming about.
            */}
            <Figure label="Kept, newer here" value={total('kept_newer_here')} hint="changed here since the cutover" accent={total('kept_newer_here') > 0} />
            <Figure label="Refused" value={total('refused')} hint="this database would not store" tone={total('refused') ? 'failing' : undefined} />
          </div>

          {state.phase === 'done' && !!state.failed.length && (
            <div className="mt-4 rounded-[12px] bg-failing-soft px-4 py-3">
              <div className="text-[12px] font-medium text-failing">
                {state.failed.length} {state.failed.length === 1 ? 'group' : 'groups'} did not run, so nothing under{' '}
                {state.failed.length === 1 ? 'it' : 'them'} was imported
              </div>
              {state.failed.map((f) => (
                <div key={f.group} className="mt-1 text-[11.5px] leading-relaxed text-failing">
                  <span className="font-medium">{GROUP_LABEL[f.group]}</span> — {f.message}
                </div>
              ))}
            </div>
          )}

          {!!unread.length && (
            <div className="mt-4 rounded-[12px] bg-failing-soft px-4 py-3">
              <div className="text-[12px] font-medium text-failing">
                {unread.length} {unread.length === 1 ? 'table' : 'tables'} could not be read, and nothing under{' '}
                {unread.length === 1 ? 'it' : 'them'} was imported
              </div>
              {unread.map((t) => (
                <div key={`${t.group}-${t.table}`} className="mt-1 text-[11.5px] leading-relaxed text-failing">
                  <span className="font-medium">{t.label}</span> ({t.table}) — {t.reason}
                </div>
              ))}
            </div>
          )}

          {state.phase === 'done' && (
            <p className="mt-3 text-[11.5px] leading-relaxed text-faint">
              {kept.length === 0
                ? 'Nothing was kept back: no row Airtable holds had been changed here since the cutover, so every one of them was taken as it stands. Nothing was deleted.'
                : `${kept.length} ${kept.length === 1 ? 'row was kept as it is' : 'rows were kept as they are'} here, because ${kept.length === 1 ? 'it was' : 'they were'} changed by the engine or on a page after the cutover at ${results[0]?.cutover_at.slice(0, 10)}. Airtable's copy was not taken. Nothing was deleted.`}
            </p>
          )}

          {!!kept.length && (
            <div className="scroll-thin mt-3 overflow-x-auto">
              <table className="table-cards w-full border-collapse text-[12.5px]" style={{ minWidth: 900 }} aria-label="Rows kept as they are here">
                <thead>
                  <tr>
                    <Th>record</Th>
                    <Th>where</Th>
                    <Th>field</Th>
                    <Th>here</Th>
                    <Th>airtable</Th>
                    <Th>written here by</Th>
                  </tr>
                </thead>
                <tbody>
                  {kept.map((k) => (
                    <tr key={`${k.kind}-${k.record_id}`}>
                      <td className="td tabular td-clip text-ink" style={{ maxWidth: '28ch' }} title={k.natural_id ?? k.record_id}>
                        {k.natural_id ?? k.record_id}
                      </td>
                      <td className="td card-meta text-dim">{k.label}</td>
                      <td className="td card-meta text-dim">
                        {k.field ?? 'nothing differs'}
                        {k.differing > 1 && <span className="text-faint"> +{k.differing - 1} more</span>}
                      </td>
                      <td className="td td-clip text-ink" style={{ maxWidth: '30ch' }} title={k.here ?? ''}>
                        {k.here ?? '—'}
                      </td>
                      <td className="td td-clip text-dim" style={{ maxWidth: '30ch' }} title={k.airtable ?? ''}>
                        {k.airtable ?? '—'}
                      </td>
                      <td className="td card-meta whitespace-nowrap text-faint">
                        {k.source} · {k.updated_at.slice(0, 16).replace('T', ' ')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="sticky top-0 z-10 border-b border-line bg-panel px-3 py-2 text-left text-[11.5px] font-medium whitespace-nowrap text-faint">{children}</th>;
}

function Figure({ label, value, hint, tone, accent }: { label: string; value: number; hint: string; tone?: 'failing'; accent?: boolean }) {
  return (
    <div>
      <div className="text-[11.5px] font-medium text-faint">{label}</div>
      <div className={`display tabular text-[24px] leading-tight ${tone === 'failing' ? 'text-failing' : accent ? 'text-accent' : 'text-ink'}`}>{value}</div>
      <div className="mt-0.5 text-[11px] leading-snug text-faint">{hint}</div>
    </div>
  );
}
