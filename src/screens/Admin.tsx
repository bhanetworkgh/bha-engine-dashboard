import { type FormEvent, type ReactNode, useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { adminLogin, adminLogout, adminSetup, getAdminSession, type AdminSession } from '../data';
import { Button, Card, LoadFailed, Loading, PageHeader } from '../components/ui';

/**
 * The admin login (5 Nov 2026, Destiny). A second gate behind the team login, for what is Destiny's and Jason's
 * alone. The server holds the gate on every route; this page only asks for the password. See
 * server/src/adminAuth.ts.
 */
const PEOPLE = [
  { id: 'destiny', name: 'Destiny' },
  { id: 'jason', name: 'Jason' },
];

const INPUT = 'w-full rounded-lg bg-page px-3 py-2 text-[13px] text-ink ring-1 ring-hairline focus:outline-none focus:ring-2 focus:ring-accent';

function AdminForm({ session, onDone }: { session: AdminSession; onDone: () => void }) {
  const setupMode = !session.configured;
  const [who, setWho] = useState('destiny');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (setupMode) await adminSetup(code, who, password);
      else await adminLogin(who, password);
      setPassword('');
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not go through.');
    } finally {
      setBusy(false);
    }
  };

  if (setupMode && !session.setup_open) {
    return (
      <Card>
        <p className="p-5 text-[13px] text-dim">The admin password has not been set, and no setup code is on the service.</p>
      </Card>
    );
  }
  return (
    <Card>
      <form onSubmit={submit} className="flex max-w-sm flex-col gap-3 p-5">
        <p className="text-[13px] text-dim">{setupMode ? 'Set the admin password. Generate it in Bitwarden first, then paste it here.' : 'This is for Destiny and Jason.'}</p>
        <label className="text-[12px] text-dim">
          Who you are
          <select className={INPUT} value={who} onChange={(e) => setWho(e.target.value)}>
            {PEOPLE.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </label>
        {setupMode && (
          <label className="text-[12px] text-dim">
            Setup code
            <input className={INPUT} type="password" autoComplete="off" value={code} onChange={(e) => setCode(e.target.value)} />
          </label>
        )}
        <label className="text-[12px] text-dim">
          Admin password
          <input className={INPUT} type="password" autoComplete={setupMode ? 'new-password' : 'current-password'} value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <p className="text-[12px] text-failing">{error}</p>}
        <Button variant="primary" type="submit" loading={busy} disabled={!password}>{setupMode ? 'Set password' : 'Sign in'}</Button>
      </form>
    </Card>
  );
}

export function AdminGate({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<AdminSession | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const load = useCallback(() => {
    getAdminSession().then(setSession).catch((e: unknown) => setFailed(e instanceof Error ? e.message : 'The admin session could not be read.'));
  }, []);
  useEffect(load, [load]);
  if (failed) return <LoadFailed error={failed} />;
  if (!session) return <Loading />;
  if (session.admin) return <>{children}</>;
  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Admin login" subtitle="This page is for Destiny and Jason." />
      <div className="px-6 md:px-8">
        <AdminForm session={session} onDone={load} />
      </div>
    </div>
  );
}

export function AdminHome() {
  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Admin" subtitle="Signed in for eight hours." />
      <div className="flex flex-wrap items-center gap-4 px-6 text-[13px] md:px-8">
        <Link to="/stage-1" className="text-accent-ink">Stage 1</Link>
        <Link to="/pay" className="text-accent-ink">Pay Tracker</Link>
        <Link to="/registry" className="text-accent-ink">Tools</Link>
        <Button variant="secondary" onClick={() => adminLogout().then(() => window.location.reload())}>Sign out of admin</Button>
      </div>
    </div>
  );
}
