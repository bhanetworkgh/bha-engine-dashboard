import { useEffect, useState } from 'react';
import type { Query } from '../data';
import { useSession } from './session';

type State<T> =
  | { status: 'loading'; data: null; error: null }
  | { status: 'ready'; data: T; error: null }
  | { status: 'error'; data: null; error: string };

/**
 * Calls a data-module function with the current global lane filter and tracks
 * loading and failure. Components use this rather than calling the data module
 * directly, so when the module starts making real requests nothing else moves.
 */
export function useData<T>(fn: (q: Query) => Promise<T>, deps: unknown[] = []): State<T> {
  const { lane } = useSession();
  const [state, setState] = useState<State<T>>({ status: 'loading', data: null, error: null });

  useEffect(() => {
    let live = true;
    setState({ status: 'loading', data: null, error: null });
    fn({ lane })
      .then((data) => {
        if (live) setState({ status: 'ready', data, error: null });
      })
      .catch((e: unknown) => {
        if (live)
          setState({
            status: 'error',
            data: null,
            error: e instanceof Error ? e.message : 'Request failed',
          });
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lane, ...deps]);

  return state;
}
