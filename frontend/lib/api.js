/**
 * The Studio API client.
 *
 * Requests go to a same-origin /api/studio path which next.config.js rewrites to
 * the backend. That matters beyond convenience: the backend derives the token
 * audience from the request Origin (see services/audience.js), so a proxied
 * same-origin call in development behaves the way a production call behind one
 * domain will. Pointing the browser straight at :5000 would make every session
 * look like it came from somewhere else.
 *
 * ── Why this file exists rather than fetch() at each call site ────────────────
 *
 * Every screen needs the same four things, and getting any of them wrong is
 * invisible until it isn't:
 *
 *   1. An Authorization header. The Studio plane is authenticated; the culling
 *      service on :5055 is not. Screens built against the culling service work
 *      without a token, which makes the first screen to touch the real backend
 *      look broken for a reason that has nothing to do with that screen.
 *   2. A body that might not be JSON. A crashed backend, a proxy that cannot
 *      reach it, or an nginx error page all return something `res.json()`
 *      refuses. Parsing without a guard turns "the backend is down" into
 *      "Unexpected end of JSON input" at a line number in a component.
 *   3. One silent retry after a refresh. Access tokens live fifteen minutes.
 *      Without this you are signed out mid-cull, repeatedly.
 *   4. Refusals passed through intact. The backend's errors carry a `code` and a
 *      sentence written for a person — QUOTA_EXCEEDED, LOOK_FROZEN,
 *      LICENCE_INTENT_CONFLICT. A screen that replaces them with "Something went
 *      wrong" throws away the only useful part.
 */

const TOKEN_KEY = 'rstudio.studio.token';
const USER_KEY  = 'rstudio.studio.user';

export class ApiError extends Error {
  constructor(message, { status, code, body } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
  /** Should the shell show the sign-in panel rather than an error? */
  get needsSignIn() {
    return this.status === 401 || this.code === 'TOKEN_AUDIENCE_MISSING';
  }
}

/**
 * What to show a person when a request fails.
 *
 * A refusal from the backend carries two fields. `error` is a terse phrase for
 * a log line — it becomes ApiError.message above. `message` is the sentence
 * written for a person, and it is the half that says what to do. Showing only
 * the first is how "This plan cannot be bought yet" reaches someone with no
 * hint that the fix is two fields in a dashboard.
 *
 * One function rather than a ternary at each catch block, because the ternary
 * was written three times and one of the three dropped the explanation.
 */
export function errorText(err, fallback = 'Something went wrong.') {
  const terse = err?.message || '';
  const said  = err?.body?.message || '';
  // Some refusals set both to the same string; joining them would stutter.
  if (terse && said && said !== terse) return `${terse} — ${said}`;
  return terse || said || fallback;
}

// ── Token store ───────────────────────────────────────────────────────────────
// localStorage rather than memory only, because a dev server reload should not
// sign you out. The REFRESH token is not here — it stays in the HttpOnly cookie
// the backend sets, which is the half that matters and the half JavaScript
// should never be able to read.

export const session = {
  token() {
    try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
  },
  user() {
    try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); } catch { return null; }
  },
  set(token, user) {
    try {
      localStorage.setItem(TOKEN_KEY, token);
      if (user) localStorage.setItem(USER_KEY, JSON.stringify(user));
    } catch { /* private mode — the session lives for this page only */ }
  },
  clear() {
    try { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(USER_KEY); } catch {}
  },
};

/**
 * Told when a session turns out to be dead mid-visit.
 *
 * `session.clear()` empties localStorage, which React knows nothing about. So a
 * token that expired while the tab sat open produced this: storage cleared, the
 * provider still holding a `user` object from before, its redirect guard seeing
 * that user and deciding everything was fine — and the page rendering the
 * backend's own words, "Missing or invalid Authorization header", to a person
 * whose only mistake was leaving a tab open over lunch.
 *
 * The guard was never wrong. Nothing had told it.
 *
 * Deliberately not fired from `session.clear()` itself: signing out clears the
 * session too, and that path already knows where it is going. This is only for
 * the involuntary case.
 */
const sessionLost = new Set();
export function onSessionLost(fn) {
  sessionLost.add(fn);
  return () => sessionLost.delete(fn);
}

function emitSessionLost() {
  // A listener that throws must not take the caller down with it — this is
  // called from inside a failed request and from a background timer, and
  // neither has anywhere useful to put an exception.
  for (const fn of sessionLost) { try { fn(); } catch { /* ignore */ } }
}

// ── The request ───────────────────────────────────────────────────────────────

async function readBody(res) {
  // Never `res.json()` unguarded. An empty 502 from the dev proxy, an HTML error
  // page, a crashed process mid-response — all of them land here, and all of
  // them should become a sentence rather than a SyntaxError.
  const text = await res.text().catch(() => '');
  if (!text) return null;
  try { return JSON.parse(text); } catch { return { _raw: text }; }
}

function unreachable(err) {
  return new ApiError(
    'The Studio is not responding. Nothing was saved — check your connection and try again in a moment.',
    { status: 0, code: 'API_UNREACHABLE', body: { cause: err?.message } }
  );
}

async function raw(url, options, token) {
  let res;
  try {
    res = await fetch(url, {
      credentials: 'include',
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(options.headers || {}),
      },
    });
  } catch (err) {
    throw unreachable(err);
  }
  return res;
}

/**
 * One refresh at a time.
 *
 * Two callers want this now — the 401 retry and the expiry heartbeat — and a
 * tab returning from sleep can trip both in the same tick. Refresh tokens
 * ROTATE, and the backend revokes a whole family when it sees one reused: two
 * concurrent refreshes are a token replay by our own client, which would sign
 * the person out for real. This is the lock that prevents it.
 */
let inFlight = null;
function refreshOnce() {
  if (!inFlight) inFlight = refresh().finally(() => { inFlight = null; });
  return inFlight;
}

/** Trade the HttpOnly refresh cookie for a new access token. Returns it, or null. */
async function refresh() {
  try {
    const res = await raw('/api/auth/refresh', { method: 'POST' }, null);
    if (!res.ok) return null;
    const body = await readBody(res);
    if (!body?.access_token) return null;
    session.set(body.access_token, body.user || session.user());
    return body.access_token;
  } catch {
    return null;
  }
}

/**
 * When the access token expires, in epoch milliseconds — or null.
 *
 * Reads the JWT's `exp` without verifying anything, which is exactly right here:
 * the client is not deciding whether to TRUST the token, only when to stop
 * relying on it. The backend verifies. A token this cannot parse returns null
 * and is left to the 401 path, because guessing "expired" would sign someone out
 * over a format we did not anticipate.
 */
export function tokenExpiry(token = session.token()) {
  if (!token) return null;
  try {
    const [, payload] = token.split('.');
    if (!payload) return null;
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    const exp = JSON.parse(json)?.exp;
    return typeof exp === 'number' ? exp * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * Keep the session alive, or admit it is over.
 *
 * The 401 handler only fires when something asks the server a question. A tab
 * left open on a page that fetches nothing — which is most of them, once loaded
 * — sits there looking signed in until you click something. This is the other
 * half: check the clock, renew quietly if the refresh cookie still works, and
 * only then give up.
 *
 * The margin matters. Renewing a minute BEFORE expiry means an open tab never
 * serves a 401 at all; waiting until after means every long visit ends with one
 * failed request, and the person watching sees a flicker.
 */
const RENEW_MARGIN_MS = 60_000;

export async function ensureSession({ margin = RENEW_MARGIN_MS } = {}) {
  const token = session.token();
  if (!token) return false;

  const exp = tokenExpiry(token);
  // Unparseable: not our business to declare dead. The next request will find out.
  if (exp === null) return true;
  if (Date.now() < exp - margin) return true;

  const fresh = await refreshOnce();
  if (fresh) return true;

  session.clear();
  emitSessionLost();
  return false;
}

export async function api(path, options = {}) {
  const url = `/api/studio${path}`;
  let res = await raw(url, options, session.token());

  // One silent retry. An expired access token is the overwhelmingly common 401
  // and the user has done nothing wrong; making them sign in again every quarter
  // hour would be the app's fault, not theirs.
  if (res.status === 401 && session.token()) {
    const fresh = await refreshOnce();
    if (fresh) res = await raw(url, options, fresh);
  }

  if (res.status === 204) return null;
  const body = await readBody(res);

  if (!res.ok) {
    if (res.status === 401) {
      session.clear();
      // Announce it, so the provider drops the stale user and its existing
      // redirect can do its job.
      emitSessionLost();
    }

    // A 5xx that isn't JSON did not come from the API. Express answers with
    // res.json() even for its catch-all 500, so a plain-text or empty body at
    // this status is the dev proxy reporting that it reached nothing — which
    // Next does as a bare `Internal Server Error`, a status that otherwise reads
    // as "the backend crashed on your request" and sends you debugging the wrong
    // machine.
    if (res.status >= 500 && (!body || body._raw !== undefined)) {
      throw unreachable(new Error(`HTTP ${res.status}`));
    }

    throw new ApiError(
      body?.error || body?._raw?.slice(0, 200) || `${options.method || 'GET'} ${path} → ${res.status}`,
      { status: res.status, code: body?.code, body }
    );
  }
  return body;
}

export const get  = (p)       => api(p);
export const post = (p, data) => api(p, { method: 'POST', body: JSON.stringify(data ?? {}) });
export const put  = (p, data) => api(p, { method: 'PUT',  body: JSON.stringify(data ?? {}) });
export const del  = (p)       => api(p, { method: 'DELETE' });

// ── Sign in ───────────────────────────────────────────────────────────────────

/**
 * Sign in against the shared backend.
 *
 * Goes through the same-origin proxy on purpose. The backend reads the Origin
 * header to decide the token's audience, so signing in through the proxy is what
 * makes `AUDIENCE_ORIGINS=http://localhost:3100=studio` work locally — and
 * therefore what lets you turn ENFORCE_TOKEN_AUDIENCE on and find out whether
 * the claim is right BEFORE production is the thing telling you.
 */
export async function login(email, password) {
  const res = await raw('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  }, null);

  const body = await readBody(res);
  if (!res.ok) {
    if (res.status >= 500 && (!body || body._raw !== undefined)) {
      throw unreachable(new Error(`HTTP ${res.status}`));
    }
    throw new ApiError(body?.message || body?.error || `Sign-in failed (${res.status})`, {
      status: res.status, code: body?.code, body,
    });
  }
  if (!body?.access_token) throw new ApiError('Sign-in returned no token.', { status: res.status });

  session.set(body.access_token, body.user);
  return body.user;
}

export function logout() {
  session.clear();
  // Best effort — the refresh cookie is the backend's to clear.
  raw('/api/auth/logout', { method: 'POST' }, session.token()).catch(() => {});
}
