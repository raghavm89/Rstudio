'use client';

import Link from 'next/link';
import '../app/zoq.css';
import '../app/landing.css';
import '../app/legal.css';
import { ZoqNav, ZoqFooter } from './ZoqChrome';

/** /about — who ZoQ is, the team, and how to reach us. Cinematic z- register. */

const TEAM = [
  { name: 'Gaurav Mahajan', role: 'CEO', initials: 'GM' },
  { name: 'Madhav Mahajan', role: 'CMO', initials: 'MM' },
  { name: 'Raghav Mahajan', role: 'CTO', initials: 'RM' },
];

export default function About() {
  return (
    <div className="z">
      <div className="z-glow tr" />
      <div className="z-wrap">
        <ZoqNav />

        <section className="z-hero zl-hero">
          <span className="z-kick"><span className="dot" />ABOUT ZoQ</span>
          <h1 className="z-h1">AI creators,<br /><span className="a">made for India.</span></h1>
          <p className="z-deck" style={{ textAlign: 'center' }}>
            ZoQ is a studio for building an AI creator &mdash; an invented persona, a brand mascot, or a clone of
            yourself &mdash; that makes photos and reels for Indian audiences. Describe an idea; get a finished reel.
          </p>
        </section>

        <section className="z-sec zl-body">
          <h2>What we&rsquo;re building</h2>
          <p>
            Great content is slow and expensive to make consistently. ZoQ turns one brief into a finished, on-brand
            reel &mdash; the same face every shot, a planner that learns your taste, and two quick approvals so you
            stay in control. One pipeline serves both an <b>AI persona</b> and a <b>brand mascot</b>, so a creator and
            a business can use the same studio.
          </p>
          <p>
            We build <b>India-first</b>: we keep data in India, price in rupees, and we&rsquo;re honest about what&rsquo;s
            AI. Every ZoQ avatar is disclosed as AI-generated, and a clone of a real person is only ever made with
            that person&rsquo;s verified consent.
          </p>

          <h2>The team</h2>
          <div className="za-team">
            {TEAM.map((m) => (
              <div className="za-member" key={m.name}>
                <div className="za-ava" aria-hidden="true">{m.initials}</div>
                <div className="za-name">{m.name}</div>
                <div className="za-role">{m.role}</div>
              </div>
            ))}
          </div>

          <h2>Get in touch</h2>
          <p>
            Questions, partnerships, press, or you just want to build a persona with us &mdash; we&rsquo;d love to hear
            from you.
          </p>
          <div className="za-contact">
            <a className="za-cbtn" href="mailto:hello@zoq.app">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M4 6h16v12H4z M4 7l8 6 8-6" stroke="#B7ADFF" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
              hello@zoq.app
            </a>
            <a className="za-cbtn" href="tel:+919888601438">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M5 4h3l2 5-2 1a12 12 0 006 6l1-2 5 2v3a2 2 0 01-2 2A16 16 0 013 6a2 2 0 012-2z" stroke="#B7ADFF" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
              +91 98886 01438
            </a>
            <Link className="za-cbtn" href="/faq">Read the FAQ</Link>
            <Link className="za-cbtn" href="/pricing">See pricing</Link>
          </div>
        </section>

        <section className="z-close">
          <div>
            <h2 className="z-h2">Build your first <span className="a">AI creator</span>.</h2>
            <p className="z-lead">Start free on a shared avatar, then make it your own. Nothing publishes without you, and every output is labelled AI-generated.</p>
            <div className="z-cta" style={{ marginTop: 24 }}>
              <Link className="z-btn" href="/signup">Start free
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none"><path d="M5 12h14M13 6l6 6-6 6" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
              </Link>
            </div>
          </div>
          <p className="z-note" style={{ fontSize: 12, lineHeight: 1.7 }}>Made in India · Data hosted in India · Every persona disclosed as AI-generated</p>
        </section>

        <ZoqFooter />
      </div>
    </div>
  );
}
