'use client';

import { useCallback, useEffect, useState } from 'react';
import { get, ApiError, session } from '../lib/api';

/**
 * Load one Studio resource, and handle the three ways that can fail.
 *
 * Every authenticated screen has the same shape — fetch a thing, and until it
 * arrives be either loading, signed out, or broken. Writing that per screen is
 * how the look page ended up calling `fetch` directly and crashing on a body
 * that was not JSON.
 *
 * `mutate` exists so a save can hand back the server's response without a second
 * round trip. The PUT already returns the new state; refetching would be a
 * second chance to disagree with it.
 */
export function useResource(path) {
  const [state, setState] = useState({ status: 'loading', data: null, error: null });

  const load = useCallback(async () => {
    if (!path) return;
    if (!session.token()) { setState({ status: 'signed-out', data: null, error: null }); return; }
    setState((s) => ({ ...s, status: s.data ? 'ready' : 'loading' }));
    try {
      const data = await get(path);
      setState({ status: 'ready', data, error: null });
    } catch (err) {
      if (err instanceof ApiError && err.needsSignIn) {
        setState({ status: 'signed-out', data: null, error: err });
      } else {
        setState((s) => ({ status: s.data ? 'ready' : 'error', data: s.data, error: err }));
      }
    }
  }, [path]);

  useEffect(() => { load(); }, [load]);

  return {
    ...state,
    reload: load,
    mutate: (data) => setState({ status: 'ready', data, error: null }),
    fail:   (error) => setState((s) => ({ ...s, error })),
  };
}

/** Renders the loading / signed-out / broken states so a page only writes the happy one. */
export function Resource({ state, children }) {
  if (state.status === 'signed-out') {
    // AuthProvider owns the signed-out case: it redirects to /login carrying
    // where you were headed. Rendering a second sign-in panel here would flash
    // a differently-styled one for the moment before that redirect lands, and
    // would be a duplicate of the real screen to keep in step forever after.
    return <div className="page boot"><p className="hint">Taking you to sign in…</p></div>;
  }
  if (state.status === 'loading') return <div className="page"><p className="hint">Loading…</p></div>;
  if (state.status === 'error') {
    const err = state.error || {};
    const infra = err.code === 'API_UNREACHABLE';
    return (
      <div className="page">
        <div className={`load-err ${infra ? 'infra' : ''}`}>
          <b>{infra ? 'The backend is not answering' : 'Could not load this'}</b>
          <span>{err.message || 'Unknown error'}</span>
          {err.status === 404 && (
            <span className="helper">
              A 404 here can also mean the avatar belongs to a different workspace than the
              account you signed in with — the API will not confirm that an avatar it cannot
              show you exists.
            </span>
          )}
          {err.code === 'TOKEN_AUDIENCE_MISMATCH' && (
            <span className="helper">
              This token was minted for another app. Set
              {' '}<code className="mono">AUDIENCE_ORIGINS=http://localhost:3100=studio</code>{' '}
              in the backend env and sign in again.
            </span>
          )}
          <button className="ghost" onClick={state.reload}>Try again</button>
        </div>
      </div>
    );
  }
  return children(state.data);
}
