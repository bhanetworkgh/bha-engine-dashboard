import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useSession } from './session';

/**
 * The live pages (2026-09-23, Destiny): one EventSource on /api/events for the
 * whole app, and every useData on screen told when a kind it shows changes.
 *
 * The server sends `{kind, id, at}` once a write commits and nothing else — a
 * page re-reads its own route rather than trusting a row pushed at it, so the
 * stream can never become a second read path that drifts from the first.
 *
 * Three things beside the stream also ask every page to re-read, as a change
 * with no kind: the tab becoming visible again or the window taking focus
 * (a laptop lid, a second screen), the stream reconnecting (anything written
 * while it was down was never announced), and — once it has been down for a
 * minute — a thirty-second poll until it comes back. So a page is never
 * silently stale: either it is live, or it is polling and says it is not live.
 */

export interface LiveSignal {
  /** The kind that changed; null means "re-read whatever you show". */
  kind: string | null;
}

interface LiveValue {
  /** Whether the stream is open right now. */
  connected: boolean;
  subscribe: (fn: (s: LiveSignal) => void) => () => void;
}

const Ctx = createContext<LiveValue | null>(null);

const FALLBACK_AFTER_MS = 60_000;
const POLL_MS = 30_000;
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 20_000, 30_000];

export function LiveProvider({ children }: { children: ReactNode }) {
  const { status } = useSession();
  const [connected, setConnected] = useState(false);
  const listeners = useRef(new Set<(s: LiveSignal) => void>());

  // Stable for the life of the app: useData lists it as a dependency, and a
  // new function every time the stream dropped would re-run every page's
  // first load — the flash this whole thing exists to avoid.
  const subscribe = useCallback((fn: (s: LiveSignal) => void) => {
    listeners.current.add(fn);
    return () => {
      listeners.current.delete(fn);
    };
  }, []);
  const value = useMemo<LiveValue>(() => ({ connected, subscribe }), [connected, subscribe]);

  useEffect(() => {
    if (status !== 'in' || typeof EventSource === 'undefined') return;

    const tell = (s: LiveSignal) => {
      for (const fn of [...listeners.current]) fn(s);
    };

    let source: EventSource | null = null;
    let attempt = 0;
    let everOpened = false;
    let reconnect: ReturnType<typeof setTimeout> | null = null;
    let downSince: number | null = Date.now();
    let poll: ReturnType<typeof setInterval> | null = null;
    let stopped = false;

    const stopPolling = () => {
      if (poll) clearInterval(poll);
      poll = null;
    };

    // Checked every few seconds rather than scheduled once, so it notices a
    // stream that has been down a minute however it went down.
    const watchdog = setInterval(() => {
      if (downSince !== null && Date.now() - downSince > FALLBACK_AFTER_MS && !poll) {
        tell({ kind: null });
        poll = setInterval(() => tell({ kind: null }), POLL_MS);
      }
    }, 5_000);

    const open = () => {
      if (stopped) return;
      source = new EventSource('/api/events', { withCredentials: true });
      source.onopen = () => {
        attempt = 0;
        downSince = null;
        stopPolling();
        setConnected(true);
        // Whatever changed while the stream was down was never announced.
        if (everOpened) tell({ kind: null });
        everOpened = true;
      };
      source.addEventListener('change', (ev) => {
        try {
          const e = JSON.parse((ev as MessageEvent<string>).data) as { kind?: unknown };
          if (typeof e.kind === 'string') tell({ kind: e.kind });
        } catch {
          // A frame this client cannot read is dropped; the next focus or poll catches up.
        }
      });
      source.onerror = () => {
        // Reconnected by hand with backoff rather than left to the browser:
        // an EventSource that gets a 401 or a 5xx closes for good and says
        // nothing, which is exactly the silent staleness this exists to stop.
        source?.close();
        source = null;
        setConnected(false);
        if (downSince === null) downSince = Date.now();
        const wait = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
        attempt++;
        if (reconnect) clearTimeout(reconnect);
        reconnect = setTimeout(open, wait);
      };
    };
    open();

    const onVisible = () => {
      if (document.visibilityState === 'visible') tell({ kind: null });
    };
    const onFocus = () => tell({ kind: null });
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onFocus);

    return () => {
      stopped = true;
      source?.close();
      if (reconnect) clearTimeout(reconnect);
      clearInterval(watchdog);
      stopPolling();
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onFocus);
      setConnected(false);
    };
  }, [status]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

const OUTSIDE: LiveValue = { connected: false, subscribe: () => () => undefined };

/** The stream's state, for the Live indicator. Outside the provider it reads as not connected. */
export function useLive(): LiveValue {
  return useContext(Ctx) ?? OUTSIDE;
}
