'use client';

import React from 'react';
import Link from 'next/link';
import '../app/zoq.css';
import '../app/landing.css';
import '../app/pricing.css';
import { useAuth } from './AuthProvider';
import { ZoqNav, ZoqFooter } from './ZoqChrome';

/**
 * /pricing — the plans + full feature comparison, in the cinematic ZoQ register.
 *
 * Numbers are the FROZEN offering spec (`claude/offering-frozen-spec.md` §9 +
 * the capability + avatar-type tables). Curated here rather than fetched, the
 * same way the other marketing pages read static content — so the page renders
 * pre-login with the full framing (Ultra live-clone hook, metered add-ons) that
 * the raw plan entitlements don't carry. Keep in sync with the `plans` rows.
 */

const FEAT = 2; // Pro is the highlighted column / card (index into the 5 plans)

function Check() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M20 6L9 17l-5-5" stroke="#B7ADFF" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const PLANS = [
  { name: 'Free', price: '₹0', per: 'one-time', tag: 'Try the studio with a shared catalogue avatar.',
    bullets: ['1 catalogue avatar', '5 videos · 10 stills (one-time)', 'Templates & viral stills', 'Publish to Instagram & YouTube'], cta: 'Start free', free: true },
  { name: 'Catalogue', price: '₹999', per: '/mo', tag: 'A shared avatar posting every week.',
    bullets: ['1 catalogue avatar', '20 videos · 30 stills / mo', 'Templates & format extraction', 'Generative reels (metered add-on)'], cta: 'Choose Catalogue' },
  { name: 'Pro', price: '₹2,000', per: '/mo', tag: 'Your own avatar — or clone yourself.', badge: 'Most popular',
    bullets: ['1 custom avatar, character or AI clone', '30 videos · 40 stills / mo', 'Cloned voice on your twin', 'Verified-consent AI clone'], cta: 'Go Pro' },
  { name: 'Max', price: '₹7,000', per: '/mo', tag: 'A roster of avatars, rendered at 720p.',
    bullets: ['5 custom avatars / clones / characters', '100 videos · 150 stills / mo', '720p generative reels', 'Everything in Pro'], cta: 'Choose Max' },
  { name: 'Ultra', price: '₹15,000', per: '/mo', tag: 'The agency tier — with a live, talking clone.', badge: 'Live clone',
    bullets: ['12 avatars · 250 videos · 350 stills', '60 min/mo live interactive clone', 'Team seats, sub-accounts, API', 'Priority rendering'], cta: 'Choose Ultra' },
];

const GROUPS = [
  { title: 'Plans & billing', rows: [
    { label: 'Price', vals: ['₹0 · one-time', '₹999 / mo', '₹2,000 / mo', '₹7,000 / mo', '₹15,000 / mo'] },
    { label: 'Best for', vals: ['Trying it out', 'A shared avatar', 'Your own avatar or clone', 'A roster of avatars', 'Agencies + live clone'] },
  ] },
  { title: 'Avatars & voice', rows: [
    { label: 'Avatars included', vals: ['1', '1', '1', '5', '12'] },
    { label: 'Catalogue avatars (shared)', vals: [true, true, true, true, true] },
    { label: 'Custom avatar (your own)', vals: [false, false, true, true, true] },
    { label: 'Custom character / mascot', vals: [false, false, true, true, true] },
    { label: 'AI clone — digital twin (verified consent)', vals: [false, false, true, true, true] },
    { label: 'Voice', vals: ['Library TTS', 'Library TTS', '+ Cloned', '+ Cloned', '+ Cloned'] },
  ] },
  { title: 'What you can make', rows: [
    { label: 'Budget lipsync videos / period', vals: ['5', '20', '30', '100', '250'] },
    { label: 'Stills & photos / period', vals: ['10', '30', '40', '150', '350'] },
    { label: 'Templates — ad & viral video, viral stills', vals: [true, true, true, true, true] },
    { label: 'Format extraction from a reel', vals: [true, true, true, true, true] },
    { label: 'Generative reel resolution', vals: ['480p', '480p', '480p', '720p', '720p'] },
  ] },
  { title: 'Publish & deliver', rows: [
    { label: 'Publish to Instagram & YouTube (your accounts)', vals: [true, true, true, true, true] },
    { label: 'WhatsApp delivery of finished reels', vals: [true, true, true, true, true] },
    { label: 'AI-labelled outputs · data hosted in India', vals: [true, true, true, true, true] },
  ] },
  { title: 'Live clone (real-time) — Ultra', rows: [
    { label: 'Interactive live-clone minutes / mo', vals: ['—', '—', '—', '—', '60'] },
    { label: 'Live on web, WhatsApp & Instagram DM', vals: [false, false, false, false, true] },
  ] },
  { title: 'Agency & team — Ultra', rows: [
    { label: 'Team seats & client sub-accounts', vals: [false, false, false, false, true] },
    { label: 'API access', vals: [false, false, false, false, true] },
    { label: 'Priority rendering', vals: [false, false, false, false, true] },
  ] },
];

function Cell({ v }) {
  if (v === true) return <span className="zp-yes"><Check /></span>;
  if (v === false) return <span className="zp-no">—</span>;
  return <span>{v}</span>;
}

export default function PricingLanding() {
  const { signedIn } = useAuth();
  const paidGo = signedIn ? '/billing' : '/signup';

  return (
    <div className="z">
      <div className="z-glow tr" />
      <div className="z-wrap">
        <ZoqNav active="pricing" />

        <section className="z-hero zp-hero">
          <span className="z-kick"><span className="dot" />PRICING</span>
          <h1 className="z-h1">Simple plans.<br /><span className="a">The whole studio.</span></h1>
          <p className="z-deck" style={{ textAlign: 'center' }}>
            One pipeline, one credit wallet, one price list — for <b>AI personas</b> and <b>brand mascots</b> alike.
            Start free on a shared avatar; go Pro to build or clone your own; scale to a roster, or a live, talking clone on Ultra.
          </p>
          <span className="zp-billnote">Monthly billing · prices in INR · GST as applicable · Free is a one-time grant</span>
        </section>

        <section className="zp-cards-sec">
          <div className="zp-cards">
            {PLANS.map((p, i) => (
              <div key={p.name} className={`zp-card${i === FEAT ? ' feat' : ''}`}>
                {p.badge && <span className="zp-badge">{p.badge}</span>}
                <div className="zp-pname">{p.name}</div>
                <div className="zp-price"><b>{p.price}</b><span>{p.per}</span></div>
                <div className="zp-tag">{p.tag}</div>
                <ul className="zp-bul">
                  {p.bullets.map((b) => (<li key={b}><Check />{b}</li>))}
                </ul>
                <Link className={`z-btn${i === FEAT ? '' : ' ghost'}`} href={p.free ? '/signup' : paidGo}>{p.cta}</Link>
              </div>
            ))}
          </div>
        </section>

        <section className="z-sec zp-compare">
          <p className="z-eyebrow">EVERY FEATURE, EVERY PLAN</p>
          <h2 className="z-h2">Compare <span className="a">the plans</span>.</h2>
          <div className="zp-tablewrap">
            <table className="zp-table">
              <thead>
                <tr>
                  <th className="rowlab">Feature</th>
                  {PLANS.map((p, i) => (
                    <th key={p.name} className={i === FEAT ? 'feat' : ''}>{p.name}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {GROUPS.map((g) => (
                  <React.Fragment key={g.title}>
                    <tr className="zp-grouprow"><td colSpan={6}>{g.title}</td></tr>
                    {g.rows.map((r) => (
                      <tr key={r.label}>
                        <td className="rowlab">{r.label}</td>
                        {r.vals.map((v, i) => (
                          <td key={i} className={i === FEAT ? 'zp-col-feat' : ''}><Cell v={v} /></td>
                        ))}
                      </tr>
                    ))}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="z-sec zp-addons">
          <p className="z-eyebrow">METERED ADD-ONS</p>
          <h2 className="z-h2">Pay only for <span className="a">the extras</span>.</h2>
          <p className="z-lead" style={{ maxWidth: 640 }}>
            Your plan bundles budget lipsync videos and stills. Heavier outputs are metered in credits or top-ups —
            never bundled, so they never change your base price.
          </p>
          <div className="zp-addgrid">
            <div className="zp-add"><h3>Generative reels</h3><p>Seedance video reels beyond lipsync — 480p or 720p, priced per clip in credits.</p></div>
            <div className="zp-add"><h3>Premium & max lipsync</h3><p>Sharper lipsync engines (Sync v2, VEED) as a per-second add-on when you want the best mouth sync.</p></div>
            <div className="zp-add"><h3>Extra live-clone minutes</h3><p>More real-time minutes beyond Ultra's bundled 60/mo, metered per minute.</p></div>
            <div className="zp-add"><h3>Top-ups & extra avatars</h3><p>Buy more credits any time, or add avatars beyond your plan's allowance.</p></div>
          </div>
          <p className="zp-foot-notes">
            Every output is labelled AI-generated · AI clones require verified consent · Voice cloning is clone-only · Data hosted in India · Prices exclude GST · Third-party costs (WhatsApp, live-clone streaming) are passed through at cost.
          </p>
        </section>

        <section className="z-close">
          <div>
            <h2 className="z-h2">Start free. <span className="a">Scale when you're ready.</span></h2>
            <p className="z-lead">Spin up a catalogue avatar for nothing, then upgrade to build your own, clone yourself, or run a roster — same studio, same one-brief pipeline.</p>
            <div className="z-cta" style={{ marginTop: 24 }}>
              <Link className="z-btn" href="/signup">Start free
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none"><path d="M5 12h14M13 6l6 6-6 6" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
              </Link>
              <Link className="z-btn ghost" href="/persona">See how it works</Link>
            </div>
          </div>
          <p className="z-note" style={{ fontSize: 12, lineHeight: 1.7 }}>No card for Free · Cancel anytime · Every persona disclosed as AI-generated</p>
        </section>

        <ZoqFooter />
      </div>
    </div>
  );
}
