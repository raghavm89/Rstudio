/**
 * Everything that talks to /api/auth.
 *
 * Split from `lib/api.js` because the two have opposite preconditions: `api()`
 * requires a session and knows how to renew one, while these calls are how a
 * session comes to exist. Routing sign-in through a client that retries on 401
 * by refreshing would be circular.
 *
 * All of it goes through the same-origin proxy. That is load-bearing twice: the
 * refresh token arrives as an HttpOnly cookie scoped to `/api/auth`, which only
 * comes back on a same-origin request, and the backend reads the Origin to
 * decide the token's audience — so a login proxied from the Studio frontend is
 * what makes `AUDIENCE_ORIGINS=…=studio` mean anything.
 */

import { ApiError, session } from './api';

async function call(path, body) {
  let res;
  try {
    res = await fetch(`/api/auth/${path}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
  } catch (err) {
    throw new ApiError(
      'The Studio is not responding. Check your connection and try again in a moment.',
      { status: 0, code: 'API_UNREACHABLE', body: { cause: err?.message } }
    );
  }

  const text = await res.text().catch(() => '');
  let parsed = null;
  if (text) { try { parsed = JSON.parse(text); } catch { parsed = { _raw: text }; } }

  if (!res.ok) {
    if (res.status >= 500 && (!parsed || parsed._raw !== undefined)) {
      throw new ApiError(
        'The backend answered, but not with anything the app can read. It may have crashed on this request.',
        { status: res.status, code: 'API_UNREACHABLE' }
      );
    }
    // `message` before `error` on purpose: the backend puts the sentence written
    // for a person in `message` and the short label in `error`, and "Account not
    // found" alone does not tell someone what to do next.
    throw new ApiError(parsed?.message || parsed?.error || `Request failed (${res.status})`, {
      status: res.status, code: parsed?.code, body: parsed,
    });
  }
  return parsed || {};
}

export const auth = {
  /**
   * Sign in with an email address or a mobile number.
   *
   * Sent as `identifier` because it is no longer necessarily an email. The
   * server still accepts `email` for older callers, but this one knows better
   * and should say what it means.
   *
   * Throws ApiError; `err.body.no_account` distinguishes "wrong password", and
   * `err.body.identifier_kind` says which box to prefill on the sign-up tab.
   */
  async login(identifier, password) {
    const out = await call('login', { identifier, password });
    session.set(out.access_token, out.user);
    return out.user;
  },

  /**
   * Start a sign-up. Creates a `pending_registrations` row and emails a code —
   * no account and no session exist until that code comes back, so this
   * resolving is not "you are signed up", it is "check your email".
   */
  register({ name, email, password, phone }) {
    // Phone is required now, so it is sent unconditionally rather than only when
    // present. Trimming still matters — a trailing space is the difference
    // between a number libphonenumber parses and one it does not.
    return call('register', {
      name, email, password, phone_number: (phone || '').trim(),
    });   // { pending_id, expires_at, email_sent }
  },

  /**
   * Hop one of two: prove the email, which triggers the SMS.
   *
   * This used to finish the sign-up and set the session. It no longer does —
   * nothing exists until the phone code comes back — so it returns the next step
   * rather than a user, and calling `session.set` on this response would set a
   * session from a body that has no token in it.
   *
   * Returns { next: 'phone', phone_hint, expires_at, pending_id }.
   */
  verifyEmail(pendingId, code) {
    return call('verify-email', { pending_id: pendingId, code });
  },

  /** Hop two. This is where the account, the workspace and the session appear. */
  async verifyPhoneSignup(pendingId, code) {
    const out = await call('verify-phone-signup', { pending_id: pendingId, code });
    session.set(out.access_token, out.user);
    return out.user;
  },

  resendPhone(pendingId) {
    return call('resend-phone-signup', { pending_id: pendingId });
  },

  /**
   * Ask for a reset link.
   *
   * Resolves the same way whether or not the address is registered — the server
   * answers 200 either way so the endpoint cannot be used to enumerate accounts.
   * Anything that rejects here is a real fault, not "no such user", which is why
   * the screen treats a rejection as our problem rather than the caller's.
   */
  /**
   * Verify a phone on an EXISTING account, after sign-in was refused for it.
   *
   * Distinct from `verifyPhoneSignup`, which creates the account. This one is
   * for a person who already has one and whose number was never confirmed —
   * every account made before phone verification existed. It returns a session,
   * so a correct code completes the sign-in that was interrupted.
   */
  async verifyPhone(userId, code) {
    const out = await call('verify-phone', { user_id: userId, code });
    session.set(out.access_token, out.user);
    return out.user;
  },

  resendLoginOtp(userId) {
    return call('resend-otp', { user_id: userId });
  },

  requestPasswordReset(email) {
    return call('forgot-password', { email: (email || '').trim() });
  },

  /**
   * Set a new password from an emailed token.
   *
   * Deliberately does NOT set a session on success. Proving you can read an
   * inbox is not proving you know the password, and silently signing someone in
   * from a link in their email is how a forwarded message becomes an account
   * takeover. The screen sends them to sign in with the password they just set.
   */
  resetPassword(token, password) {
    return call('reset-password', { token, password });
  },

  resend(pendingId) {
    return call('resend-verification', { pending_id: pendingId });
  },

  /** Trade an OAuth handoff code for a session. */
  async exchange(code) {
    const out = await call('oauth/exchange', { code });
    session.set(out.access_token, out.user);
    return out.user;
  },

  /**
   * Silent renewal from the HttpOnly refresh cookie. Returns the user, or null.
   *
   * Only a 401 is treated as "signed out". A network blip or a backend restart
   * must not throw away a session that is still perfectly valid — that turns a
   * two-second outage into everyone being logged out.
   */
  async refresh() {
    try {
      const out = await call('refresh', {});
      if (out.access_token) {
        session.set(out.access_token, out.user || session.user());
        return out.user || session.user();
      }
      return null;
    } catch (err) {
      if (err.status === 401) { session.clear(); return null; }
      return session.user();
    }
  },

  async logout() {
    const token = session.token();
    session.clear();
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'include',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
    } catch { /* the local session is already gone; the cookie is the backend's */ }
  },
};

/** Where OAuth starts. `app=studio` is sealed into signed state by the backend. */
export const oauthUrl = (provider) => `/api/auth/${provider}?app=studio`;
