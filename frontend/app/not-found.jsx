'use client';

import Link from 'next/link';
import './zoq.css';

/**
 * 404 — cinematic, in the ZoQ register. Rendered by Next for any unmatched
 * route. It's a fixed full-screen panel so it reads clean whether it lands over
 * the marketing site or (for a signed-in user) the app shell.
 */
export default function NotFound() {
  return (
    <div className="z" style={{ position: 'fixed', inset: 0, zIndex: 60, overflow: 'auto' }}>
      <div className="z-glow tr" />
      <div
        className="z-wrap"
        style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', gap: 18, padding: '48px 24px' }}
      >
        <span className="z-kick"><span className="dot" />404 · NOT FOUND</span>
        <h1 className="z-h1" style={{ textAlign: 'center' }}>This shot didn&rsquo;t<br /><span className="a">make the cut.</span></h1>
        <p className="z-deck" style={{ textAlign: 'center' }}>
          The page you&rsquo;re looking for isn&rsquo;t here. Let&rsquo;s get you back on set.
        </p>
        <div className="z-cta" style={{ justifyContent: 'center' }}>
          <Link className="z-btn" href="/">Back home
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none"><path d="M5 12h14M13 6l6 6-6 6" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </Link>
          <Link className="z-btn ghost" href="/pricing">See pricing</Link>
        </div>
      </div>
    </div>
  );
}
