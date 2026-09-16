/**
 * A number that runs up to its value.
 *
 * Its own module so both `Records.tsx` and `Charts.tsx` can use it: Records
 * imports Charts, so the count-up living in Records is why a bar's own figure
 * snapped while the bar beside it grew.
 */
import { useEffect, useRef, useState } from 'react';

/** Whether the viewer asked for less motion. */
function reducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/**
 * A count that runs up to its value. It animates on first paint, again
 * whenever the value changes (from the number it was showing, so a status
 * change reads as movement), and from zero whenever `replayKey` changes —
 * the page passes the selected builder, so switching tabs re-runs it.
 */
function useCountUp(value: number, duration: number, replayKey?: string | number): number {
  const [shown, setShown] = useState(reducedMotion() ? value : 0);
  const shownRef = useRef(reducedMotion() ? value : 0);
  const lastKey = useRef(replayKey);
  useEffect(() => {
    if (reducedMotion()) {
      shownRef.current = value;
      setShown(value);
      return;
    }
    const from = lastKey.current === replayKey ? shownRef.current : 0;
    lastKey.current = replayKey;
    const start = performance.now();
    let raf = 0;
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / duration);
      /**
       * A smoothstep, not an ease-out (2026-09-16, Destiny, third pass).
       *
       * Every ease-out — cubic, quint — front-loads: it covers most of its
       * distance immediately and then crawls, which is exactly the "it just
       * happens all at once" this kept reading as. A smoothstep starts slow,
       * moves through the middle and settles, so the number is legible the
       * whole way up rather than only at the end.
       */
      const eased = p * p * (3 - 2 * p);
      const v = from + (value - from) * eased;
      shownRef.current = v;
      setShown(v);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, replayKey]);
  return shown;
}

export function CountUp({ value, duration = 1900, replayKey }: { value: number; duration?: number; replayKey?: string | number }) {
  return <>{Math.round(useCountUp(value, duration, replayKey))}</>;
}

/**
 * The same count-up, through a formatter (2026-09-16, Destiny).
 *
 * Whole numbers animated and everything else — percentages, failure rates,
 * average run times — snapped into place, on the same row of tiles, which read
 * as half the page working and half of it not. `format` is handed the value
 * mid-flight, so a rate counts up through 12.4%, 31.8%, 47.1% and a duration
 * through its own units, and the figure that lands is the figure the formatter
 * would have printed on its own.
 *
 * `null` is not a number and never animates: a figure the month cannot support
 * prints its reason, which is the caller's business, not this component's.
 */
export function CountUpText({
  value,
  format,
  duration = 1900,
  replayKey,
}: {
  value: number;
  format: (n: number) => string;
  duration?: number;
  replayKey?: string | number;
}) {
  return <>{format(useCountUp(value, duration, replayKey))}</>;
}
