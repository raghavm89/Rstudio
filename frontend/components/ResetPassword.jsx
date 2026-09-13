'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import AuthShell, { Field } from './AuthShell';
import { auth } from '../lib/auth';
import { ApiError } from '../lib/api';

const MIN_LENGTH = 8;

/**
 * Set a new password from an emailed token.
 *
 * ── The token is never put anywhere it can leak ─────────────────────────────
 * It arrives in the query string, which is unavoidable — it came from a link.
 * It is read once into memory and submitted in a POST body; it is not written
 * to state that ends up in the DOM, not echoed on screen, and not sent anywhere
 * except the reset endpoint. A reset token in a rendered page is a reset token
 * in a screenshot, a screen-share and a browser extension.
 *
 * ── Why the missing-token case is its own screen ────────────────────────────
 * Some mail clients truncate long links, and people paste them by hand. Landing
 * here with no token and being shown a password form that fails on submit wastes
 * the one thing this person has already lost patience with. Say it immediately
 * and offer the way back.
 */
export default function ResetPassword({ assets = null }) {
  const params = useSearchParams();
  const router = useRouter();
  const token  = params.get('token');

  const [password, setPassword] = useState('');
  const [confirm, setConfirm]   = useState('');
  const [showPw, setShowPw]     = useState(false);
  const [busy, setBusy]         = useState(false);
  const [err, setErr]           = useState(null);
  const [done, setDone]         = useState(false);

  const tooShort  = password.length > 0 && password.length < MIN_LENGTH;
  // Only once they have started the second field — telling someone their
  // passwords do not match while they are still typing the first character of
  // the confirmation is noise, not help.
  const mismatch  = confirm.length > 0 && password !== confirm;
  const canSubmit = password.length >= MIN_LENGTH && password === confirm && !busy;

  async function submit(e) {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true); setErr(null);
    try {
      await auth.resetPassword(token, password);
      setDone(true);
    } catch (e2) {
      setErr(e2 instanceof ApiError ? e2 : new ApiError(e2.message));
    } finally { setBusy(false); }
  }

  if (!token) {
    return (
      <AuthShell assets={assets}>
        <div className="lp-auth-card">
          <div className="lp-kicker">Reset password</div>
          <h1 className="lp-auth-h1">That link is <em>incomplete</em>.</h1>
          <p className="lp-auth-deck">
            It arrived without its token — usually a mail client that broke the link across
            two lines. Request a new one and open it in a single click.
          </p>
          <Link className="lp-btn wide" href="/forgot-password">
            Send a new link <span aria-hidden="true">→</span>
          </Link>
        </div>
      </AuthShell>
    );
  }

  if (done) {
    return (
      <AuthShell assets={assets}>
        <div className="lp-auth-card">
          <div className="lp-kicker">Done</div>
          <h1 className="lp-auth-h1">Password <em>changed</em>.</h1>
          <p className="lp-auth-deck">
            Every other device has been signed out — if someone else had your old password,
            they no longer have a way in.
          </p>
          {/* No session is created here on purpose. Proving you can read an
              inbox is not the same as proving you know the password, and the
              honest end of a reset is a sign-in with the new one. */}
          <button className="lp-btn wide" onClick={() => router.replace('/login')}>
            Sign in <span aria-hidden="true">→</span>
          </button>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell assets={assets}>
      <div className="lp-auth-card">
        <div className="lp-kicker">Reset password</div>
        <h1 className="lp-auth-h1">Choose a new <em>password</em>.</h1>
        <p className="lp-auth-deck">
          This link works once. Setting a password here signs you out everywhere else.
        </p>

        <form onSubmit={submit} className="lp-auth-form">
          <Field label="New password" hint={`At least ${MIN_LENGTH} characters.`}>
            <div className="lp-pw">
              <input
                type={showPw ? 'text' : 'password'}
                value={password} onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password" required autoFocus
                aria-invalid={tooShort || undefined}
              />
              <button type="button" onClick={() => setShowPw((v) => !v)}
                      aria-label={showPw ? 'Hide password' : 'Show password'}>
                {showPw ? 'Hide' : 'Show'}
              </button>
            </div>
          </Field>

          <Field
            label="Confirm new password"
            hint={mismatch ? 'These two do not match yet.' : null}
          >
            <input
              type={showPw ? 'text' : 'password'}
              value={confirm} onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password" required
              aria-invalid={mismatch || undefined}
            />
          </Field>

          <button className="lp-btn wide" type="submit" disabled={!canSubmit}>
            {busy ? 'One moment…' : 'Set the password'}
            {!busy && <span aria-hidden="true">→</span>}
          </button>
        </form>

        {err && (
          <div className="lp-msg warn" role="alert">
            <b>That did not work</b>
            <span>{err.message}</span>
            {/* An expired or already-used token is the common failure, and the
                only way forward is a fresh link — so offer it rather than
                leaving them to find the route themselves. */}
            <Link className="lp-link" href="/forgot-password">Send a new link →</Link>
          </div>
        )}

        <div className="lp-auth-alt">
          <span className="lp-note"><Link href="/login">Back to sign in</Link></span>
        </div>
      </div>
    </AuthShell>
  );
}
