import { useEffect, useRef, useState } from 'react';
import type { Query } from '../data';
import { useLive } from './live';
import { useSession } from './session';

type State<T> =
  | { status: 'loading'; data: null; error: null }
  | { status: 'ready'; data: T; error: null }
  | { status: 'error'; data: null; error: string };

export interface UseDataOptions {
  /** Re-read on a timer as well. */
  refreshMs?: number;
  /**
   * The record kinds this data is built from — `codex`, `pay_sessions`, … as
   * the server names them on /api/events. A change to one of them re-reads.
   * Left out, any change re-reads.
   */
  kinds?: readonly string[];
}

/** How long a burst of changes is gathered before one re-read. */
const DEBOUNCE_MS = 750;

/**
 * Calls a data-module function with the current global lane filter and tracks
 * loading and failure. Components use this rather than calling the data module
 * directly, so when the module starts making real requests nothing else moves.
 *
 * **Live** (2026-09-23): when the server announces a change to one of `kinds`
 * — or, with no `kinds`, to anything — this re-reads, gathered over 750ms so a
 * resync writing two hundred rows is one request and not two hundred. It also
 * re-reads when the tab comes back into view or the window takes focus, and
 * polls every 30s once the stream has been down for a minute (see live.tsx).
 *
 * Every re-read is quiet: it never drops back to the loading state, so the
 * page keeps what it has until the new answer arrives and nothing flashes. A
 * re-read that fails leaves the last good answer on screen rather than
 * replacing a working page with an error, and an answer that arrives after a
 * newer one is thrown away rather than put back over it.
 *
 * The third argument may still be a bare number of milliseconds, which is
 * `{ refreshMs }`.
 */
export function useData<T>(fn: (q: Query) => Promise<T>, deps: unknown[] = [], opts?: number | UseDataOptions): State<T> {
  const { lane } = useSession();
  const { subscribe } = useLive();
  const [state, setState] = useState<State<T>>({ status: 'loading', data: null, error: null });
  const { refreshMs, kinds } = typeof opts === 'number' ? { refreshMs: opts, kinds: undefined } : (opts ?? {});
  const kindsKey = kinds ? [...kinds].sort().join(',') : '*';

  // The newest function, so a re-read triggered by an event uses the deps the
  // page has now rather than the ones it had when the effect last ran.
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    let live = true;
    let seq = 0;
    let shown = 0;
    setState({ status: 'loading', data: null, error: null });

    const first = ++seq;
    fnRef
      .current({ lane })
      .then((data) => {
        if (live && first > shown) {
          shown = first;
          setState({ status: 'ready', data, error: null });
        }
      })
      .catch((e: unknown) => {
        if (live && first > shown)
          setState({
            status: 'error',
            data: null,
            error: e instanceof Error ? e.message : 'Request failed',
          });
      });

    const quiet = () => {
      const mine = ++seq;
      fnRef
        .current({ lane })
        .then((data) => {
          if (live && mine > shown) {
            shown = mine;
            setState({ status: 'ready', data, error: null });
          }
        })
        .catch(() => undefined);
    };

    const timer = refreshMs ? setInterval(quiet, refreshMs) : null;

    const wanted = kindsKey === '*' ? null : new Set(kindsKey.split(','));
    let pending: ReturnType<typeof setTimeout> | null = null;
    const off = subscribe((s) => {
      if (s.kind !== null && wanted && !wanted.has(s.kind)) return;
      if (pending) clearTimeout(pending);
      pending = setTimeout(() => {
        pending = null;
        quiet();
      }, DEBOUNCE_MS);
    });

    return () => {
      live = false;
      if (timer) clearInterval(timer);
      if (pending) clearTimeout(pending);
      off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lane, refreshMs, kindsKey, subscribe, ...deps]);

  return state;
}
