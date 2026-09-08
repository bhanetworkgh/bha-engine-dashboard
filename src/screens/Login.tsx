import { useState } from 'react';
import { useSession } from '../app/session';
import { useTheme } from '../app/theme';
import { authMode } from '../data';
import { Icon } from '../components/ui';

/**
 * One shared team login, the same pattern as BHARAG's console. The password is
 * posted to the engine, which returns the session token the app then holds.
 */
export default function Login() {
  const { signIn } = useSession();
  const { resolved, setChoice } = useTheme();
  const mode = authMode();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await signIn(email, password);
    if (!result.ok) setError(result.message);
    setBusy(false);
  }

  return (
    <div className="flex h-full flex-col bg-bg">
      <div className="flex items-center justify-end px-5 py-4">
        <button
          type="button"
          onClick={() => setChoice(resolved === 'dark' ? 'light' : 'dark')}
          className="btn btn-ghost btn-sm gap-1.5"
          aria-label="Toggle theme"
        >
          {resolved === 'dark' ? <Icon.sun /> : <Icon.moon />}
        </button>
      </div>

      <div className="flex flex-1 items-center justify-center px-4 pb-16">
        <form
          className="fade-up w-[360px] max-w-full"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="mb-8 flex flex-col items-center text-center">
            <img src="/logo.svg" alt="" className="mark h-14 w-14" />
            <h1 className="font-display mt-5 text-[26px] leading-none">BHA engine</h1>
            <p className="mt-2 text-[13px] text-dim">Sign in with the shared team account.</p>
          </div>

          <div className="card p-6">
            <label className="kicker block" htmlFor="email">
              Email
            </label>
            <input
              id="email"
              type="email"
              autoFocus
              autoComplete="username"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setError(null);
              }}
              className="input mt-1.5"
              placeholder="you@bhanetwork.org"
            />

            <label className="kicker mt-4 block" htmlFor="password">
              Password
            </label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setError(null);
              }}
              className="input mt-1.5"
            />

            {error && (
              <div role="alert" className="mt-3 rounded-[10px] bg-failing-soft px-3 py-2 text-[12.5px] leading-relaxed text-failing">
                {error}
              </div>
            )}

            <button type="submit" disabled={busy || mode === 'none'} className="btn btn-primary mt-5 h-9 w-full">
              {busy ? 'Signing in' : 'Sign in'}
            </button>
          </div>

          <p className="mt-4 flex items-start justify-center gap-1.5 text-center text-[11.5px] leading-relaxed text-faint">
            <Icon.lock className="mt-[2px] shrink-0" />
            <span>
              {mode === 'engine' && 'Your password is checked by the engine, which issues a session token for this tab.'}
              {mode === 'preview' && 'Preview mode: the email is checked, the password is not. Live verification needs VITE_AUTH_URL.'}
              {mode === 'none' && 'Sign-in is not configured on this host. Set VITE_AUTH_URL to the engine login endpoint.'}
            </span>
          </p>
        </form>
      </div>
    </div>
  );
}
