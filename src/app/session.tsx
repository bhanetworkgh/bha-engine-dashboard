import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import type { LaneFilter } from '../data';

/** The one account the team shares, matching BHARAG's console. */
export const TEAM_EMAIL = 'admin@bhanetwork.org';

const TOKEN_KEY = 'bha.session';

export type SignInResult = 'ok' | 'unknown-email' | 'missing';

interface SessionValue {
  token: string | null;
  signIn: (email: string, password: string) => SignInResult;
  signOut: () => void;
  lane: LaneFilter;
  setLane: (lane: LaneFilter) => void;
}

const Ctx = createContext<SessionValue | null>(null);

/** sessionStorage can throw in a private window; a failed read is just no session. */
function readToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(readToken);
  const [lane, setLane] = useState<LaneFilter>('all');

  const value = useMemo<SessionValue>(
    () => ({
      token,
      lane,
      setLane,
      signIn: (email: string, password: string) => {
        if (!email.trim() || !password.trim()) return 'missing';
        // Phase 1 only: the email is checked against a constant and the password is
        // not verified or stored anywhere. Real verification moves to the engine
        // endpoint in phase 2, which returns the session token this holds.
        if (email.trim().toLowerCase() !== TEAM_EMAIL) return 'unknown-email';
        const next = 'phase1-session-token';
        try {
          sessionStorage.setItem(TOKEN_KEY, next);
        } catch {
          // Storage unavailable — the session still holds for this tab.
        }
        setToken(next);
        return 'ok';
      },
      signOut: () => {
        try {
          sessionStorage.removeItem(TOKEN_KEY);
        } catch {
          // Nothing to clear.
        }
        setToken(null);
      },
    }),
    [token, lane],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSession must be used inside SessionProvider');
  return v;
}
