'use client';

import Link from 'next/link';
import '../app/zoq.css';
import '../app/landing.css';
import { useAuth } from './AuthProvider';
import Plate from './Plate';
import { ZoqNav, ZoqFooter } from './ZoqChrome';

/** /clone — the AI-clone (your likeness) lane hero. Posts as you today (Pro+
 *  twin, verified consent); talks back live on Ultra (interactive, rolling out). */
export default function CloneLanding({ assets = null }) {
  const { signedIn } = useAuth();
  const go = signedIn ? '/avatars' : '/signup';
  return (
    <div className="z">
      <div className="z-glow tr" />
      <div className="z-wrap">
        <ZoqNav active="clone" />

        <section className="z-hero">
          <div className="z-hero-copy">
            <span className="z-kick"><span className="dot" />LANE 03 · AI CLONE</span>
            <h1 className="z-h1">Clone yourself.<br /><span className="a">It posts. It talks back.</span></h1>
            <p className="z-deck">
              Train ZoQ on a consented video of you. Your twin posts your reels while you
              don't — and on Ultra it comes alive: a <b>real-time avatar that listens and
              talks back</b> over the web, WhatsApp and Instagram DM.
            </p>
            <div className="z-chips">
              <span>Verified consent</span><span>Your exact likeness</span>
              <span>Live &amp; interactive · Ultra · early access</span>
            </div>
            <div className="z-cta">
              <Link className="z-btn" href={go}>Clone yourself
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none"><path d="M5 12h14M13 6l6 6-6 6" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
              </Link>
              <Link className="z-btn ghost" href="/persona">Or an invented face</Link>
            </div>
          </div>
          <Plate assets={assets} label="Your twin · consented, identity-locked" />
        </section>

        <section className="z-sec">
          <p className="z-eyebrow">HOW THE CLONE WORKS</p>
          <h2 className="z-h2">Your face, <span className="a">two ways</span>.</h2>
          <div className="z-steps">
            <div className="z-step"><span className="n">01</span><h3>Consent, then train</h3><p>Record a short consented video. ZoQ verifies consent, then trains a twin that is unmistakably you — no one else can make it.</p><span className="meta">Verified · Pro+</span></div>
            <div className="z-step"><span className="n">02</span><h3>It posts as you</h3><p>The twin shoots reels and photos in your likeness and your voice, on the same one-brief pipeline as every ZoQ avatar.</p><span className="meta">Shipping</span></div>
            <div className="z-step"><span className="n">03</span><h3>It goes live</h3><p>On Ultra, the clone becomes interactive — it listens and answers in real time on a call, in WhatsApp, in your DMs. Hosted in India.</p><span className="meta">Ultra · early access</span></div>
          </div>
        </section>

        <section className="z-close">
          <div>
            <h2 className="z-h2">Be in two places <span className="a">at once</span>.</h2>
            <p className="z-lead">Clone yourself once. Let your likeness post, reply and show up — while you get your time back. Nothing goes live without your verified consent, and every output is labelled AI-generated.</p>
            <div className="z-cta" style={{ marginTop: 24 }}>
              <Link className="z-btn" href={go}>Clone yourself
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none"><path d="M5 12h14M13 6l6 6-6 6" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
              </Link>
            </div>
          </div>
          <p className="z-note" style={{ fontSize: 12, lineHeight: 1.7 }}>Clone avatars require verified consent · Live interactive avatars are in early access on Ultra · Data hosted in India</p>
        </section>

        <ZoqFooter />
      </div>
    </div>
  );
}
