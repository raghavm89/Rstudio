'use client';

import { useState } from 'react';
import Link from 'next/link';
import AuthShell, { Field } from './AuthShell';
import { auth } from '../lib/auth';
import { ApiError } from '../lib/api';

/**
 * Ask for a reset link.
 *
 * ── Why this always says the same thing ─────────────────────────────────────
 * The server answers 200 whether or not the address exists, on purpose: a page
 * that says "no account with that email" is an account-enumeration oracle, and
 * this one is unauthenticated and rate-limited rather than guarded. So the
 * screen has to be honest in the same shape — "if an account exists" — rather
 * than promising a link it may not have sent.
 *
 * That is a worse experience for someone who mistyped their address, so the
 * confirmation names the exact address it was given. Seeing your own typo back
 * is the only correction this design can offer, and it is enough surprisingly
 * often.
 */
export default function ForgotPassword({ assets = null }) {
  const [email, setEmail] = useState('');
  const [busy, setBusy]   = useState(false);
  const [sent, setSent]   = useState(null);   // the address we submitted
  const [err, setErr]     = useState(null);

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setErr(null);
    const address = email.trim();
    try {
      await auth.requestPasswordReset(address);
      setSent(address);
    } catch (e2) {
      // A failure here is ours — the server refuses to distinguish "unknown
      // address", so anything that reaches this branch is a real fault.
      setErr(e2 instanceof ApiError ? e2 : new ApiError(e2.message));
    } finally { setBusy(false); }
  }

  if (sent) {
    return (
      <AuthShell assets={assets}>
        <div className="lp-auth-card">
          <div className="lp-kicker">Check your email</div>
          <h1 className="lp-auth-h1">On its <em>way</em>.</h1>
          <p className="lp-auth-deck">
            If an account exists for <b>{sent}</b>, a reset link is in the inbox now.
            It works once and expires in 30 minutes.
          </p>

          <div className="lp-msg">
            <b>Nothing arrived?</b>
            <span>
              Check spam, and check the address above for typos — we cannot tell you
              whether it is registered, which is deliberate.
            </span>
          </div>

          <div className="lp-auth-alt">
            <button className="lp-link" onClick={() => { setSent(null); setErr(null); }}>
              Use a different address
            </button>
            <span className="lp-note"><Link href="/login">Back to sign in</Link></span>
          </div>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell assets={assets}>
      <div className="lp-auth-card">
        <div className="lp-kicker">Forgotten password</div>
        <h1 className="lp-auth-h1">Reset your <em>password</em>.</h1>
        <p className="lp-auth-deck">
          Enter the email you signed up with and we will send a link to set a new one.
        </p>

        <form onSubmit={submit} className="lp-auth-form">
          <Field label="Email" hint="The address on the account, not your mobile number.">
            <input
              type="email" value={email} onChange={(e) => setEmail(e.target.value)}
              autoComplete="email" required autoFocus placeholder="you@example.com"
            />
          </Field>

          <button className="lp-btn wide" type="submit" disabled={busy}>
            {busy ? 'One moment…' : 'Send the link'}
            {!busy && <span aria-hidden="true">→</span>}
          </button>
        </form>

        {err && (
          <div className="lp-msg warn" role="alert">
            <b>That did not send</b>
            <span>{err.message}</span>
          </div>
        )}

        <div className="lp-auth-alt">
          <span className="lp-note">
            Remembered it? <Link href="/login">Sign in</Link>
          </span>
        </div>
      </div>
    </AuthShell>
  );
}
