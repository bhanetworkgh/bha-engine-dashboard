import { useState } from 'react';
import { clearIntake2Unresponsive, sendIntake2Invite, type VfarmLead } from '../../data';
import { Button, Pill } from '../../components/ui';
import { INTAKE2_FIELDS, INTAKE2_SECTIONS, answerText, type Intake2File } from '../../data/intake2';

const when = (iso: string | null | undefined): string => (iso ? `${iso.slice(0, 16).replace('T', ' ')} UTC` : '');


/**
 * Where a lead is in Intake-2, in one word, for the tag on its row (15 Oct 2026, Destiny:
 * "a very visible indicator on screen that they've been sent an email"). Opened is a hint,
 * not a fact: it is set when the page reads the form, which a link scanner never does.
 */
export function intake2State(lead: VfarmLead): { label: string; tone: 'default' | 'degraded' | 'failing' | 'accent' } | null {
  const inv = lead.intake_2_invite ?? null;
  if (lead.intake_2) return { label: 'Spec received', tone: 'accent' };
  if (!inv) return lead.stage === 2 ? { label: 'No invite yet', tone: 'degraded' } : null;
  if (inv.unresponsive_at) return { label: 'Unresponsive', tone: 'degraded' };
  const sends = inv.sends ?? [];
  if (!sends.some((x) => x.outcome === 'sent')) return { label: 'Invite failed', tone: 'failing' };
  const fu = inv.followups ?? {};
  const step = fu.fu2?.outcome === 'sent' ? 'follow-up 2 sent' : fu.fu1?.outcome === 'sent' ? 'follow-up 1 sent' : null;
  if (inv.opened_at) return { label: step ? `Opened · ${step}` : 'Opened', tone: 'default' };
  return { label: step ? `Invite sent · ${step}` : 'Invite sent', tone: 'default' };
}

export function Intake2Tag({ lead }: { lead: VfarmLead }) {
  const s = intake2State(lead);
  return s ? <Pill tone={s.tone}>{s.label}</Pill> : null;
}

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
  if (lead.stage === 1 && !inv && !done) return null;

  async function clearUnresponsive() {
    setBusy(true);
    try {
      const r = await clearIntake2Unresponsive(lead.id);
      onToast(r.message, 'ok');
    } catch (e) {
      onToast(e instanceof Error ? e.message : 'That did not save.', 'failing');
    } finally {
      setBusy(false);
    }
  }

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
        {(['fu1', 'fu2'] as const).map((k, i) => {
          const f = inv?.followups?.[k];
          if (!f || !f.at) return null;
          return (
            <li key={k} className={f.outcome === 'failed' ? 'text-failing' : undefined}>
              {when(f.at)} — follow-up {i + 1} {f.outcome === 'sent' ? `emailed to ${f.to}` : `did not go (try ${f.attempts ?? 1}): ${f.error}`}
            </li>
          );
        })}
        {inv?.unresponsive_at && (
          <li className="flex flex-wrap items-center gap-2 text-ink">
            <Pill tone="degraded">Unresponsive</Pill> since {when(inv.unresponsive_at)}: no answer 14 days after the invite and two follow-ups.
            <Button size="sm" variant="ghost" loading={busy} onClick={clearUnresponsive}>
              Clear unresponsive
            </Button>
          </li>
        )}
        {!done && !inv?.unresponsive_at && lastSend?.outcome === 'sent' && (
          <li>Waiting for the buyer to answer. Follow-ups go out at 3 and 7 days after the first invite, and the lead is marked Unresponsive at 14.</li>
        )}
        {done?.confirmation_email && (
          <li className={done.confirmation_email.outcome === 'failed' ? 'text-failing' : undefined}>
            {done.confirmation_email.outcome === 'sent' ? `Receipt emailed to ${done.confirmation_email.to}.` : `Receipt email did not go: ${done.confirmation_email.error}`}
          </li>
        )}
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
