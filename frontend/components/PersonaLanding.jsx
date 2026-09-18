'use client';

import Link from 'next/link';
import '../app/zoq.css';
import '../app/landing.css';
import { useAuth } from './AuthProvider';
import Plate from './Plate';
import { ZoqNav, ZoqFooter } from './ZoqChrome';

/** /persona — the AI-creator (human-likeness) lane hero. */
export default function PersonaLanding({ assets = null }) {
  const { signedIn } = useAuth();
  const go = signedIn ? '/avatars' : '/signup';
  return (
    <div className="z">
      <div className="z-glow tl" />
      <div className="z-wrap">
        <ZoqNav active="persona" />

        <section className="z-hero rev">
          <Plate assets={assets} label="Aanya Kapoor · identity-locked" />
          <div className="z-hero-copy">
            <span className="z-kick"><span className="dot" />LANE 01 · AI PERSONA</span>
            <h1 className="z-h1">Create your<br /><span className="a">AI creator.</span></h1>
            <p className="z-deck">
              A human-looking avatar — a brand-new face invented for you. She keeps the
              same look across every reel and photo, so the feed feels like <b>one real person</b>.
            </p>
            <div className="z-proofbar">
              <span className="lab">LOOKS LIKE HER</span>
              <span className="track"><i /></span>
              <span className="val">0.91</span>
            </div>
            <div className="z-chips">
              <span>A new, invented face</span><span>Talks &amp; performs</span><span>QC on every frame</span>
            </div>
            <div className="z-cta">
              <Link className="z-btn" href={go}>Build your persona
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none"><path d="M5 12h14M13 6l6 6-6 6" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
              </Link>
              <Link className="z-btn ghost" href="/mascot">Or a brand mascot</Link>
            </div>
          </div>
        </section>

        <section className="z-sec">
          <p className="z-eyebrow">WHO IT'S FOR</p>
          <h2 className="z-h2">A face that posts,<br />without you on camera.</h2>
          <div className="z-steps">
            <div className="z-step"><span className="n">·</span><h3>Influencers &amp; creators</h3><p>A consistent on-brand face for a niche you post to daily — beauty, fashion, lifestyle, food.</p></div>
            <div className="z-step"><span className="n">·</span><h3>Founders &amp; faceless brands</h3><p>Show up on camera without showing up — a spokesperson who never reschedules a shoot.</p></div>
            <div className="z-step"><span className="n">·</span><h3>Your own clone</h3><p>Train ZoQ on a consented video of yourself and let your likeness post while you don't.</p></div>
          </div>
        </section>

        <section className="z-sec">
          <p className="z-eyebrow">THE CATALOGUE</p>
          <h2 className="z-h2">Ready-made personas,<br />or build your own.</h2>
          <p className="z-lead" style={{ maxWidth: 620 }}>Pick a fully-built face from the catalogue and start posting today — or invent your own. Every one is identity-locked and QC&rsquo;d on every frame.</p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 18, marginTop: 24 }}>
            {[
              { img: '/hero/rohan-mehra/cover.jpg', name: 'Rohan Mehra', tag: '28 · café owner, Mumbai' },
              { img: '/hero/poster.jpg', name: 'Aanya Kapoor', tag: '26 · product designer, Mumbai' },
            ].map((persona) => (
              <figure key={persona.name} style={{ margin: 0, borderRadius: 14, overflow: 'hidden', background: '#161616', border: '1px solid rgba(255,255,255,.08)' }}>
                <img src={persona.img} alt={persona.name} style={{ width: '100%', aspectRatio: '4 / 5', objectFit: 'cover', display: 'block' }} />
                <figcaption style={{ padding: '12px 14px' }}>
                  <b style={{ display: 'block', fontSize: 15 }}>{persona.name}</b>
                  <span style={{ fontSize: 12.5, opacity: 0.6 }}>{persona.tag}</span>
                </figcaption>
              </figure>
            ))}
          </div>
        </section>

        <section className="z-close">
          <div>
            <h2 className="z-h2">Your persona, in <span className="a">one shoot</span>.</h2>
            <p className="z-lead">Free to start. Build a face, generate a set of stills and a reel, and see whether the likeness holds before you spend a rupee.</p>
            <div className="z-cta" style={{ marginTop: 24 }}>
              <Link className="z-btn" href={go}>Build your persona
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none"><path d="M5 12h14M13 6l6 6-6 6" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
              </Link>
            </div>
          </div>
          <p className="z-note" style={{ fontSize: 12, lineHeight: 1.7 }}>Clone avatars require verified consent · Every output labelled AI-generated</p>
        </section>

        <ZoqFooter />
      </div>
    </div>
  );
}
