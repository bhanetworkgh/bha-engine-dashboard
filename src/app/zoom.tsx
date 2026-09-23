import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

/**
 * How large the interface draws, as a share of its natural size.
 *
 * **It opens at 80%** (decision 2026-09-16, Destiny): he had been running Chrome
 * at 80% browser zoom and the dashboard reads better there — more of a table on
 * screen, the sidebar whole, cards in three columns rather than two — so that is
 * what it should do without anybody having to set it.
 *
 * It is applied as `zoom` on `<html>`, not `transform: scale`. `zoom` reflows:
 * the page genuinely has more CSS pixels to lay out in, so the media queries,
 * the sticky header and the tables all behave as they would on a larger screen.
 * A transform would shrink a picture of a smaller layout and leave every
 * breakpoint thinking it was still on the old one.
 *
 * `zoom` is supported in Chrome, Edge and Safari, and in Firefox from 126. A
 * browser without it renders at 100% — the size this dashboard has always been —
 * which is a fallback rather than a fault.
 *
 * **This multiplies with the browser's own zoom.** Somebody already at 80% in
 * Chrome lands at 64%, which is small; the Settings control is there to put it
 * back, and it says so.
 */
/**
 * Spelled as a percentage string rather than a fraction, because that is what
 * the control shows and what `Segmented` takes — it is keyed on strings, and a
 * second representation of the same number is a second thing to keep in step.
 */
export type ZoomChoice = '75' | '80' | '90' | '100';

export const ZOOMS: ZoomChoice[] = ['75', '80', '90', '100'];

const KEY = 'bha.zoom';

function readChoice(): ZoomChoice {
  try {
    const v = localStorage.getItem(KEY);
    return (ZOOMS as string[]).includes(v ?? '') ? (v as ZoomChoice) : '80';
  } catch {
    // Private windows and blocked site data both throw here rather than
    // returning null, and neither is a reason to render nothing.
    return '80';
  }
}

interface ZoomValue {
  zoom: ZoomChoice;
  setZoom: (z: ZoomChoice) => void;
}

const Ctx = createContext<ZoomValue | null>(null);

export function ZoomProvider({ children }: { children: ReactNode }) {
  const [zoom, setZoomState] = useState<ZoomChoice>(readChoice);

  useEffect(() => {
    // 100% is written as the empty string rather than "1", so the property
    // comes off entirely and a browser without `zoom` is left untouched.
    document.documentElement.style.zoom = zoom === '100' ? '' : String(Number(zoom) / 100);
    // `vh` is scaled by the zoom too, so 100vh under 80% is 80% of the window.
    // Anything that has to fill the window divides by this (see the
    // document-scroll block at the end of index.css).
    document.documentElement.style.setProperty('--zoom', String(Number(zoom) / 100));
  }, [zoom]);

  const value = useMemo<ZoomValue>(
    () => ({
      zoom,
      setZoom: (z) => {
        setZoomState(z);
        try {
          localStorage.setItem(KEY, z);
        } catch {
          /* the choice still applies to this tab */
        }
      },
    }),
    [zoom],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useZoom(): ZoomValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useZoom must be used inside ZoomProvider');
  return v;
}
