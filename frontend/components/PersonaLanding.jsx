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
              A human-looking avatar — invent a new face, or clone your own. She keeps the
              same look across every reel and photo, so the feed feels like <b>one real person</b>.
            </p>
            <div className="z-proofbar">
              <span className="lab">LOOKS LIKE HER</span>
              <span className="track"><i /></span>
              <span className="val">0.91</span>
            </div>
            <div className="z-chips">
              <span>Synthetic or your clone</span><span>Talks &amp; performs</span><span>QC on every frame</span>
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
