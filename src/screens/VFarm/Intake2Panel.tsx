import { Pill } from '../../components/ui';
import type { VfarmLead } from '../../data';
import { INTAKE2_FIELDS, INTAKE2_SECTIONS, answerText, followUpPlan, type FollowUpStep, type Intake2File } from '../../data/intake2';

/**
 * Form 2 (the buyer's site and deployment specification, Intake-2 in the code) as the Early
 * Access page shows it (15 Oct 2026, Destiny: "intake-2, isn't that wording retired"). On screen
 * it is Form 2 everywhere; the code, the table columns and the events keep their names.
 */

const day = (iso: string | null | undefined) => {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
};

export function followUpsOf(lead: VfarmLead): FollowUpStep[] | null {
  return followUpPlan(lead.intake_2_invite, { answered_at: lead.intake_2_completed_at ?? null, closed: !!lead.closed_at });
}

/** One line for a card or a list row: what happened last, and what is next. */
export function followUpLine(lead: VfarmLead): { text: string; tone?: 'degraded' | 'failing' } | null {
  if (lead.intake_2) return { text: `Form 2 back ${day(lead.intake_2.submitted_at)}` };
  const steps = followUpsOf(lead);
  if (!steps) return (lead.stage ?? 1) === 2 && !lead.closed_at ? { text: 'Form 2 not sent yet', tone: 'degraded' } : null;
  const failed = steps.find((s) => s.state === 'failed');
  if (failed) return { text: `${failed.label} did not go`, tone: 'failing' };
  const unresp = steps.find((s) => s.key === 'unresponsive' && s.state === 'done');
  if (unresp) return { text: `Unresponsive since ${day(unresp.at)}`, tone: 'degraded' };
  const done = steps.filter((s) => s.state === 'done').slice(-1)[0];
  const next = steps.find((s) => s.state === 'due');
  const opened = lead.intake_2_invite?.opened_at ? ' · opened' : '';
  const parts = [done ? `${done.label} ${day(done.at)}` : null, next && next.at ? `${next.key === 'unresponsive' ? 'unresponsive' : next.label.toLowerCase()} ${day(next.at)}` : null].filter(Boolean);
  return { text: parts.join(' → ') + opened };
}

/** The four steps in a row: Form 2 sent, reminder 1, reminder 2, marked unresponsive. */
export function FollowUpTracker({ lead }: { lead: VfarmLead }) {
  const steps = followUpsOf(lead);
  if (!steps) return null;
  const opened = lead.intake_2_invite?.opened_at;
  return (
    <div>
      <ol className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {steps.map((s) => (
          <li
            key={s.key}
            className={`rounded-[10px] border px-3 py-2 ${
              s.state === 'failed' ? 'border-failing bg-failing-soft' : s.state === 'done' && s.key === 'unresponsive' ? 'border-degraded bg-degraded-soft' : s.state === 'done' ? 'border-line bg-accent-soft' : 'border-dashed border-line'
            }`}
          >
            <div className="text-[11.5px] text-dim">{s.label}</div>
            <div className={`text-[13px] font-medium ${s.state === 'stopped' ? 'text-faint' : 'text-ink'}`}>
              {s.state === 'done' ? `✓ ${day(s.at)}` : s.state === 'failed' ? `Did not go` : s.state === 'due' ? (s.at ? `Due ${day(s.at)}` : 'Waiting') : '—'}
            </div>
            {s.note && <div className="mt-0.5 text-[11px] leading-snug text-faint">{s.note}</div>}
          </li>
        ))}
      </ol>
      <p className="mt-2 text-[12px] text-dim">
        {lead.intake_2
          ? `They sent Form 2 back on ${day(lead.intake_2.submitted_at)}.`
          : opened
          ? `They opened the form on ${day(opened)} but have not sent it yet.`
          : 'They have not opened the form yet.'}{' '}
        Reminders go out by themselves; nothing here needs pressing.
      </p>
    </div>
  );
}

/** Where a Stage 2 lead is, in one tag, for the list. */
export function Intake2Tag({ lead }: { lead: VfarmLead }) {
  const l = followUpLine(lead);
  return l ? <Pill tone={l.tone === 'failing' ? 'failing' : l.tone === 'degraded' ? 'degraded' : 'default'}>{l.text}</Pill> : null;
}

/** Every Form 2 answer, by section, with the uploaded files as links. */
export function Form2Answers({ lead }: { lead: VfarmLead }) {
  const done = lead.intake_2;
  if (!done) return null;
  return (
    <div className="space-y-4">
      {INTAKE2_SECTIONS.map((sec) => (
        <section key={sec.title}>
          <h4 className="mb-1.5 text-[12px] font-medium text-dim">{sec.title}</h4>
          <dl className="divide-y divide-line rounded-[10px] border border-line">
            {sec.fields.map((n) => {
              const f = INTAKE2_FIELDS.find((x) => x.n === n)!;
              const v = done.answers[f.label];
              const files = f.kind === 'file' && Array.isArray(v) ? (v as Intake2File[]) : null;
              return (
                <div key={n} className="grid gap-x-4 px-3 py-2 text-[12.5px] sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
                  <dt className="text-dim">{f.label}</dt>
                  <dd className={`whitespace-pre-wrap ${v === undefined ? 'text-faint' : 'text-ink'}`}>
                    {v === undefined ? 'not answered' : files ? (
                      <ul>
                        {files.map((x) => (
                          <li key={x.file_id}>
                            {x.link ? (
                              <a className="link" href={x.link} target="_blank" rel="noreferrer">
                                {x.name}
                              </a>
                            ) : (
                              x.name
                            )}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      answerText(f, v)
                    )}
                  </dd>
                </div>
              );
            })}
          </dl>
        </section>
      ))}
      {done.drive_folder?.link && (
        <p className="text-[12px]">
          <a className="link" href={done.drive_folder.link} target="_blank" rel="noreferrer">
            Their uploaded files, in Drive
          </a>
        </p>
      )}
    </div>
  );
}
