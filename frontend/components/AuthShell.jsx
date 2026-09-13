'use client';

import Link from 'next/link';
// The auth screens are styled by the landing stylesheet — same design language,
// same plate. Imported here so every screen using this shell gets it, rather
// than each page remembering to.
import '../app/landing.css';
import Plate from './Plate';

/**
 * The frame every auth screen sits in.
 *
 * There are four of them now — sign in, sign up, forgot password, reset password
 * — and they are the same page with a different card in the right-hand column.
 * Sign-in and sign-up already shared one component because they share a form;
 * the two password screens do not, so without this they would have been a second
 * way to build an auth page, and the masthead, the plate and the split would
 * drift apart one fix at a time.
 *
 * The plate is deliberately the same component and the same footage as the front
 * door. Continuity of the picture across a navigation is what tells someone they
 * are still on the site they think they are on — which matters most on exactly
 * these screens, where a person is being asked for a password.
 */
export default function AuthShell({ assets = null, children }) {
  return (
    <div className="lp lp-auth">
      <div className="lp-wrap">
        <header className="lp-masthead">
          <Link href="/" className="word">Studio</Link>
          <nav className="lp-mast-right">
            <Link href="/">← Back to the site</Link>
          </nav>
        </header>

        <div className="lp-auth-split">
          <Plate
            assets={assets}
            className="lp-auth-plate"
            label="Aanya Kapoor, generated — running at first light, one take"
          />
          <main className="lp-auth-main">
            {children}
          </main>
        </div>
      </div>
    </div>
  );
}

/**
 * A labelled input. Lived inside AuthScreen, which meant the password screens
 * could not use it without importing from the sign-in screen — the kind of
 * dependency that reads as an accident and gets copy-pasted away instead.
 */
export function Field({ label, hint, children }) {
  return (
    <label className="lp-field">
      <span className="lp-field-label">{label}</span>
      {children}
      {hint && <span className="lp-field-hint">{hint}</span>}
    </label>
  );
}
