import { useState } from 'react';
import { useSession } from '../app/session';

/**
 * One shared team login, the same pattern as BHARAG's console. Phase 1 accepts
 * any non-empty password and holds a fake token in memory — there is no auth
 * logic and no secret here.
 */
export default function Login() {
  const { signIn } = useSession();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex h-full items-center justify-center">
      <form
        className="w-[300px]"
        onSubmit={(e) => {
          e.preventDefault();
          if (!signIn(password)) setError('Enter the team password.');
        }}
      >
        <div className="mb-6 flex items-center gap-2.5">
          <img src="/logo.svg" alt="" className="h-7 w-7 rounded-full opacity-90" />
          <span className="text-[15px] font-medium">BHA engine</span>
        </div>

        <label className="block text-[11px] text-faint" htmlFor="password">
          Team password
        </label>
        <input
          id="password"
          type="password"
          autoFocus
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            setError(null);
          }}
          className="mt-1 w-full border border-line bg-raised px-2 py-1.5 text-ink outline-none focus:border-gold-dim"
        />

        {error && <div className="mt-2 text-[11px] text-failing">{error}</div>}

        <button
          type="submit"
          className="mt-3 w-full border border-gold-dim px-2 py-1.5 text-gold hover:bg-raised"
        >
          Sign in
        </button>

        <p className="mt-5 text-[11px] leading-relaxed text-faint">
          One login for the whole team, matching BHARAG's console. No per-user
          accounts. In phase 1 any password is accepted and the session is held in
          memory only.
        </p>
      </form>
    </div>
  );
}
