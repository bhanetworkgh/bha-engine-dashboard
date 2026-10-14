import { useState } from 'react';
import { sendIntake2Invite, type VfarmLead } from '../../data';
import { Button } from '../../components/ui';
import { INTAKE2_FIELDS, INTAKE2_SECTIONS, answerText, type Intake2File } from '../../data/intake2';

const when = (iso: string | null | undefined): string => (iso ? `${iso.slice(0, 16).replace('T', ' ')} UTC` : '');

/**
 * Intake-2 on a lead (2026-10-14): the invite, every email sent for it, and,
 * once the buyer has answered, all 31 questions in the contract's order.
 * A send that failed is the one coloured line, because somebody has to act on
 * it. Nothing here marks a feasibility, pricing, ownership, licensing or
 * food-safety check confirmed: the answers are evidence, not a decision.
 */
export function Intake2Panel({ lead, onToast }: { lead: VfarmLead; onToast: (text: string, tone: 'ok' | 'failing') => void }) {
  const [busy, setBusy] = useState(false);
  const inv = lead.intake_2_invite ?? null;
  const done = lead.intake_2 ?? null;
  const sends = inv?.sends ?? [];
  const lastSend = sends[sends.length - 1] ?? null;
  const sent = sends.some((s) => s.outcome === 'sent');
  if (lead.stage !== 2 && !inv && !done) return null;

  async function invite(resend: boolean) {
    setBusy(true);
    try {
      const r = await sendIntake2Invite(lead.id, resend);
      onToast(r.message, r.ok ? 'ok' : 'failing');
    } catch (e) {
      onToast(e instanceof Error ? e.message : 'The invite did not send.', 'failing');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mb-4 rounded-[10px] border border-line px-3 py-2.5">
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
        <h3 className="kicker">Intake-2 · site and deployment specification</h3>
        {!done && lead.form_a && (
          <Button size="sm" variant="secondary" loading={busy} onClick={() => invite(sent)}>
            {sent ? 'Resend invite' : inv ? 'Send invite again' : 'Send invite'}
          </Button>
        )}
      </div>
      <ul className="space-y-0.5 text-[12px] text-dim">
        {!inv && <li>No invite yet. {lead.form_a ? 'Sending it makes the lead’s own link and emails it from admin@bhanetwork.org.' : 'This lead has no Form A record, so no invite can be tied to it.'}</li>}
        {inv && (
          <li>
            Invite {inv.invite_id}, made {when(inv.issued_at)} by {inv.issued_by}.{' '}
            {inv.opened_at ? `Opened ${when(inv.opened_at)}.` : 'Not opened yet.'}
          </li>
        )}
        {sends.map((s) => (
          <li key={s.send_id} className={s.outcome === 'failed' ? 'text-failing' : undefined}>
            {when(s.at)} — {s.outcome === 'sent' ? `emailed to ${s.to}` : `email to ${s.to} did not go: ${s.error}`} ({s.send_id}, by {s.by})
          </li>
        ))}
        {inv && (
          <li className="flex flex-wrap items-center gap-2">
            <span className="truncate text-faint">{inv.link}</span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                navigator.clipboard?.writeText(inv.link).then(
                  () => onToast('Link copied.', 'ok'),
                  () => onToast('Could not copy the link.', 'failing'),
                );
              }}
            >
              Copy link
            </Button>
          </li>
        )}
        {done && (
          <li className="text-ink">
            Answered {when(done.submitted_at)} ({done.submission_id}).{' '}
            {done.notified?.ts ? 'Announced in #vfarm-early-access.' : done.notified?.error ? <span className="text-failing">Not announced in Slack: {done.notified.error}.</span> : ''}
          </li>
        )}
        {!done && lastSend?.outcome === 'sent' && <li>Waiting for the buyer to answer.</li>}
      </ul>

      {done && (
        <div className="mt-3 space-y-4">
          {INTAKE2_SECTIONS.map((sec) => (
            <section key={sec.title}>
              <h4 className="kicker mb-1.5">{sec.title}</h4>
              <dl className="divide-y divide-line rounded-[10px] border border-line">
                {sec.fields.map((n) => {
                  const f = INTAKE2_FIELDS.find((x) => x.n === n)!;
                  const v = done.answers[f.label];
                  const files = f.kind === 'file' && Array.isArray(v) ? (v as Intake2File[]) : null;
                  return (
                    <div key={n} className="grid gap-x-4 px-3 py-2 text-[12.5px] sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
                      <dt className="text-dim">
                        {n}. {f.label}
                      </dt>
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
          <p className="text-[11.5px] text-faint">
            {done.contract}. The five request checks (feasibility, pricing, ownership, licensing, food safety) stay open: these answers are evidence for them, not a decision. Section headings are this page&rsquo;s.
            {done.drive_folder?.link ? (
              <>
                {' '}
                <a className="link" href={done.drive_folder.link} target="_blank" rel="noreferrer">
                  Uploads folder
                </a>
                .
              </>
            ) : null}
          </p>
        </div>
      )}
    </section>
  );
}
