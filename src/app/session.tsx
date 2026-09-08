import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { getSession, signIn as serverSignIn, signOutOnServer, type AuthSession, type LaneFilter, type SignInResult } from '../data';
import { setUnauthorizedHandler } from '../data/api';

export { TEAM_EMAIL } from '../data';

interface SessionValue {
  /** 'checking' while the server is asked whether the cookie is live. */
  status: 'checking' | 'in' | 'out';
  session: AuthSession | null;
  signIn: (email: string, password: string) => Promise<SignInResult>;
  signOut: () => void;
  lane: LaneFilter;
  setLane: (lane: LaneFilter) => void;
}

const Ctx = createContext<SessionValue | null>(null);

/**
 * The shared team session. It lives in an HttpOnly cookie the server sets on
 * sign-in; this provider only mirrors what the server says about it. A 401
 * from any call, or the expiry the server gave, returns the app to sign-in.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SessionValue['status']>('checking');
  const [session, setSession] = useState<AuthSession | null>(null);
  const [lane, setLane] = useState<LaneFilter>('all');

  const drop = useCallback(() => {
    setSession(null);
    setStatus('out');
  }, []);

  const signOut = useCallback(() => {
    drop();
    void signOutOnServer();
  }, [drop]);

  // Ask the server once on load whether we are already signed in.
  useEffect(() => {
    let live = true;
    getSession()
      .then((s) => {
        if (!live) return;
        setSession(s);
        setStatus(s ? 'in' : 'out');
      })
      .catch(() => {
        if (live) setStatus('out');
      });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(drop);
    return () => setUnauthorizedHandler(null);
  }, [drop]);

  // Return to sign-in at the moment the server said the session expires.
  useEffect(() => {
    if (!session?.expires_at) return;
    const ms = Date.parse(session.expires_at) - Date.now();
    if (!Number.isFinite(ms)) return;
    if (ms <= 0) {
      drop();
      return;
    }
    const t = setTimeout(drop, Math.min(ms, 2 ** 31 - 1));
    return () => clearTimeout(t);
  }, [session, drop]);

  const value = useMemo<SessionValue>(
    () => ({
      status,
      session,
      lane,
      setLane,
      signIn: async (email, password) => {
        const result = await serverSignIn(email, password);
        if (result.ok) {
          setSession(result.session);
          setStatus('in');
        }
        return result;
      },
      signOut,
    }),
    [status, session, lane, signOut],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSession must be used inside SessionProvider');
  return v;
}
