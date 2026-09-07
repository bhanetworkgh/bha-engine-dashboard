import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import type { LaneFilter } from '../data';

/**
 * Shared team session. One login for everyone, matching BHARAG's console.
 * Phase 1 holds a fake token in memory and accepts any non-empty password —
 * there is no auth logic here and no secret in the repo.
 */
interface SessionValue {
  token: string | null;
  signIn: (password: string) => boolean;
  signOut: () => void;
  lane: LaneFilter;
  setLane: (lane: LaneFilter) => void;
}

const Ctx = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(null);
  const [lane, setLane] = useState<LaneFilter>('all');

  const value = useMemo<SessionValue>(
    () => ({
      token,
      lane,
      setLane,
      signIn: (password: string) => {
        if (!password.trim()) return false;
        setToken('phase1-session-token');
        return true;
      },
      signOut: () => setToken(null),
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
