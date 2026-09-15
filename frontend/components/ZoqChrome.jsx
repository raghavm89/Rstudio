'use client';

import Link from 'next/link';
import { useAuth } from './AuthProvider';

/* Shared ZoQ marketing chrome: wordmark mark, top nav, crop marks, footer.
   Kept in one place so the three cinematic pages (/, /persona, /mascot) never
   drift apart. */

export function ZoqMark({ size = 28 }) {
  const inner = Math.round(size * 0.55);
  return (
    <div className="z-mark" style={{ width: size, height: size }}>
      <svg width={inner} height={inner} viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M17 8.6c0-3-2.5-5.1-5.6-5.1C7.9 3.5 6 6 6 9.3c0 3.6 2.5 6.1 6.1 6.1 2.7 0 4.5-1.8 4.5-4.1 0-2-1.4-3.4-3.3-3.4-1.5 0-2.6 1-2.6 2.4"
          stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

export function ZoqWord() {
  return <span className="z-word">Zo<i>Q</i></span>;
}

export function ZoqNav({ active = '' }) {
  const { signedIn } = useAuth();
  return (
    <nav className="z-nav">
      <Link href="/" className="z-brand" style={{ color: 'inherit' }}>
        <ZoqMark />
        <ZoqWord />
      </Link>
      <div className="z-navlinks">
        <Link href="/persona" className={active === 'persona' ? 'on' : ''}>Persona</Link>
        <Link href="/clone" className={active === 'clone' ? 'on' : ''}>Clone</Link>
        <Link href="/mascot" className={active === 'mascot' ? 'on' : ''}>Mascot</Link>
        <Link href="/#pricing" className="hidesm">Pricing</Link>
        {signedIn
          ? <Link className="z-signin" href="/avatars">Open Studio</Link>
          : <Link className="z-signin" href="/login">Sign in</Link>}
      </div>
    </nav>
  );
}

/* Violet film crop-marks that sit over a media plate. */
export function CropMarks() {
  return (
    <svg className="crop" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      <g stroke="#5B3DF5" strokeWidth="1.2" fill="none">
        <path d="M4 9V4h5M91 4h5v5M96 91v5h-5M9 96H4v-5" />
      </g>
    </svg>
  );
}

export function ZoqFooter() {
  return (
    <footer className="z-foot">
      <span className="disclose">Every persona is disclosed as AI-generated, in the bio and on every post.</span>
      <span><a href="mailto:hello@zoq.app">hello@zoq.app</a> · © 2026 ZoQ</span>
    </footer>
  );
}
