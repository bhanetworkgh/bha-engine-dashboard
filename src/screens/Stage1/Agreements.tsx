import { useRef, useState } from 'react';
import { useData } from '../../app/useData';
import { getAgreements, uploadAgreement } from '../../data';
import { Button, EmptyState, LoadFailed, Loading, relativeTime } from '../../components/ui';

/**
 * The agreements (5 Nov 2026, Destiny), stored encrypted and read through the admin login. DocuSign stays the
 * record of what was signed; a copy here is for reading. A signed copy goes up the same way an unsigned one did.
 */
const toBase64 = (f: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(new Error('That file could not be read.'));
    r.readAsDataURL(f);
  });

export function Agreements({ people, onDone, onFail }: { people: { id: string; name: string }[]; onDone: (text: string) => void; onFail: (text: string) => void }) {
  const [nonce, setNonce] = useState(0);
  const { status, data, error } = useData(getAgreements, [nonce]);
  const [person, setPerson] = useState('');
  const [state, setState] = useState('signed');
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  const upload = async () => {
    const f = file.current?.files?.[0];
    const who = people.find((p) => p.id === person);
    if (!f || !who) return onFail('Pick a person and a file.');
    setBusy(true);
    try {
      await uploadAgreement({ person_id: who.id, person_name: who.name, status: state, filename: f.name, content_type: f.type, base64: await toBase64(f) });
      if (file.current) file.current.value = '';
      onDone(`${who.name}'s agreement is saved, encrypted.`);
      setNonce((n) => n + 1);
    } catch (e) {
      onFail(e instanceof Error ? e.message : 'That did not save.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="px-6 pb-6 md:px-8">
      <h2 className="mb-2 text-[15px] font-semibold text-ink">Agreements</h2>
      {status === 'error' ? (
        <LoadFailed error={error} />
      ) : !data ? (
        <Loading />
      ) : (
        <>
          {!data.key_configured && <p className="mb-2 text-[12px] text-failing">AGREEMENTS_KEY is not set on the service, so these cannot be opened.</p>}
          {data.agreements.length === 0 ? (
            <EmptyState>No agreement is held yet.</EmptyState>
          ) : (
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-left text-dim">
                  <th className="py-1 font-medium">person</th>
                  <th className="py-1 font-medium">copy</th>
                  <th className="py-1 font-medium">saved</th>
                  <th className="py-1 font-medium">note</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.agreements.map((a) => (
                  <tr key={a.id}>
                    <td className="py-1">{a.person_name}</td>
                    <td className="py-1 text-dim">{a.status}</td>
                    <td className="py-1 text-dim">{relativeTime(a.uploaded_at)}</td>
                    <td className="py-1 text-dim">{a.note}</td>
                    <td className="py-1 text-right">
                      <a className="text-accent-ink" href={`/api/agreements/${a.id}/file`} target="_blank" rel="noreferrer">Open</a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-2 text-[13px]">
            <select aria-label="Whose agreement" className="rounded-lg bg-page px-2 py-1.5 ring-1 ring-hairline" value={person} onChange={(e) => setPerson(e.target.value)}>
              <option value="">Whose agreement</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <select aria-label="Which copy" className="rounded-lg bg-page px-2 py-1.5 ring-1 ring-hairline" value={state} onChange={(e) => setState(e.target.value)}>
              <option value="unsigned">unsigned</option>
              <option value="signed">signed</option>
              <option value="countersigned">countersigned</option>
            </select>
            <input ref={file} aria-label="Agreement file" type="file" accept=".pdf,.docx" />
            <Button variant="secondary" loading={busy} onClick={upload}>Save encrypted</Button>
          </div>
        </>
      )}
    </div>
  );
}
