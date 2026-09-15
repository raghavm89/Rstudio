'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { session, get, ApiError, onSessionLost, ensureSession } from '../lib/api';
import { auth } from '../lib/auth';

/**
 * The session, and the gate.
 *
 * Studio is not a public site with a members' area — every screen shows one
 * tenant's avatars, faces and usage. So the default is closed: the shell renders
 * nothing until we know who is asking, and the handful of public routes are
 * named here rather than each private page remembering to protect itself. A
 * guard you have to opt into is a guard someone will forget on the one screen
 * that mattered.
 *
 * Three things happen on mount, in order:
 *   1. Rehydrate from localStorage, so a reload is not a sign-out.
 *   2. Refresh silently against the HttpOnly cookie, so a token that expired
 *      while the tab was closed is replaced before anything renders an error.
 *   3. Bootstrap — ask the backend who we are and make sure a workspace exists.
 */

// '/' is the landing page — the one screen whose whole job is to be seen by
// someone with no account. `isPublic` matches it exactly rather than by prefix,
// so it does not accidentally open the rest of the app.
// Every route reachable WITHOUT a session. The two password screens belong
// here by definition — a person resetting a password cannot sign in, which
// is the entire reason they are on that page. Omitted, the guard bounces the
// emailed link straight to /login and the reset journey dead-ends one click
// from the end.
const PUBLIC_ROUTES = ['/', '/persona', '/clone', '/mascot', '/login', '/signup', '/auth/callback', '/forgot-password', '/reset-password'];
const isPublic = (path) => PUBLIC_ROUTES.some((p) => path === p || path.startsWith(`${p}/`));

const AuthContext = createContext(null);

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}

export function AuthProvider({ children }) {
  const router = useRouter();
  const pathname = usePathname() || '/';
  const [user, setUser] = useState(null);
  const [workspace, setWorkspace] = useState(null);
  const [ready, setReady] = useState(false);

  /**
   * Confirm the session with the backend and ensure a workspace.
   *
   * `token_stale` is not a hint. It means the token in hand was minted before
   * the workspace existed and still claims `tenant_id: null` — every Studio
   * route reads the tenant from that claim, so using it would scope the whole
   * app to nothing and show an empty Avatars screen with no error anywhere.
   */
  const bootstrap = useCallback(async () => {
    const me = await get('/me');
    if (me.token_stale) await auth.refresh();
    setUser(me.user);
    setWorkspace(me.workspace);
    return me;
  }, []);

  // No `already ran` ref here, deliberately. React's StrictMode mounts, unmounts
  // and remounts in development: a ref set on the first pass survives the
  // remount, so the second pass returns early — while the `setReady(true)` from
  // the first pass was thrown away with the state it belonged to. The app then
  // hangs on "Loading…" forever, and only on private routes after a reload,
  // because public routes render regardless of `ready`.
  //
  // The right guard is the cleanup flag: the abandoned pass is the one that
  // stops writing state, and the live pass runs to completion. Bootstrapping
  // twice costs one extra request and is idempotent by design.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        if (!session.token()) return;
        if (!cancelled) setUser(session.user());
        // A stored token may have expired while the tab was closed. Renewing
        // here rather than waiting for the first 401 means the app does not
        // flash an error state on the way to being fine.
        await auth.refresh();
        if (cancelled) return;
        if (!session.token()) { setUser(null); return; }
        await bootstrap();
      } catch (err) {
        // Only a refused session signs you out. If the backend is down, keep the
        // session and let the screen say the backend is down — signing someone
        // out because a server restarted is a worse answer than an error panel.
        if (!cancelled && err instanceof ApiError && err.needsSignIn) { session.clear(); setUser(null); }
      } finally {
        if (!cancelled) setReady(true);
      }
    })();

    return () => { cancelled = true; };
  }, [bootstrap]);

  /**
   * A session that dies mid-visit.
   *
   * Any request answering 401 means the token is gone and the refresh cookie
   * could not save it. Dropping the user here is what lets the gate below fire —
   * it keys on `user`, and a stale one made it decide there was nothing to do.
   */
  useEffect(() => onSessionLost(() => { setUser(null); setWorkspace(null); }), []);

  /**
   * Notice an expired session without waiting to be asked.
   *
   * The 401 path only fires when something queries the server, and most screens
   * stop querying once they have loaded. A tab left open therefore kept looking
   * signed in until you clicked something — which is precisely the case that
   * started this: a laptop shut at lunch and opened at three.
   *
   * Three triggers, because they catch different things:
   *
   *   visibilitychange / focus — the important one. A sleeping machine does not
   *     run timers, so a tab waking after four hours has an interval that never
   *     fired and a token that expired two hours ago. Checking on wake is what
   *     turns that into a clean redirect instead of a stale screen.
   *   interval — for a tab that is watched but idle, so the renewal happens
   *     quietly a minute before expiry rather than as a failed request.
   *   mount — the ordinary case.
   *
   * `ensureSession` renews first and only gives up if the refresh cookie is dead
   * too, so the common outcome here is that nothing visible happens at all.
   */
  useEffect(() => {
    if (isPublic(pathname)) return undefined;

    let stopped = false;
    const check = () => { if (!stopped) ensureSession().catch(() => {}); };

    check();
    const onWake = () => { if (document.visibilityState === 'visible') check(); };
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('focus', check);

    // A minute is well inside the renewal margin, so an expiry is acted on
    // before it can produce a failed request, and it is cheap: the check is a
    // clock comparison and only calls the network when the token is actually
    // near its end.
    const id = setInterval(check, 60_000);

    return () => {
      stopped = true;
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('focus', check);
      clearInterval(id);
    };
  }, [pathname]);

  /**
   * Signed out in another tab.
   *
   * `storage` fires in every OTHER tab of the origin, so one sign-out closes
   * them all rather than leaving three windows that each believe they are still
   * signed in until touched.
   */
  useEffect(() => {
    const onStorage = (e) => {
      if (e.key && !String(e.key).startsWith('rstudio.studio.')) return;
      if (!session.token()) { setUser(null); setWorkspace(null); }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // The gate. Runs after `ready` so a reload on a private URL does not bounce
  // you to /login before rehydration has had a chance to say you are signed in.
  useEffect(() => {
    if (!ready || isPublic(pathname) || user) return;
    // Carry where they were going. Someone opening a link to a specific avatar
    // should land on that avatar after signing in, not on a generic home page.
    const next = encodeURIComponent(pathname);
    router.replace(`/login?next=${next}`);
  }, [ready, pathname, user, router]);

  const value = {
    user,
    workspace,
    ready,
    signedIn: Boolean(user),
    async signIn(identifier, password) {
      const u = await auth.login(identifier, password);
      setUser(u);
      await bootstrap();
      return u;
    },
    /**
     * Hop one. Returns the server's next step; sets nothing, because nothing
     * exists yet. It used to set the user and bootstrap the workspace, both of
     * which would now run against a response that has neither.
     */
    /** Finish a sign-in that was interrupted by an unverified phone. */
    async completePhoneLogin(userId, code) {
      const u = await auth.verifyPhone(userId, code);
      setUser(u);
      await bootstrap();
      return u;
    },
    verifyEmailStep(pendingId, code) {
      return auth.verifyEmail(pendingId, code);
    },
    /** Hop two — the account, the workspace and the session all appear here. */
    async completeSignUp(pendingId, code) {
      const u = await auth.verifyPhoneSignup(pendingId, code);
      setUser(u);
      await bootstrap();
      return u;
    },
    async completeOAuth(code) {
      const u = await auth.exchange(code);
      setUser(u);
      await bootstrap();
      return u;
    },
    async signOut() {
      await auth.logout();
      setUser(null);
      setWorkspace(null);
      router.replace('/login');
    },
  };

  return (
    <AuthContext.Provider value={value}>
      {ready || isPublic(pathname) ? children : <div className="page boot"><p className="hint">Loading…</p></div>}
    </AuthContext.Provider>
  );
}

export { PUBLIC_ROUTES, isPublic };
