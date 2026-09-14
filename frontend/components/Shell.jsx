'use client';

import { usePathname } from 'next/navigation';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { get, session } from '../lib/api';
import { useAuth, isPublic } from './AuthProvider';

/**
 * The app shell — sidebar, top bar, usage meter.
 *
 * Two things here are product decisions rather than layout:
 *
 * The USAGE METER lives in the sidebar, visible on every screen, and says
 * "A re-roll spends it too." The free tier meters *generated* seconds, not
 * delivered videos, so the cost of trying again has to be legible before it is
 * spent rather than discovered after. Hiding it behind a billing page would make
 * the metering feel like a trap.
 *
 * The COPY IS PERSONA-NEUTRAL. Aanya is one persona; a customer may build any,
 * and a product that says "her" throughout has quietly decided for them. The
 * pipeline is the same either way.
 *
 * The NAVIGATION IS THE PIPELINE, not a feature list. Find the face → Set the
 * look → Shoot is the whole product, and the order is a dependency chain: you
 * cannot shoot without a trained face, and the app should read that way rather
 * than offering nine equal doors.
 */

const NAV = [
  { section: 'Who' },
  { href: '/avatars',  label: 'Avatar' },
  { section: 'Make' },
  { href: '/shoots',   label: 'Shoots' },
  { href: '/templates', label: 'Templates' },
  { href: '/library',  label: 'Library' },
  { section: 'Out' },
  { href: '/publish',  label: 'Publish' },
  { href: '/insights', label: 'Insights' },
  { section: 'You' },
  { href: '/account',  label: 'Account' },
  { href: '/usage',    label: 'Usage' },
  { href: '/billing',  label: 'Billing' },
];

/**
 * The back office, for platform staff only.
 *
 * Kept out of NAV and appended at render time, because this section is not part
 * of the pipeline the navigation describes — it is a different job done by a
 * different person who happens to sign in through the same door.
 *
 * Hiding the link is presentation, not security. Every route under /admin is
 * refused by the API to anyone whose role is not `admin`, which is what
 * actually protects other tenants' data; this only keeps a door nobody can open
 * out of everyone else's way.
 */
const ADMIN_NAV = [
  { section: 'Back office' },
  { href: '/admin',          label: 'Overview' },
  { href: '/admin/tenants',  label: 'Accounts' },
  { href: '/admin/money',    label: 'Money' },
  { href: '/admin/jobs',     label: 'Jobs' },
  { href: '/admin/catalogue', label: 'Catalogue' },
  { href: '/admin/query',    label: 'Query' },
  { href: '/admin/audit',    label: 'Audit' },
];

function UsageMeter() {
  const [usage, setUsage] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    // Don't ask when there is nothing to ask with. A signed-out meter firing a
    // request it knows will 401 is not just noise: `api` clears the session on a
    // 401, so a late reply from this one can land after a successful sign-in and
    // wipe the token that just arrived.
    if (!session.token()) { setFailed(true); return; }
    get('/usage').then(setUsage).catch(() => setFailed(true));
  }, []);

  // A meter that cannot reach the API shows nothing rather than a zero. A zero
  // reads as "you have used none of your allowance", which is a different and
  // wrong claim.
  if (failed) return null;

  /**
   * `summary()` returns an OBJECT keyed by metric, not an array.
   *
   * This called `.find()` on it. `?.` meant that did not throw — it produced
   * undefined, and the `|| 240` fallback below turned undefined into a
   * confident-looking "0 / 240s". The meter has therefore never shown real
   * usage: it showed a hardcoded default that happens to look plausible, which
   * is the worst kind of wrong number.
   *
   * The field is `limit`, not `limit_value`, which is the second half of the
   * same mistake.
   */
  const video = usage?.usage?.video_seconds;
  const used = Number(video?.used ?? 0);
  const limit = Number(video?.limit ?? 240);
  const pct = limit ? Math.min(100, (used / limit) * 100) : 0;

  return (
    <div className="meter">
      <div className="row">
        <span>Video this month</span>
        <span><b>{Math.round(used)}</b> / {limit}s</span>
      </div>
      <div className="track"><div className="fill" style={{ width: `${pct}%` }} /></div>
      <div className="note">A re-roll spends it too.</div>
    </div>
  );
}

export default function Shell({ children }) {
  const pathname = usePathname() || '';
  const { user, workspace, signedIn, signOut } = useAuth();

  // The auth screens bring their own layout — a sidebar of links to places you
  // cannot go yet would be a menu of locked doors.
  if (isPublic(pathname)) return <>{children}</>;
  if (!signedIn) return <>{children}</>;

  return (
    <div className="shell">
      <aside className="sidebar">
        {/* Studio is the name of the whole dashboard, so it belongs here, at
            the top, once. The section below is Avatar — which is why the
            wordmark and the nav item no longer collide.

            The band was briefly a lone mark in an empty strip. A logo with no
            name is a shape you have to already know, and this is the first
            thing someone sees after signing in. */}
        <div className="brand">
          <Link href="/avatars" className="brand-id" aria-label="Rstudio — home">
            <span className="mark">R</span>
            <span className="brand-name">Rstudio</span>
          </Link>
          {/* The app had no route back to the public site at all: once you were
              in, the only way out was the browser's back button or editing the
              URL. */}
          <Link href="/" className="brand-out" title="Back to the site">↗</Link>
        </div>

        <nav className="nav">
          {[...NAV, ...(user?.role === 'admin' ? ADMIN_NAV : [])].map((item, i) =>
            item.section
              ? <div className="sec" key={`s${i}`}>{item.section}</div>
              : (
                <Link
                  key={item.href}
                  href={item.href}
                  // Exact match for /admin, prefix for the rest: startsWith
                  // would light up the Overview link on every admin page.
                  className={(item.href === '/admin' ? pathname === '/admin' : pathname.startsWith(item.href)) ? 'on' : ''}
                >
                  {item.label}
                </Link>
              )
          )}
        </nav>

        <UsageMeter />

        {/* `btn ghost sm` — the same button as everywhere else. It was
            `ghost tiny`, which is not a button class at all: no `.btn`, so it
            inherited the browser's default chrome and matched neither the
            sign-in buttons nor anything in the app. */}
        <div className="who">
          <div className="who-line">
            <b>{user?.name || user?.email}</b>
            {workspace?.name && <span className="helper">{workspace.name}</span>}
          </div>
          <button className="btn ghost sm" onClick={signOut}>Sign out</button>
        </div>
      </aside>

      <div>{children}</div>
    </div>
  );
}

/**
 * The three-step header.
 *
 * Rendered by each avatar screen rather than the shell, because the step you are
 * on is a property of the page. Steps behind you are `done` (violet-soft, the
 * secondary selection level); the one you are on is `on` (solid violet). Two
 * levels, per the design system — a third would start competing with semantic
 * colour.
 */
export function Steps({ current, avatarId }) {
  // A trained avatar's setup is done: the face and look steps read as complete
  // and stop being navigable, so a ready avatar's only path here is to shoot.
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let alive = true;
    get(`/avatars/${avatarId}`)
      .then((d) => {
        const a = (d && d.avatar) || d || {};
        if (alive) setReady(Boolean(a.trained || a.is_catalogue || a.status === 'active'));
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [avatarId]);

  const steps = [
    { key: 'face', n: 1, label: 'Find the face', href: `/avatars/${avatarId}/face`, setup: true },
    { key: 'look', n: 2, label: 'Set the look',  href: `/avatars/${avatarId}/look`, setup: true },
  ];
  const at = steps.findIndex((s) => s.key === current);

  return (
    <div className="steps">
      {steps.map((s, i) => {
        const onNow = i === at;
        const done = (ready && s.setup) || i < at;
        const locked = ready && s.setup && !onNow;
        const cls = `step ${onNow ? 'on' : done ? 'done' : ''}`;
        const mark = <span className="n">{done && !onNow ? '✓' : s.n}</span>;
        return locked ? (
          <span key={s.key} className={cls} style={{ cursor: 'default' }}
                aria-disabled="true" title="Done — this avatar is trained">
            {mark}{s.label}
          </span>
        ) : (
          <Link key={s.key} href={s.href} className={cls}>
            {mark}{s.label}
          </Link>
        );
      })}
    </div>
  );
}
