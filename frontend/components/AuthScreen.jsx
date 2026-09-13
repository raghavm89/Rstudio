'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import AuthShell, { Field } from './AuthShell';
import { useAuth } from './AuthProvider';
import { auth, oauthUrl } from '../lib/auth';
import { ApiError } from '../lib/api';

/**
 * Sign in and create an account — set as the same title as the front door.
 *
 * The first version of this screen was built in the app's design system, which
 * made the door look like a different building from the house. Someone arriving
 * from the landing page has just been shown a fashion title; a violet SaaS card
 * a click later reads as a redirect to somewhere else, and the moment a person
 * doubts they are still on the right site is the moment they stop typing a
 * password.
 *
 * So: same ivory paper, same didone, same mono credits, same hairline masthead —
 * and the same PLATE, literally the same component, carrying the same footage.
 * That last part is the one that does the work. Continuity of a picture across a
 * navigation is worth more than any amount of matching border-radius.
 *
 * ── The shape ───────────────────────────────────────────────────────────────
 * One page, two tabs, three steps. One page because the two forms share almost
 * everything and, more to the point, because the paths cross constantly: you try
 * to sign in and have no account, you try to sign up and already do. Both are a
 * tab switch here rather than a dead end with a link at the bottom.
 *
 * The third step is the code. A sign-up creates no account — it creates a
 * pending row and sends six digits, and nothing exists until they come back. So
 * the screen has to hold someone through a wait, which is why every limit the
 * backend enforces is shown: the expiry, the resend cooldown, the attempts left.
 * A limit you cannot see is indistinguishable from the thing being broken.
 */

const OTP_LENGTH = 6;

export default function AuthScreen({ assets = null }) {
  const params = useSearchParams();
  const router = useRouter();
  const { signIn, completeSignUp, verifyEmailStep, completePhoneLogin, signedIn, ready } = useAuth();

  const [tab, setTab] = useState(params.get('tab') === 'signup' ? 'signup' : 'login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [noAccount, setNoAccount] = useState(false);
  // Which box the sign-up tab should prefill when sign-in found nothing. The
  // server says, rather than the form guessing again from the same string.
  const [noAccountKind, setNoAccountKind] = useState('email');
  // The server distinguishes "no such account" from "a sign-up was started and
  // never finished". The card used to render its own copy for both.
  const [noAccountMsg, setNoAccountMsg] = useState(null);
  const [pending, setPending] = useState(null);

  const next = params.get('next') || '/avatars';

  // Already signed in — nothing to do here. Happens when someone bookmarks
  // /login, or returns to a tab that renewed its session in the background.
  useEffect(() => { if (ready && signedIn) router.replace(next); }, [ready, signedIn, next, router]);

  async function submitSignIn(e) {
    e.preventDefault();
    setBusy(true); setErr(null); setNoAccount(false);
    try {
      await signIn(email.trim(), password);
      router.replace(next);
    } catch (e2) {
      const error = e2 instanceof ApiError ? e2 : new ApiError(e2.message);
      // The backend answers an unknown email with 404 + no_account rather than
      // "invalid credentials", so the honest response is to offer the sign-up
      // tab with the address already typed — not to imply a mistyped password.
      if (error.body?.no_account) {
        setNoAccount(true);
        setNoAccountKind(error.body.identifier_kind === 'phone' ? 'phone' : 'email');
        setNoAccountMsg(error.message || null);
      }
      // The password was right; the account's number was never confirmed. A code
      // has already been sent, so this is a step in the sign-in rather than a
      // failure of it. Without this branch the code went out and there was
      // nowhere in the product to type it.
      else if (error.body?.code === 'PHONE_UNVERIFIED' && error.body?.user_id) {
        setPending({
          kind     : 'login',
          userId   : error.body.user_id,
          stage    : 'phone',
          phoneHint: error.body.phone_hint || 'your phone',
          expiresAt: Date.now() + 600_000,
        });
      }
      else setErr(error);
    } finally { setBusy(false); }
  }

  async function submitSignUp(e) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const out = await auth.register({ name: name.trim(), email: email.trim(), password, phone });
      setPending({
        id: out.pending_id,
        expiresAt: out.expires_at ? new Date(out.expires_at).getTime() : Date.now() + 600_000,
        emailSent: out.email_sent,
      });
    } catch (e2) {
      setErr(e2 instanceof ApiError ? e2 : new ApiError(e2.message));
    } finally { setBusy(false); }
  }

  return (
    <AuthShell assets={assets}>
            {pending ? (
              <CodeStep
                // `key` matters: without it React reuses the same CodeStep
                // instance across the two hops, and the six digits just typed
                // stay in the boxes for the phone step — which looks like the
                // form ignoring you, and submits the email code to the SMS
                // endpoint if you press enter.
                key={`${pending.kind || 'signup'}:${pending.stage || 'email'}`}
                stage={pending.stage || 'email'}
                destination={pending.stage === 'phone' ? pending.phoneHint : email}
                pending={pending}
                onResend={() => (pending.kind === 'login'
                  ? auth.resendLoginOtp(pending.userId)
                  : pending.stage === 'phone'
                    ? auth.resendPhone(pending.id)
                    : auth.resend(pending.id))}
                onVerified={async (code) => {
                  // An interrupted sign-in: one code, and it completes the
                  // sign-in rather than creating anything.
                  if (pending.kind === 'login') {
                    await completePhoneLogin(pending.userId, code);
                    router.replace(next);
                    return;
                  }
                  if ((pending.stage || 'email') === 'email') {
                    // Hop one returns the next step, not a session.
                    const out = await verifyEmailStep(pending.id, code);
                    setPending((p) => ({
                      ...p,
                      stage    : 'phone',
                      phoneHint: out.phone_hint || 'your phone',
                      expiresAt: out.expires_at ? new Date(out.expires_at).getTime() : Date.now() + 600_000,
                      emailSent: undefined,
                    }));
                    return;
                  }
                  await completeSignUp(pending.id, code);
                  router.replace(next);
                }}
                onBack={() => { setPending(null); setErr(null); }}
              />
            ) : (
              <div className="lp-auth-card">
                <div className="lp-kicker">
                  {tab === 'login' ? 'Welcome back' : 'Create an account'}
                </div>
                <h1 className="lp-auth-h1">
                  {tab === 'login'
                    ? <>Sign in to <em>Studio</em>.</>
                    : <>Start with a <em>free</em> shoot.</>}
                </h1>

                <div className="lp-tabs" role="tablist">
                  <button role="tab" aria-selected={tab === 'login'}
                          className={tab === 'login' ? 'on' : ''}
                          onClick={() => { setTab('login'); setErr(null); setNoAccount(false); }}>
                    Sign in
                  </button>
                  <button role="tab" aria-selected={tab === 'signup'}
                          className={tab === 'signup' ? 'on' : ''}
                          onClick={() => { setTab('signup'); setErr(null); setNoAccount(false); }}>
                    Create account
                  </button>
                </div>

                <form onSubmit={tab === 'login' ? submitSignIn : submitSignUp}>
                  {tab === 'signup' && (
                    <Field label="Your name">
                      <input value={name} onChange={(e) => setName(e.target.value)}
                             autoComplete="name" required placeholder="Raghav Mahajan" />
                    </Field>
                  )}

                  {/* Sign-in accepts either; sign-up still needs the address,
                      because that is where the first verification code goes.
                      `type` follows suit — type="email" on the sign-in box would
                      make the browser reject a phone number before it is sent,
                      with a validation bubble that says nothing useful. */}
                  <Field label={tab === 'login' ? 'Email or mobile number' : 'Email'}>
                    <input
                      type={tab === 'login' ? 'text' : 'email'}
                      inputMode={tab === 'login' ? 'text' : 'email'}
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      autoComplete="username" required
                      placeholder={tab === 'login' ? 'you@example.com  ·  98765 43210' : 'you@example.com'}
                    />
                  </Field>

                  <Field label="Password" hint={tab === 'signup' ? 'At least 8 characters.' : null}>
                    <div className="lp-pw">
                      <input type={showPw ? 'text' : 'password'} value={password}
                             onChange={(e) => setPassword(e.target.value)}
                             autoComplete={tab === 'login' ? 'current-password' : 'new-password'}
                             required minLength={tab === 'signup' ? 8 : undefined} />
                      <button type="button" onClick={() => setShowPw((v) => !v)}
                              aria-label={showPw ? 'Hide password' : 'Show password'}>
                        {showPw ? 'Hide' : 'Show'}
                      </button>
                    </div>
                  </Field>

                  {tab === 'signup' && (
                    <Field
                      label="Mobile number"
                      hint="We text a code to confirm it. Numbers without a country code are read as +91.">
                      <input value={phone} onChange={(e) => setPhone(e.target.value)}
                             autoComplete="tel" inputMode="tel" required
                             placeholder="+91 98765 43210" />
                    </Field>
                  )}

                  <button className="lp-btn wide" type="submit" disabled={busy}>
                    {busy ? 'One moment…' : tab === 'login' ? 'Sign in' : 'Create account'}
                    {!busy && <span aria-hidden="true">→</span>}
                  </button>
                </form>

                {noAccount && (
                  <div className="lp-msg violet">
                    <b>No account with that {noAccountKind === 'phone' ? 'number' : 'email'}.</b>
                    <span>
                      {/* The server says which of the two this is — a genuinely
                          unknown address, or a sign-up that was started and never
                          verified. Telling the second person "no account exists"
                          contradicts the email they are looking at. */}
                      {noAccountMsg || 'Studio shares its accounts with rstudio.app — if you signed up somewhere else, it will not be here.'}
                    </span>
                    <button
                      className="lp-link"
                      onClick={() => {
                        // Carrying a phone number into the email box would leave
                        // them staring at "enter a valid email" holding the thing
                        // they just typed. Move it to the field it belongs in.
                        if (noAccountKind === 'phone') { setPhone(email); setEmail(''); }
                        setTab('signup');
                        setNoAccount(false);
                        setNoAccountMsg(null);
                      }}>
                      Create one with {email || 'this'} →
                    </button>
                  </div>
                )}

                {err && (
                  <div className={`lp-msg ${err.code === 'API_UNREACHABLE' ? 'warn' : 'crit'}`}>
                    <b>{err.code === 'API_UNREACHABLE' ? 'The backend is not answering' : 'That did not work'}</b>
                    <span>{err.message}</span>
                  </div>
                )}

                <div className="lp-rule-or"><span>or</span></div>

                <div className="lp-oauth">
                  <a className="lp-oauth-btn" href={oauthUrl('google')}><GoogleMark /> Continue with Google</a>
                  <a className="lp-oauth-btn" href={oauthUrl('github')}><GitHubMark /> Continue with GitHub</a>
                </div>

                <p className="lp-note lp-auth-foot">
                  {tab === 'login'
                    ? <Link href="/forgot-password">Forgotten your password?</Link>
                    : 'Free tier · No card · Nothing publishes without you'}
                </p>
              </div>
            )}
    </AuthShell>
  );
}

// ── The six digits ───────────────────────────────────────────────────────────

/**
 * One component for both codes.
 *
 * Sign-up now asks for two six-digit codes — email, then SMS — and the second
 * screen is the first screen with different words on it. Copying it would mean
 * every later fix to paste handling, focus movement or the expiry clock has to
 * be made twice, and the second copy is the one that gets forgotten.
 *
 * `stage` is the only thing that differs: the heading, which endpoint the resend
 * button calls, and the step counter.
 */
function CodeStep({ stage = 'email', destination, email, pending, onVerified, onResend, onBack }) {
  const isPhone = stage === 'phone';
  // The same six boxes serve a sign-up and an interrupted sign-in. They are not
  // the same story: one is step three of three, the other is a detour on the way
  // in, and telling someone signing in that they are on "step three of three"
  // implies they are creating something they already have.
  const isLogin = pending.kind === 'login';
  const [digits, setDigits] = useState(Array(OTP_LENGTH).fill(''));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [resendIn, setResendIn] = useState(60);
  const [resendsLeft, setResendsLeft] = useState(5);
  const [resent, setResent] = useState(null);
  const [left, setLeft] = useState(() => Math.max(0, Math.floor((pending.expiresAt - Date.now()) / 1000)));
  const refs = useRef([]);

  useEffect(() => {
    const id = setInterval(() => {
      setLeft(Math.max(0, Math.floor((pending.expiresAt - Date.now()) / 1000)));
      setResendIn((s) => Math.max(0, s - 1));
    }, 1000);
    return () => clearInterval(id);
  }, [pending.expiresAt]);

  useEffect(() => { refs.current[0]?.focus(); }, []);

  const fmt = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

  const submit = useCallback(async (code) => {
    setBusy(true); setErr(null);
    try {
      await onVerified(code);
    } catch (e) {
      setErr(e instanceof ApiError ? e : new ApiError(e.message));
      setDigits(Array(OTP_LENGTH).fill(''));
      refs.current[0]?.focus();
    } finally { setBusy(false); }
  }, [onVerified]);

  function setAt(i, v) {
    const ch = v.replace(/\D/g, '').slice(-1);
    const next = [...digits];
    next[i] = ch;
    setDigits(next);
    if (ch && i < OTP_LENGTH - 1) refs.current[i + 1]?.focus();
    // Submit the moment it is complete. Asking someone to type six digits and
    // then find a button is one step too many for something they are copying
    // out of another window.
    if (next.every((d) => d)) submit(next.join(''));
  }

  function onKeyDown(i, e) {
    if (e.key === 'Backspace' && !digits[i] && i > 0) refs.current[i - 1]?.focus();
    if (e.key === 'ArrowLeft' && i > 0) refs.current[i - 1]?.focus();
    if (e.key === 'ArrowRight' && i < OTP_LENGTH - 1) refs.current[i + 1]?.focus();
  }

  // People paste the whole code. Without this, six characters land in one box.
  function onPaste(e) {
    const text = (e.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, OTP_LENGTH);
    if (!text) return;
    e.preventDefault();
    const next = Array(OTP_LENGTH).fill('');
    text.split('').forEach((c, i) => { next[i] = c; });
    setDigits(next);
    if (text.length === OTP_LENGTH) submit(text);
    else refs.current[text.length]?.focus();
  }

  async function resend() {
    setBusy(true); setErr(null); setResent(null);
    try {
      // The caller says how to resend. CodeStep is now used by three different
      // flows — sign-up email, sign-up SMS, and an interrupted sign-in — and a
      // switch in here would have to grow a case every time, in the one file
      // least likely to be re-read.
      const out = await onResend();
      setResent(out.message || 'Code resent.');
      setResendsLeft(out.resends_remaining ?? resendsLeft - 1);
      setResendIn(60);
    } catch (e) {
      const error = e instanceof ApiError ? e : new ApiError(e.message);
      if (error.body?.retry_after) setResendIn(error.body.retry_after);
      if (error.body?.resends_remaining !== undefined) setResendsLeft(error.body.resends_remaining);
      setErr(error);
    } finally { setBusy(false); }
  }

  return (
    <div className="lp-auth-card">
      <div className="lp-kicker">
        {isLogin ? 'One more step' : isPhone ? 'Step three of three' : 'Step two of three'}
      </div>
      <h1 className="lp-auth-h1">
        {isPhone ? <>Check your <em>phone</em>.</> : <>Check your <em>email</em>.</>}
      </h1>
      <p className="lp-auth-deck">
        {isLogin
          ? <>Your password was right. This number has never been confirmed, so we sent six digits to <b>{destination}</b>. They expire in {fmt(left)}.</>
          : <>Six digits, sent to <b>{destination || email}</b>. They expire in {fmt(left)}.</>}
      </p>

      {isPhone && !isLogin && (
        <p className="lp-note">
          Wrong number? <button type="button" className="lp-link" onClick={onBack}>Start again</button> —
          nothing has been created yet.
        </p>
      )}
      {isLogin && (
        <p className="lp-note">
          No longer have this number? <button type="button" className="lp-link" onClick={onBack}>Go back</button> and
          use “Forgotten your password?” — a reset confirms your email instead.
        </p>
      )}

      {!isPhone && pending.emailSent === false && (
        <div className="lp-msg warn">
          <b>The code may not have sent</b>
          <span>Your account is waiting, but the email service did not confirm delivery. Try Resend.</span>
        </div>
      )}

      <div className="lp-otp" onPaste={onPaste}>
        {digits.map((d, i) => (
          <input
            key={i}
            ref={(el) => { refs.current[i] = el; }}
            value={d}
            onChange={(e) => setAt(i, e.target.value)}
            onKeyDown={(e) => onKeyDown(i, e)}
            inputMode="numeric"
            autoComplete={i === 0 ? 'one-time-code' : 'off'}
            maxLength={1}
            disabled={busy}
            aria-label={`Digit ${i + 1}`}
          />
        ))}
      </div>

      {err && <div className="lp-msg crit"><b>That code did not work</b><span>{err.message}</span></div>}
      {resent && !err && <p className="lp-msg ok"><span>{resent}</span></p>}

      <div className="lp-otp-actions">
        <button className="lp-link" onClick={resend} disabled={busy || resendIn > 0 || resendsLeft <= 0}>
          {resendsLeft <= 0 ? 'No resends left'
            : resendIn > 0 ? `Resend in ${resendIn}s`
            : 'Resend code'}
        </button>
        <span className="lp-note">{resendsLeft} of 5 resends left</span>
      </div>

      <button className="lp-link lp-back" onClick={onBack}>← Use a different email</button>
    </div>
  );
}


function GoogleMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 18 18" aria-hidden="true">
      <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4"/>
      <path d="M9 18c2.43 0 4.467-.806 5.956-2.18L12.048 13.56C11.24 14.1 10.211 14.42 9 14.42c-2.392 0-4.417-1.616-5.142-3.786H.957v2.332C2.438 15.983 5.482 18 9 18z" fill="#34A853"/>
      <path d="M3.858 10.634A5.452 5.452 0 013.52 9c0-.563.097-1.11.338-1.634V5.034H.957A9 9 0 000 9c0 1.452.348 2.827.957 4.034l2.9-2.4z" fill="#FBBC05"/>
      <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0 5.482 0 2.438 2.017.957 4.966l2.9 2.4C4.584 5.196 6.608 3.58 9 3.58z" fill="#EA4335"/>
    </svg>
  );
}

function GitHubMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z"/>
    </svg>
  );
}
