import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { authMode, signIn as engineSignIn, type AuthSession, type LaneFilter, type SignInResult } from '../data';
import { setBearer } from '../data/engine';

export { TEAM_EMAIL } from '../data';

const SESSION_KEY = 'bha.session';

interface SessionValue {
  session: AuthSession | null;
  /** Shorthand: the bearer token, or null when signed out. */
  token: string | null;
  signIn: (email: string, password: string) => Promise<SignInResult>;
  signOut: () => void;
  lane: LaneFilter;
  setLane: (lane: LaneFilter) => void;
}

const Ctx = createContext<SessionValue | null>(null);

function expired(s: AuthSession): boolean {
  if (!s.expires_at) return false;
  const t = Date.parse(s.expires_at);
  return Number.isFinite(t) && t <= Date.now();
}

/** sessionStorage can throw in a private window; a failed read is just no session. */
function readSession(): AuthSession | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AuthSession>;
    if (typeof parsed.token !== 'string' || !parsed.token) return null;
    const s: AuthSession = {
      token: parsed.token,
      expires_at: typeof parsed.expires_at === 'string' ? parsed.expires_at : null,
      label: typeof parsed.label === 'string' ? parsed.label : null,
    };
    // A preview token is only honoured where preview mode is allowed.
    if (s.token === 'preview-session' && authMode() !== 'preview') return null;
    return expired(s) ? null : s;
  } catch {
    return null;
  }
}

function writeSession(s: AuthSession | null) {
  try {
    if (s) sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // Storage unavailable — the session still holds for this tab.
  }
}

/**
 * The shared team session. The token comes from the engine's login endpoint
 * and is sent as a bearer on every engine call; a 401 from any call, or the
 * expiry the engine gave us, signs the tab out.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<AuthSession | null>(readSession);
  const [lane, setLane] = useState<LaneFilter>('all');

  const signOut = useCallback(() => {
    writeSession(null);
    setSession(null);
  }, []);

  // Install the bearer for the engine client, and let a 401 sign us out.
  useEffect(() => {
    setBearer(session?.token ?? null, signOut);
  }, [session, signOut]);

  // Sign out at the moment the engine said the token expires.
  useEffect(() => {
    if (!session?.expires_at) return;
    const ms = Date.parse(session.expires_at) - Date.now();
    if (!Number.isFinite(ms)) return;
    if (ms <= 0) {
      signOut();
      return;
    }
    const t = setTimeout(signOut, Math.min(ms, 2 ** 31 - 1));
    return () => clearTimeout(t);
  }, [session, signOut]);

  const value = useMemo<SessionValue>(
    () => ({
      session,
      token: session?.token ?? null,
      lane,
      setLane,
      signIn: async (email, password) => {
        const result = await engineSignIn(email, password);
        if (result.ok) {
          writeSession(result.session);
          setSession(result.session);
        }
        return result;
      },
      signOut,
    }),
    [session, lane, signOut],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSession must be used inside SessionProvider');
  return v;
}
