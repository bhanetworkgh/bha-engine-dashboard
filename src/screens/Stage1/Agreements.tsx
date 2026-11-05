import { useEffect, useRef, useState } from 'react';
import { getAgreementText, uploadAgreement } from '../../data';
import type { Agreement } from '../../data';
import { Button, ButtonAnchor, EmptyState, Loading, relativeTime } from '../../components/ui';

/**
 * The agreement inside a person's window (5 Nov 2026, Destiny: "the agreement details verbatim"). Stored
 * encrypted and read through the admin login; DocuSign stays the record of what was signed. A PDF is shown as
 * the document itself, signatures included, because a copy of its words would not be verbatim. A Word file
 * cannot sit in a browser frame, so its text is shown, and Open gives the file.
 */
const toBase64 = (f: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(new Error('That file could not be read.'));
    r.readAsDataURL(f);
  });

const RANK = ['unsigned', 'signed', 'countersigned'];

/** Furthest along first, then newest: the same order the agreement tool sends in. */
export const ordered = (rows: Agreement[]) =>
  [...rows].sort((a, b) => RANK.indexOf(b.status) - RANK.indexOf(a.status) || String(b.uploaded_at).localeCompare(String(a.uploaded_at)));

function WordText({ id }: { id: string }) {
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let live = true;
    setText(null);
    setErr('');
    getAgreementText(id).then((r) => live && setText(r.text), (e) => live && setErr(e instanceof Error ? e.message : 'That could not be read.'));
    return () => {
      live = false;
    };
  }, [id]);
  if (err) return <p className="text-[12.5px] text-dim">{err} Open gives the file itself.</p>;
  if (text === null) return <Loading />;
  return <pre className="scroll-thin max-h-[70vh] overflow-y-auto whitespace-pre-wrap font-sans text-[13px] leading-relaxed text-ink">{text}</pre>;
}

export function AgreementPanel({ person, rows, keyConfigured, onSaved, onDone, onFail }: {
  person: { id: string; name: string };
  rows: Agreement[];
  keyConfigured: boolean;
  onSaved: () => void;
  onDone: (text: string) => void;
  onFail: (text: string) => void;
}) {
  const copies = ordered(rows);
  const [pick, setPick] = useState<string | null>(null);
  const shown = copies.find((c) => c.id === pick) ?? copies[0];
  const [state, setState] = useState('signed');
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  const upload = async () => {
    const f = file.current?.files?.[0];
    if (!f) return onFail('Pick a file.');
    setBusy(true);
    try {
      await uploadAgreement({ person_id: person.id, person_name: person.name, status: state, filename: f.name, content_type: f.type, base64: await toBase64(f) });
      if (file.current) file.current.value = '';
      onDone(`${person.name}'s agreement is saved, encrypted.`);
      onSaved();
    } catch (e) {
      onFail(e instanceof Error ? e.message : 'That did not save.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mt-5">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[14px] font-semibold text-ink">Agreement</h3>
        {shown && <ButtonAnchor variant="secondary" href={`/api/agreements/${shown.id}/file`} target="_blank" rel="noreferrer">Open</ButtonAnchor>}
      </div>
      {!keyConfigured && <p className="mb-2 text-[12px] text-failing">AGREEMENTS_KEY is not set on the service, so these cannot be opened.</p>}
      {!shown ? (
        <EmptyState>No agreement is held for {person.name}.</EmptyState>
      ) : (
        <>
          <div className="mb-2 flex flex-wrap items-center gap-2 text-[12px] text-dim">
            {copies.length > 1 ? (
              <select aria-label="Which copy" className="rounded-lg bg-page px-2 py-1 ring-1 ring-hairline" value={shown.id} onChange={(e) => setPick(e.target.value)}>
                {copies.map((c) => (
                  <option key={c.id} value={c.id}>{c.status}, {c.filename}</option>
                ))}
              </select>
            ) : (
              <span>{shown.status} copy, {shown.filename}</span>
            )}
            <span>saved {relativeTime(shown.uploaded_at)}</span>
          </div>
          {shown.note && <p className="mb-2 text-[12.5px] text-dim">{shown.note}</p>}
          {shown.content_type === 'application/pdf' ? (
            <iframe key={shown.id} title={`${person.name}'s agreement`} src={`/api/agreements/${shown.id}/file`} className="h-[75vh] w-full rounded-lg ring-1 ring-hairline" />
          ) : (
            <WordText id={shown.id} />
          )}
        </>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2 text-[13px]">
        <select aria-label="Which copy to save" className="rounded-lg bg-page px-2 py-1.5 ring-1 ring-hairline" value={state} onChange={(e) => setState(e.target.value)}>
          <option value="unsigned">unsigned</option>
          <option value="signed">signed</option>
          <option value="countersigned">countersigned</option>
        </select>
        <input ref={file} aria-label="Agreement file" type="file" accept=".pdf,.docx" />
        <Button variant="secondary" loading={busy} onClick={upload}>Save encrypted</Button>
      </div>
    </section>
  );
}
