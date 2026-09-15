'use client';

import Link from 'next/link';
import '../app/zoq.css';
import { useAuth } from './AuthProvider';
import { ZoqNav, ZoqFooter, CropMarks } from './ZoqChrome';

const USECASES = [
  { key: 'skating', tag: 'LIFESTYLE', cxt: 'Sport & street' },
  { key: 'eating', tag: 'FOOD & F&B', cxt: 'Snacks & cafes' },
  { key: 'fighting', tag: 'GAMING', cxt: 'Apps & esports' },
  { key: 'flying', tag: 'LAUNCH', cxt: 'Product drops' },
  { key: 'hero', tag: 'CAMPAIGN', cxt: 'Brand hero' },
];

/** /mascot — the AI-character (non-human) lane hero + use-case wall. */
export default function MascotLanding() {
  const { signedIn } = useAuth();
  const go = signedIn ? '/avatars' : '/signup';
  return (
    <div className="z">
      <div className="z-glow tr" />
      <div className="z-wrap">
        <ZoqNav active="mascot" />

        <section className="z-hero">
          <div className="z-hero-copy">
            <span className="z-kick"><span className="dot" />LANE 02 · AI CHARACTER</span>
            <h1 className="z-h1">Give your brand<br /><span className="a">a mascot that posts.</span></h1>
            <p className="z-deck">
              A non-human character — a creature, a toon, a shape with a personality. It
              depicts nobody, so there's <b>no consent to chase and no likeness to worry about</b>.
              Just a face your brand owns outright.
            </p>
            <div className="z-chips">
              <span>Depicts nobody</span><span>You own the IP</span><span>On-model, every post</span>
            </div>
            <div className="z-cta">
              <Link className="z-btn" href={go}>Make a mascot
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none"><path d="M5 12h14M13 6l6 6-6 6" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
              </Link>
              <Link className="z-btn ghost" href="/persona">Or a human persona</Link>
            </div>
          </div>

          <div className="z-plate">
            <video src="/hero/mascot/creator.mp4" poster="/hero/mascot/creator.jpg" autoPlay muted loop playsInline />
            <div className="scrim" />
            <CropMarks />
            <div className="slate"><span>CHARACTER · REEL</span><span className="v">ZoQ · SQUIRREL</span></div>
          </div>
        </section>

        <section className="z-usecases">
          <div className="z-uc-head"><span>ONE CHARACTER · EVERY CONTEXT</span><span>ZoQ MASCOT LINE</span></div>
          <div className="z-uc-grid">
            {USECASES.map((u) => (
              <figure className="z-uc" key={u.key} style={{ margin: 0 }}>
                <video src={`/hero/mascot/${u.key}.mp4`} poster={`/hero/mascot/${u.key}.jpg`} autoPlay muted loop playsInline />
                <figcaption className="cap"><span className="tag">{u.tag}</span><span className="cxt">{u.cxt}</span></figcaption>
              </figure>
            ))}
          </div>
        </section>

        <section className="z-close">
          <div>
            <h2 className="z-h2">A mascot, <span className="a">every mood</span>.</h2>
            <p className="z-lead">One character, on-model across reels, ads and stories — the same face your audience learns to recognise, without a photoshoot or a real spokesperson.</p>
            <div className="z-cta" style={{ marginTop: 24 }}>
              <Link className="z-btn" href={go}>Make a mascot
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none"><path d="M5 12h14M13 6l6 6-6 6" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
              </Link>
            </div>
          </div>
          <p className="z-note" style={{ fontSize: 12, lineHeight: 1.7 }}>For D2C brands · apps & startups · shops & cafes · anyone who won't be on camera</p>
        </section>

        <ZoqFooter />
      </div>
    </div>
  );
}
