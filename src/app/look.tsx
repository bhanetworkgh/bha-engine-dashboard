import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

/**
 * The dashboard's look (27 Sep 2026, Destiny): the Original design, or Field
 * Lab (the bhanetwork.org design system). It is a safety net: both looks ship,
 * the switch is in Settings, and flipping it changes only colours, fonts and
 * icons. Layout, data, routes and animations are the same in both.
 *
 * Original is the default, so nobody sees a change until the look is approved.
 * The choice is stamped on <html data-look> (index.html does it before the
 * first paint too) and remembered in localStorage, like the theme.
 */
export type Look = 'original' | 'fieldlab';

export const LOOK_KEY = 'bha.look';

function readLook(): Look {
  try {
    return localStorage.getItem(LOOK_KEY) === 'fieldlab' ? 'fieldlab' : 'original';
  } catch {
    return 'original';
  }
}

interface LookValue {
  look: Look;
  setLook: (l: Look) => void;
}

const Ctx = createContext<LookValue>({ look: 'original', setLook: () => {} });

export function LookProvider({ children }: { children: ReactNode }) {
  const [look, setLookState] = useState<Look>(readLook);

  useEffect(() => {
    document.documentElement.dataset.look = look;
  }, [look]);

  const value = useMemo<LookValue>(
    () => ({
      look,
      setLook: (l) => {
        setLookState(l);
        try {
          localStorage.setItem(LOOK_KEY, l);
        } catch {
          // The choice lasts for this page only.
        }
      },
    }),
    [look],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useLook(): LookValue {
  return useContext(Ctx);
}
