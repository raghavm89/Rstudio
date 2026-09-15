'use client';

import Link from 'next/link';
import '../app/zoq.css';
import '../app/landing.css';
import { useAuth } from './AuthProvider';
import Plate from './Plate';
import { ZoqNav, ZoqFooter } from './ZoqChrome';

/**
 * zoq.app — the front door (cinematic register).
 *
 * DARK and video-forward: a light SaaS page can't carry the promise of a
 * cinematic avatar. This is deliberately NOT the app's bright Direction-C look —
 * it shares only the brand tokens (flat violet, Figtree + Plex Mono, rounded,
 * film grain). The hero plays a real generated Aanya clip via <Plate>; the two
 * lanes hand off to /persona and /mascot.
 *
 * Two finished states, as before: with `assets` (from public/hero/manifest.json,
 * written by studio/hero-assets.js) the plate plays real footage; without, it
 * draws its lit empty frame. Neither is broken.
 */
export default function Landing({ assets = null }) {
  const { signedIn } = useAuth();
  const go = signedIn ? '/avatars' : '/signup';

  return (
    <div className="z">
      <div className="z-glow tr" />
      <div className="z-wrap">
        <ZoqNav active="" />

        {/* ── hero ─────────────────────────────────────── */}
        <section className="z-hero">
          <div className="z-hero-copy">
            <span className="z-kick"><span className="dot" />AI CREATORS · MADE FOR INDIA</span>
            <h1 className="z-h1">Your AI creator.<br /><span className="a">Posting for you.</span></h1>
            <p className="z-deck">
              Describe an idea — get a finished reel or photo of your avatar, in trending
              Hinglish, festival and lifestyle formats. <b>The same face, every single shot.</b>
            </p>
            <div className="z-cta">
              <Link className="z-btn" href={go}>Create your avatar
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none"><path d="M5 12h14M13 6l6 6-6 6" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
              </Link>
              <a className="z-btn ghost" href="#how">See it work</a>
            </div>
            <div className="z-chips">
              <span>Same face, every shot</span><span>Reels + photos</span><span>Auto-post to IG &amp; YouTube</span>
            </div>
          </div>
          <Plate assets={assets} label="Aanya Kapoor, generated — one take" />
        </section>

        {/* ── one machine, two creators ────────────────── */}
        <section className="z-lanes">
          <div className="z-lanes-label mono">ONE MACHINE,<br />TWO CREATORS →</div>
          <Link className="z-lane" href="/persona">
            <span className="thumb"><img src="/hero/setup-close.jpg" alt="" /></span>
            <span><span className="t">AI persona</span><br /><span className="s">A creator or influencer</span></span>
            <span className="arr">→</span>
          </Link>
          <Link className="z-lane" href="/mascot">
            <span className="thumb"><video src="/hero/mascot/hero.mp4" poster="/hero/mascot/hero.jpg" autoPlay muted loop playsInline /></span>
            <span><span className="t">AI mascot</span><br /><span className="s">A brand character</span></span>
            <span className="arr">→</span>
          </Link>
        </section>

        {/* ── feature ──────────────────────────────────── */}
        <section className="z-sec" id="how">
          <p className="z-eyebrow">WHY IT HOLDS UP</p>
          <h2 className="z-h2">The hard part was never<br />making <span className="a">an</span> image.</h2>
          <p className="z-lead">
            It was making the four-hundredth image look like the first. ZoQ measures every
            face against a calibrated likeness before you ever see a frame, so a feed reads
            as one person who shot it — not a folder of strangers who nearly match.
          </p>
          <div className="z-steps">
            <div className="z-step"><span className="n">01</span><h3>Find the face</h3><p>Pick from a catalogue, or build one from a seed set of your own. ZoQ trains a model that belongs to you and keeps the file.</p><span className="meta">~20 minutes, once</span></div>
            <div className="z-step"><span className="n">02</span><h3>Set the look</h3><p>Camera, lens, colour, grain, skin — chosen from a vocabulary, not typed into a box, then locked into every shot.</p><span className="meta">Chosen once, then locked</span></div>
            <div className="z-step"><span className="n">03</span><h3>Shoot</h3><p>One brief becomes a week: stills, reels, captions, a schedule. Every frame checked against their likeness first.</p><span className="meta">One idea, a finished reel</span></div>
          </div>
        </section>

        {/* ── pricing ──────────────────────────────────── */}
        <section className="z-sec" id="pricing">
          <p className="z-eyebrow">PRICING</p>
          <h2 className="z-h2">A monthly wallet you spend<br />however you like.</h2>
          <div className="z-prices">
            <div className="z-price"><div className="amt">Free</div><div className="plan">STARTER</div><div className="desc">40 credits / mo · ≈ 5 videos + 10 photos</div></div>
            <div className="z-price"><div className="amt">₹999</div><div className="plan">CATALOGUE</div><div className="desc">150 credits · ≈ 20 videos + 30 photos</div></div>
            <div className="z-price hot"><div className="amt">₹2,000</div><div className="plan">PRO</div><div className="desc">220 credits · ≈ 30 videos + 40 photos</div></div>
            <div className="z-price"><div className="amt">₹7,000</div><div className="plan">MAX</div><div className="desc">750 credits · ≈ 100 videos + 150 photos</div></div>
            <div className="z-price"><div className="amt">₹15,000</div><div className="plan">ULTRA</div><div className="desc">1,850 credits · ≈ 250 videos + 350 photos + live AI clone</div></div>
          </div>
          <p className="z-price-note">One credit is one photo; a video is about six. Each plan is a monthly credit wallet — trade photos for videos as you please. Top up any time at ₹500 for 77 credits.</p>
        </section>

        {/* ── close ────────────────────────────────────── */}
        <section className="z-close">
          <div>
            <h2 className="z-h2">Start with a <span className="a">free</span> shoot.</h2>
            <p className="z-lead">Build a persona, take a set of stills and one reel, and see whether the face holds. No card, and nothing reaches Instagram until you press publish.</p>
            <div className="z-cta" style={{ marginTop: 24 }}>
              <Link className="z-btn" href={go}>{signedIn ? 'Open Studio' : 'Create your account'}
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none"><path d="M5 12h14M13 6l6 6-6 6" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
              </Link>
            </div>
          </div>
          <p className="z-note" style={{ fontSize: 12, lineHeight: 1.7 }}>Free tier · No card · Nothing publishes without you · Every output labelled AI-generated</p>
        </section>

        <ZoqFooter />
      </div>
    </div>
  );
}
