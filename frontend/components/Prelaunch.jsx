'use client';

import { useState } from 'react';
import '../app/zoq.css';
import '../app/landing.css';
import '../app/prelaunch.css';
import Plate from './Plate';
import SocialEmbed from './SocialEmbed';
import { ZoqMark, ZoqWord, CropMarks } from './ZoqChrome';
import { SITE, CATALOGUE, OFFERINGS, PLANS } from '../content/prelaunch';

/**
 * zoqstudio.ai — the pre-launch page. One route, one scroll.
 *
 * Same cinematic register as the marketing pages (dark stage, flat violet, film
 * grain, the Plate) so the site that launches in November looks like the one
 * people followed in October. Nothing here links into the app: the
 * `pre_launch_page` branch redirects every other route back here
 * (`middleware.js`), so this page has to stand on its own.
 *
 * Content comes from `content/prelaunch.js` — paste a post link there, push,
 * done. `assets` is the hero manifest (same as the landing); `posts` arrives
 * already parsed by the server so a bad link is dropped at build, never shown.
 */

const Arrow = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const IgIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <rect x="3" y="3" width="18" height="18" rx="5" stroke="currentColor" strokeWidth="1.8" />
    <circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="1.8" />
    <circle cx="17.3" cy="6.7" r="1.1" fill="currentColor" />
  </svg>
);

const YtIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <rect x="2.5" y="5" width="19" height="14" rx="4" stroke="currentColor" strokeWidth="1.8" />
    <path d="M10 9l5 3-5 3z" fill="currentColor" />
  </svg>
);

const STATUS = {
  live:     { label: 'In the catalogue', cls: 'is-live' },
  training: { label: 'In training',      cls: 'is-training' },
  soon:     { label: 'Coming soon',      cls: 'is-soon' },
};

function Monogram({ name }) {
  const initials = name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('');
  return <div className="pl-mono"><span>{initials}</span></div>;
}

function FaceCard({ face }) {
  const st = STATUS[face.status] || STATUS.soon;
  return (
    <article className={`pl-face ${st.cls}`}>
      <div className="pl-face-media">
        {face.media
          ? (face.video
              ? <video src={face.video} poster={face.media} autoPlay muted loop playsInline preload="none" />
              : <img src={face.media} alt="" />)
          : <Monogram name={face.name} />}
        <CropMarks />
        <span className={`pl-tag ${st.cls}`}>{st.label}</span>
      </div>
      <div className="pl-face-copy">
        <div className="pl-face-head">
          <h3>{face.name}</h3>
          <span className="mono">{face.place}</span>
        </div>
        <p>{face.line}</p>
      </div>
    </article>
  );
}

function QueueCard({ face }) {
  const st = STATUS[face.status] || STATUS.soon;
  return (
    <article className={`pl-queue-card ${st.cls}`}>
      <Monogram name={face.name} />
      <div className="pl-queue-copy">
        <div className="pl-face-head">
          <h3>{face.name}</h3>
          <span className="mono">{face.place}</span>
        </div>
        <p>{face.line}</p>
        <span className={`pl-tag ${st.cls}`}>{st.label}</span>
      </div>
    </article>
  );
}

function Waitlist({ compact = false }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('creator');
  const [state, setState] = useState('idle'); // idle | busy | done | error
  const [msg, setMsg] = useState('');

  async function submit(e) {
    e.preventDefault();
    if (state === 'busy') return;
    setState('busy');
    try {
      const r = await fetch('/api/waitlist', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, role, website: e.currentTarget?.website?.value ?? '' }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || 'Could not save that just now.');
      setState('done');
      setMsg(j.message || "You're on the list.");
    } catch (err) {
      setState('error');
      setMsg(err.message || 'Could not save that just now.');
    }
  }

  if (state === 'done') {
    return (
      <div className="pl-form done" role="status">
        <span className="pl-tick">✓</span>
        <div><b>{msg}</b><br /><span>One email at launch, early access for the first fifty. Nothing else.</span></div>
      </div>
    );
  }

  return (
    <form className={`pl-form${compact ? ' compact' : ''}`} onSubmit={submit} noValidate>
      {/* honeypot — real people never see or fill this */}
      <input type="text" name="website" tabIndex={-1} autoComplete="off" className="pl-hp" aria-hidden="true" />
      <div className="pl-fields">
        <input
          type="email" name="email" required inputMode="email" autoComplete="email"
          placeholder="you@example.in" value={email} onChange={(e) => setEmail(e.target.value)}
          aria-label="Email address"
        />
        {!compact && (
          <select name="role" value={role} onChange={(e) => setRole(e.target.value)} aria-label="I am a">
            <option value="creator">I run a page / I'm a creator</option>
            <option value="brand">I run a brand or a local business</option>
            <option value="agency">I run an agency</option>
            <option value="curious">Just curious</option>
          </select>
        )}
        <button className="z-btn" type="submit" disabled={state === 'busy'}>
          {state === 'busy' ? 'Saving…' : 'Get launch access'}<Arrow />
        </button>
      </div>
      {state === 'error' && <p className="pl-err" role="alert">{msg} You can also write to <a href={`mailto:${SITE.email}`}>{SITE.email}</a>.</p>}
    </form>
  );
}

export default function Prelaunch({ assets = null, posts = [] }) {
  const hasSocial = Boolean(SITE.instagram || SITE.youtube);
  const liveFaces = CATALOGUE.filter((f) => f.status === 'live').length;

  return (
    <div className="z pl">
      <div className="z-glow tr" />
      <div className="z-wrap">

        {/* ── nav ─────────────────────────────────────── */}
        <nav className="z-nav">
          <a href="#top" className="z-brand" style={{ color: 'inherit' }}><ZoqMark /><ZoqWord /></a>
          <div className="z-navlinks">
            <span className="pl-soonpill mono"><span className="dot" />LAUNCHING {SITE.launchShort}</span>
            {SITE.instagram && <a className="pl-social" href={SITE.instagram} target="_blank" rel="noreferrer" aria-label="Instagram"><IgIcon /><span className="hidesm">Instagram</span></a>}
            {SITE.youtube && <a className="pl-social" href={SITE.youtube} target="_blank" rel="noreferrer" aria-label="YouTube"><YtIcon /><span className="hidesm">YouTube</span></a>}
            <a className="z-signin" href="#waitlist">Notify me</a>
          </div>
        </nav>

        {/* ── hero ────────────────────────────────────── */}
        <section className="z-hero" id="top">
          <div className="z-hero-copy">
            <span className="z-kick"><span className="dot" />AI CREATORS · MADE FOR INDIA</span>
            <h1 className="z-h1">Your own<br />AI influencer.<br /><span className="a">Coming {SITE.launch.split(' ')[0]}.</span></h1>
            <p className="z-deck">
              One brief, a week of posts, <b>the same face every time.</b> ZoQ builds a persona that
              posts — photos, reels and Hinglish captions for Indian feeds — and it is already
              posting. Watch it work before you can buy it.
            </p>
            <div className="z-cta">
              <a className="z-btn" href="#waitlist">Get launch access<Arrow /></a>
              {SITE.instagram
                ? <a className="z-btn ghost" href={SITE.instagram} target="_blank" rel="noreferrer"><IgIcon />Follow Aanya</a>
                : <a className="z-btn ghost" href="#catalogue">See the catalogue</a>}
            </div>
            <div className="z-chips">
              <span>Same face, every shot</span><span>Reels + photos</span><span>Hinglish · Hindi voice</span><span>Made in India</span>
            </div>
          </div>
          <Plate assets={assets} label="Aanya Kapoor, generated — one take" />
        </section>

        {/* ── proof strip ─────────────────────────────── */}
        <section className="pl-strip">
          <div><b>{liveFaces}</b><span>faces live in the catalogue</span></div>
          <div><b>0.91</b><span>likeness score every frame must clear</span></div>
          <div><b>{SITE.launchShort}</b><span>public launch · one week before Diwali</span></div>
          <div><b>100%</b><span>of outputs labelled AI-generated</span></div>
        </section>

        {/* ── catalogue ───────────────────────────────── */}
        <section className="z-sec" id="catalogue">
          <p className="z-eyebrow">THE CATALOGUE</p>
          <h2 className="z-h2">Pick a face.<br />It's <span className="a">consistent</span> from post one.</h2>
          <p className="z-lead">
            Every catalogue persona is a trained, calibrated model — not a prompt. The ones marked
            live have real renders behind them; the rest are being built in the open and light up
            here as they land.
          </p>
          <div className="pl-faces">
            {CATALOGUE.filter((f) => f.status === 'live').map((f) => <FaceCard key={f.slug} face={f} />)}
          </div>
          <div className="pl-queue-head">
            <span className="z-eyebrow" style={{ margin: 0 }}>IN THE PIPELINE</span>
            <span className="z-note">Bibles written · seed sets and training in progress · they light up here as they land</span>
          </div>
          <div className="pl-queue">
            {CATALOGUE.filter((f) => f.status !== 'live').map((f) => <QueueCard key={f.slug} face={f} />)}
          </div>
          <p className="z-note" style={{ marginTop: 18 }}>
            Faces are shared on Free and Catalogue plans. Your own persona, mascot or clone starts on Pro.
          </p>
        </section>

        {/* ── offerings ───────────────────────────────── */}
        <section className="z-sec" id="offering">
          <p className="z-eyebrow">WHAT YOU'LL BE ABLE TO DO</p>
          <h2 className="z-h2">One machine.<br />Every kind of <span className="a">creator</span>.</h2>
          <div className="pl-offers">
            {OFFERINGS.map((o) => (
              <article key={o.key} className={`pl-offer is-${o.when}`}>
                <div className="pl-offer-head">
                  <span className={`pl-tag ${o.when === 'launch' ? 'is-live' : 'is-soon'}`}>{o.when === 'launch' ? `At launch · ${SITE.launchShort}` : 'After launch'}</span>
                  <span className="mono">{o.tag}</span>
                </div>
                <h3>{o.title}</h3>
                <p>{o.text}</p>
              </article>
            ))}
          </div>
        </section>

        {/* ── plans (indicative) ──────────────────────── */}
        {SITE.showPlans && (
          <section className="z-sec" id="plans">
            <p className="z-eyebrow">PLANS · INDICATIVE</p>
            <h2 className="z-h2">Priced for India,<br />not converted from dollars.</h2>
            <div className="z-prices">
              {PLANS.map((p) => (
                <div key={p.plan} className={`z-price${p.hot ? ' hot' : ''}`}>
                  <div className="amt">{p.amt}</div>
                  <div className="plan">{p.plan}</div>
                  <div className="desc">{p.desc}</div>
                </div>
              ))}
            </div>
            <p className="z-price-note">
              Monthly, in rupees, with UPI. One credit is one photo; a reel is a few. Final numbers
              are locked at launch — join the list and the first fifty get founding pricing.
            </p>
          </section>
        )}

        {/* ── from the feed ───────────────────────────── */}
        <section className="z-sec" id="feed">
          <p className="z-eyebrow">FROM THE FEED</p>
          <h2 className="z-h2">Don't take our word.<br />Take <span className="a">hers</span>.</h2>
          <p className="z-lead">
            Aanya posts from the pipeline every day — every one disclosed as AI-generated. This is
            the product, in public, before launch.
          </p>
          {posts.length > 0 ? (
            <div className="pl-feed">
              {posts.map((p) => <SocialEmbed key={p.url} post={p} />)}
            </div>
          ) : (
            <div className="pl-feed-empty">
              <CropMarks />
              <span className="mono">FIRST POSTS LANDING SOON</span>
              <p>The first reels from the pipeline appear here{hasSocial ? ' — follow along meanwhile.' : '.'}</p>
              {hasSocial && (
                <div className="z-cta">
                  {SITE.instagram && <a className="z-btn ghost" href={SITE.instagram} target="_blank" rel="noreferrer"><IgIcon />Instagram</a>}
                  {SITE.youtube && <a className="z-btn ghost" href={SITE.youtube} target="_blank" rel="noreferrer"><YtIcon />YouTube</a>}
                </div>
              )}
            </div>
          )}
        </section>

        {/* ── waitlist ────────────────────────────────── */}
        <section className="z-close" id="waitlist">
          <div>
            <p className="z-eyebrow">LAUNCH ACCESS</p>
            <h2 className="z-h2">Be there when the<br /><span className="a">catalogue</span> opens.</h2>
            <p className="z-lead">
              One email when we go live in {SITE.launch}. The first fifty on the list get early
              access and founding pricing. No card, no spam.
            </p>
          </div>
          <Waitlist />
        </section>

        {/* ── footer ──────────────────────────────────── */}
        <footer className="z-foot">
          <span className="disclose">Every persona is disclosed as AI-generated, in the bio and on every post. We only ever clone you — never anyone else.</span>
          <span className="z-foot-links" style={{ display: 'flex', gap: 16 }}>
            <a href="#catalogue">Catalogue</a>
            <a href="#offering">Offering</a>
            {SITE.showPlans && <a href="#plans">Plans</a>}
            <a href="#feed">Feed</a>
            {SITE.instagram && <a href={SITE.instagram} target="_blank" rel="noreferrer">Instagram</a>}
            {SITE.youtube && <a href={SITE.youtube} target="_blank" rel="noreferrer">YouTube</a>}
          </span>
          <span><a href={`mailto:${SITE.email}`}>{SITE.email}</a> · © 2026 ZoQ · {SITE.domain}</span>
        </footer>
      </div>
    </div>
  );
}
