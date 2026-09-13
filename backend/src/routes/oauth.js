'use strict';

/**
 * OAuth 2.0 routes — Google and GitHub.
 * Flow:
 *   1. Browser hits GET /api/auth/google  → redirect to provider
 *   2. Provider redirects to /api/auth/google/callback with ?code=xxx
 *   3. We exchange code → access token → user profile
 *   4. Find or create local user, issue JWT, redirect to frontend /auth/callback
 */

const { Router } = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');

const router = Router();

const OAuthState   = require('../services/oauthState');
const Provisioning = require('../services/studio/provisioning');

// Moved to src/utils/siteUrl.js — the password-reset path needs the same
// normalisation, and a second copy of it is how one of them stays wrong.
const { siteUrl } = require('../utils/siteUrl');

const APP_URL        = siteUrl(process.env.APP_URL, 'http://localhost:3000');
const STUDIO_APP_URL = siteUrl(process.env.STUDIO_APP_URL, 'http://localhost:3100');
const BACKEND_URL    = (process.env.BACKEND_URL || 'http://localhost:8080').replace(/\/$/, '');

/** Where a finished sign-in should land, by app. */
const returnTo = (audience) => (audience === 'studio' ? STUDIO_APP_URL : APP_URL);

/**
 * Read `?app=` at the START of a flow, where it is safe to trust it: nothing has
 * been minted yet, and the value is immediately sealed into signed state. It is
 * never read again from the query string on the way back.
 */
function requestedApp(req) {
  const raw = String(req.query.app || '').toLowerCase();
  return raw === 'studio' ? 'studio' : 'platform';
}

// ── Token helper (same pattern as authController) ────────────────────────────

function issueAccessToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role, name: user.name },
    process.env.JWT_ACCESS_SECRET,
    { expiresIn: '8h' }
  );
}

// ── Redirect helper ───────────────────────────────────────────────────────────

function redirectWithToken(res, user, accessToken) {
  const userData = encodeURIComponent(JSON.stringify({
    id:           user.id,
    name:         user.name,
    email:        user.email,
    role:         user.role,
    phone_number: user.phone_number || '',
    address:      user.address || null,
    tenant_id:    user.tenant_id || null,
    tenant_name:  user.tenant_name || null,
  }));
  res.redirect(`${APP_URL}/auth/callback?token=${accessToken}&user=${userData}`);
}

function redirectWithError(res, msg, audience = 'platform') {
  res.redirect(`${returnTo(audience)}/auth/callback?error=${encodeURIComponent(msg)}`);
}

/**
 * Finish a sign-in.
 *
 * Studio takes the handoff route: the redirect carries a single-use code instead
 * of a bearer token, and the frontend trades it same-origin — so no live token
 * ever appears in a URL, in history, or in a Referer header, and the refresh
 * cookie gets set on the origin the person is actually on rather than on the
 * backend's, which is why the token-in-URL flow could never work in development.
 *
 * The platform path is left exactly as it was. Changing it would break
 * rstudio.app's existing /auth/callback page, and that is a separate decision
 * from making Studio work.
 */
async function finishSignIn(res, user, audience, provider) {
  if (audience !== 'studio') {
    return redirectWithToken(res, user, issueAccessToken(user));
  }

  // Self-serve means a Studio sign-in must end somewhere they can work. An OAuth
  // user has no pending_registrations row, so nothing in the sign-up path will
  // ever run for them — without this they arrive at an app scoped to no tenant.
  try {
    await Provisioning.ensureWorkspace(user.id);
  } catch (err) {
    console.error('[oauth] workspace provisioning failed:', err.message);
    // Not fatal: GET /api/studio/me provisions on the next request.
  }

  const code = await OAuthState.createHandoff({ userId: user.id, audience, provider });
  res.redirect(`${STUDIO_APP_URL}/auth/callback?code=${encodeURIComponent(code)}`);
}

// ── Find or create user from OAuth profile ────────────────────────────────────

async function findOrCreateOAuthUser({ email, name, provider }) {
  // Check if user already exists
  const { rows } = await pool.query(
    'SELECT * FROM users WHERE email = $1 LIMIT 1',
    [email.toLowerCase()]
  );

  if (rows.length) {
    const user = rows[0];
    // Mark email as verified if not already (OAuth providers verify emails)
    if (!user.email_verified) {
      await pool.query('UPDATE users SET email_verified = true WHERE id = $1', [user.id]);
      user.email_verified = true;
    }
    return user;
  }

  // Create new user — no password (OAuth users can use forgot-password to set one later)
  const dummyHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);
  const { rows: created } = await pool.query(
    `INSERT INTO users (name, email, password_hash, role, email_verified)
     VALUES ($1, $2, $3, 'tenant_user', true)
     RETURNING *`,
    [name, email.toLowerCase(), dummyHash]
  );
  return created[0];
}

// ── Google OAuth ──────────────────────────────────────────────────────────────

router.get('/google', (req, res) => {
  const params = new URLSearchParams({
    client_id:     process.env.GOOGLE_CLIENT_ID,
    redirect_uri:  `${BACKEND_URL}/api/auth/google/callback`,
    response_type: 'code',
    scope:         'openid email profile',
    access_type:   'offline',
    prompt:        'select_account',
    state:         OAuthState.create(requestedApp(req)),
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

router.get('/google/callback', async (req, res) => {
  const { code, error } = req.query;

  // Verified BEFORE the code is exchanged. Without state, an attacker can
  // complete an authorization with their own Google account and get a victim's
  // browser to finish it — silently signing the victim into the attacker's
  // account, where everything they do afterwards is readable by its owner.
  const audience = OAuthState.verify(req.query.state);
  if (!audience) return redirectWithError(res, 'That sign-in link has expired. Please try again.');

  if (error || !code) return redirectWithError(res, 'Google sign-in was cancelled or failed.', audience);

  try {
    // Exchange code for tokens
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id:     process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri:  `${BACKEND_URL}/api/auth/google/callback`,
        grant_type:    'authorization_code',
      }),
    });
    const tokens = await tokenRes.json();
    if (!tokenRes.ok) throw new Error(tokens.error_description || 'Token exchange failed');

    // Get user profile
    const profileRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const profile = await profileRes.json();
    if (!profile.email) throw new Error('Could not retrieve email from Google');

    const user = await findOrCreateOAuthUser({
      email:    profile.email,
      name:     profile.name || profile.email.split('@')[0],
      provider: 'google',
    });

    await finishSignIn(res, user, audience, 'google');
  } catch (err) {
    console.error('[oauth/google]', err.message);
    redirectWithError(res, err.message || 'Google sign-in failed. Please try again.', audience);
  }
});

// ── GitHub OAuth ──────────────────────────────────────────────────────────────

router.get('/github', (req, res) => {
  const params = new URLSearchParams({
    client_id:    process.env.GITHUB_CLIENT_ID,
    redirect_uri: `${BACKEND_URL}/api/auth/github/callback`,
    scope:        'user:email',
    state:        OAuthState.create(requestedApp(req)),
  });
  res.redirect(`https://github.com/login/oauth/authorize?${params}`);
});

router.get('/github/callback', async (req, res) => {
  const { code, error } = req.query;

  const audience = OAuthState.verify(req.query.state);
  if (!audience) return redirectWithError(res, 'That sign-in link has expired. Please try again.');

  if (error || !code) return redirectWithError(res, 'GitHub sign-in was cancelled or failed.', audience);

  try {
    // Exchange code for access token
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id:     process.env.GITHUB_CLIENT_ID,
        client_secret: process.env.GITHUB_CLIENT_SECRET,
        code,
        redirect_uri:  `${BACKEND_URL}/api/auth/github/callback`,
      }),
    });
    const tokens = await tokenRes.json();
    if (tokens.error) throw new Error(tokens.error_description || 'Token exchange failed');

    // Get user profile
    const profileRes = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${tokens.access_token}`, 'User-Agent': 'Rstudio' },
    });
    const profile = await profileRes.json();

    // GitHub may not expose email publicly — fetch from emails endpoint
    let email = profile.email;
    if (!email) {
      const emailsRes = await fetch('https://api.github.com/user/emails', {
        headers: { Authorization: `Bearer ${tokens.access_token}`, 'User-Agent': 'Rstudio' },
      });
      const emails = await emailsRes.json();
      const primary = emails.find((e) => e.primary && e.verified);
      email = primary?.email;
    }
    if (!email) throw new Error('Could not retrieve a verified email from GitHub');

    const user = await findOrCreateOAuthUser({
      email,
      name:     profile.name || profile.login || email.split('@')[0],
      provider: 'github',
    });

    await finishSignIn(res, user, audience, 'github');
  } catch (err) {
    console.error('[oauth/github]', err.message);
    redirectWithError(res, err.message || 'GitHub sign-in failed. Please try again.', audience);
  }
});

module.exports = router;
