'use client';

import { useState } from 'react';
import Link from 'next/link';
import '../app/landing.css';
import { useAuth } from './AuthProvider';
import Plate, { timecode } from './Plate';

/**
 * studio.rstudio.app — the front door.
 *
 * Deliberately not the app's design system. Direction C exists for someone
 * working: flat, quiet, legible for an hour. A landing page gets eight seconds
 * and a different job — say what kind of thing this is before anyone reads a
 * word. So this is set as a fashion title, which is the register the work itself
 * lives in, and shares exactly one thing with the app: the violet.
 *
 * ── Two states, both finished ───────────────────────────────────────────────
 * With `assets`, the hero is a real generated clip under film grain and a slate.
 * Without, it is a drawn plate: a lit, grained, captioned frame that cycles its
 * setup. The second is not a placeholder — it is what the page looks like before
 * `studio/hero-assets.js` has been run, and it is meant to be shippable, because
 * a front page that is broken until a build step runs is a front page that will
 * one day be broken in front of someone.
 *
 * ── What the page may and may not claim ─────────────────────────────────────
 * The frames come from ONE take. Image-to-video preserves identity by
 * construction, so "the same face, six moments" is true. "Six setups from one
 * brief" would not be — that needs her trained LoRA, and until it exists the
 * copy says the weaker true thing.
 *
 * Likewise the slate. It shows a likeness score only when the manifest carries
 * one, which happens after QC has actually measured frames against calibrated
 * baselines. Before that it shows generation metadata, which is real. A number
 * invented for a screenshot is the one thing on this page that would be worth
 * nothing.
 */

const SHEET = [
  { label: 'Close', hue: 'rgba(255,241,214,.85)', x: '18%', y: '22%', s: 76 },
  { label: 'Medium', hue: 'rgba(91,61,245,.75)', x: '64%', y: '30%', s: 84 },
  { label: 'Full', hue: 'rgba(232,120,80,.7)', x: '38%', y: '68%', s: 92 },
  { label: 'Reel 9:16', hue: 'rgba(255,241,214,.7)', x: '70%', y: '18%', s: 70 },
  { label: 'Cover', hue: 'rgba(91,61,245,.6)', x: '26%', y: '54%', s: 88 },
  { label: 'Detail', hue: 'rgba(232,120,80,.55)', x: '56%', y: '62%', s: 74 },
];

export default function Landing({ assets = null }) {
  const { signedIn } = useAuth();
  // A video that cannot decode leaves a black rectangle where the hero should
  // be, and it happens for reasons the page cannot see: a browser build without
  // an H.264 decoder, a proxy that mangles the range request, a corrupt upload.
  // Falling back to the drawn plate means the worst case is the page we already
  // consider shippable, rather than a hole.

  // Three possible sheets, and the copy below follows whichever one is real:
  // six generated setups (needs her LoRA), six frames from one take, or the
  // drawn cells. The claim is derived from what is on the page rather than
  // asserted over it.
  const setups = assets?.setups?.length ? assets.setups : null;
  const sheet = setups || (assets?.frames?.length ? assets.frames : null);

  return (
    <div className="lp">
      <div className="lp-wrap">

        <header className="lp-masthead">
          <div className="word">Rstudio</div>
          <nav className="lp-mast-right">
            <a href="#how">How it works</a>
            <a href="#pricing">Pricing</a>
            {signedIn
              ? <Link className="cta" href="/avatars">Open Studio</Link>
              : <Link className="cta" href="/login">Sign in</Link>}
          </nav>
        </header>

        {/* ── Hero ───────────────────────────────────────────────────────── */}
        <section className="lp-hero">
          <div>
            <div className="lp-kicker lp-rise">AI Persona Studio — for Indian creators</div>

            <h1 className="lp-h1 lp-rise lp-rise-2">
              One face.<br />
              <em>Every</em> post.
            </h1>

            <p className="lp-deck lp-rise lp-rise-3">
              Train a persona once. Then shoot a week of photos and reels from a single
              brief — <b>the same face, the same look, every time</b>. No prompt writing,
              no re-rolling until one frame happens to match.
            </p>

            <div className="lp-actions lp-rise lp-rise-4">
              <Link className="lp-btn" href={signedIn ? '/avatars' : '/signup'}>
                {signedIn ? 'Open Studio' : 'Start free'} <span aria-hidden="true">→</span>
              </Link>
              <a className="lp-btn ghost" href="#how">See how it works</a>
            </div>
            <p className="lp-note lp-rise lp-rise-4">
              Free tier · No card · Nothing publishes without you
            </p>
          </div>

          <Plate assets={assets} className="lp-rise lp-rise-3" />

        </section>

        {/* ── Contact sheet ──────────────────────────────────────────────── */}
        <section className="lp-sheet">
          <div className="lp-sheet-head">
            {/* The claim changes with what is actually on the page. Frames cut
                from one take are the same person by construction; six separate
                generations without a trained LoRA would not be, and saying so
                anyway would be a false claim about the product on the product's
                own front page. */}
            <span>
              {setups
                ? <><b>One persona</b> — {setups.length} setups from a single brief</>
                : sheet
                  ? <><b>One take</b> — {sheet.length} frames, the same face throughout</>
                  : <><b>One persona</b> — six setups from a single brief</>}
            </span>
            <span>Contact sheet · Aanya Kapoor · Roll 01</span>
          </div>

          <div className="lp-strip">
            {sheet
              ? sheet.map((c) => (
                <div className="lp-cell" key={c.src}>
                  <img className="lp-cell-img" src={c.src} alt="" loading="lazy" />
                  <div className="lp-plate-grain" />
                  {/* A generated setup is captioned by its setup; a frame cut
                      from the clip is captioned by its timecode. Labelling a
                      frame "Close · 85mm" would describe a shot nobody set up. */}
                  <div className="lp-cell-cap">{c.label || timecode(Number(c.t))}</div>
                </div>
              ))
              : SHEET.map((c) => (
                <div className="lp-cell" key={c.label}>
                  <div
                    className="lp-cell-l"
                    style={{ left: c.x, top: c.y, width: `${c.s}%`, height: `${c.s}%`,
                             transform: 'translate(-50%,-50%)',
                             background: `radial-gradient(circle, ${c.hue}, transparent 70%)` }}
                  />
                  <div className="lp-plate-grain" />
                  <div className="lp-cell-cap">{c.label}</div>
                </div>
              ))}
          </div>
        </section>

        {/* ── Feature ────────────────────────────────────────────────────── */}
        <section className="lp-feature" id="how">
          <h2>
            The hard part was never<br />
            making <em>an</em> image.
          </h2>
          <p className="lp-deck">
            It was making the four hundredth image look like the first one. Studio measures
            every face against a calibrated likeness before you ever see a frame, so a feed
            reads as one person who shot it — not a folder of strangers who nearly match.
          </p>
        </section>

        <section className="lp-steps">
          <div className="lp-step">
            <span className="n">01</span>
            <h3>Find the face</h3>
            <p>
              Pick from a catalogue, or build one from a seed set of your own. Studio trains
              a model that belongs to you and keeps the file.
            </p>
            <span className="meta">~20 minutes, once</span>
          </div>
          <div className="lp-step">
            <span className="n">02</span>
            <h3>Set the look</h3>
            <p>
              Camera, lens, colour, grain, skin. Seven choices that go into every photo they
              ever take — chosen from a vocabulary, not typed into a box.
            </p>
            <span className="meta">Chosen once, then locked</span>
          </div>
          <div className="lp-step">
            <span className="n">03</span>
            <h3>Shoot</h3>
            <p>
              One brief becomes a week: stills, reels, captions, and a schedule. Every frame
              checked against their likeness before it reaches you.
            </p>
            <span className="meta">One click, nine steps</span>
          </div>
        </section>

        {/* ── Close ──────────────────────────────────────────────────────── */}
        <section className="lp-close" id="pricing">
          <div>
            <h2>Start with a <em>free</em> shoot.</h2>
            <p>
              Build a persona, take a set of stills and one reel, and see whether the face
              holds. No card, and nothing reaches Instagram until you press publish.
            </p>
            <div className="lp-actions">
              <Link className="lp-btn" href={signedIn ? '/avatars' : '/signup'}>
                {signedIn ? 'Open Studio' : 'Create your account'} <span aria-hidden="true">→</span>
              </Link>
            </div>
          </div>
          {/* Three prices, and they are the ones in the plans table — not a
              second set typed here. This block said "Free · 240s" and "₹1,499
              Creator" while the app charged ₹12,000 for a plan called Pro, which
              is the kind of disagreement a customer finds before you do.

              Still hardcoded, because the landing page is a server component
              rendered without a session and the plans endpoint needs one. Worth
              moving to a public endpoint the moment these numbers change again;
              flagged here so the next person editing prices knows there are two
              places until then. */}
          <div className="lp-close-right">
            <div className="lp-price">
              Free
              <small>1 persona · 3 videos a month · 15 stills</small>
            </div>
            <div className="lp-price" style={{ fontSize: 30 }}>
              ₹2,000<small>Pro · 850 credits a month</small>
            </div>
            <div className="lp-price" style={{ fontSize: 22 }}>
              ₹6,000<small>Max · 2,600 credits a month</small>
            </div>
            <p className="lp-price-note">
              One credit is one second of generated video. Top up at ₹500 for 210 credits.
            </p>
          </div>
        </section>

        <footer className="lp-foot">
          <span className="disclose">
            Every persona is disclosed as AI-generated, in the bio and on every post.
          </span>
          <span>
            <a href="mailto:hello@rstudio.app">hello@rstudio.app</a> · © 2026 Rstudio
          </span>
        </footer>

      </div>
    </div>
  );
}


