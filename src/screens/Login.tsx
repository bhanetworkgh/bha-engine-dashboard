import { useState } from 'react';
import { useSession } from '../app/session';

/**
 * One shared team login, the same pattern as BHARAG's console.
 */
export default function Login() {
  const { signIn } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex h-full items-center justify-center">
      <form
        className="w-[300px] max-w-[calc(100vw-2rem)]"
        onSubmit={(e) => {
          e.preventDefault();
          const result = signIn(email, password);
          if (result === 'missing') setError('Enter an email address and a password.');
          else if (result === 'unknown-email') setError('Not a recognised account.');
        }}
      >
        <div className="mb-6 flex items-center gap-2.5">
          <img src="/logo.svg" alt="" className="h-7 w-7 rounded-full opacity-90" />
          <span className="text-[15px] font-medium">BHA engine</span>
        </div>

        <label className="block text-[11px] text-faint" htmlFor="email">
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
          className="mt-1 w-full border border-line bg-raised px-2 py-1.5 text-ink outline-none focus:border-gold-dim"
        />

        <label className="mt-3 block text-[11px] text-faint" htmlFor="password">
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
          className="mt-1 w-full border border-line bg-raised px-2 py-1.5 text-ink outline-none focus:border-gold-dim"
        />

        {error && <div className="mt-2 text-[11px] text-failing">{error}</div>}

        <button
          type="submit"
          className="mt-3 w-full border border-gold-dim px-2 py-1.5 text-gold hover:bg-raised"
        >
          Sign in
        </button>
      </form>
    </div>
  );
}
