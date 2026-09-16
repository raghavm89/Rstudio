'use client';

import Link from 'next/link';
import '../app/zoq.css';
import '../app/landing.css';
import '../app/legal.css';
import { ZoqNav, ZoqFooter } from './ZoqChrome';

/**
 * /faq — public questions & answers, grouped. Native <details> accordion (no
 * state, accessible). Content curated from the frozen offering spec + persona
 * strategy; kept honest about what is AI and what needs consent.
 */

const GROUPS = [
  { title: 'The basics', qa: [
    { q: 'What is ZoQ?', a: 'ZoQ is an AI creator studio, made for Indian audiences. You build an AI avatar — an invented persona, a brand mascot, or a clone of yourself — describe an idea, and it produces photos and reels you can post to Instagram and YouTube.' },
    { q: 'Is everything AI-generated?', a: 'Yes. Every avatar, and every photo, reel and voice it makes, is AI-generated. We label all of it as AI-generated, and the account bio must say so too.' },
    { q: 'Are the personas real people?', a: 'No. An invented persona is not a real person. A clone is a real person’s own AI likeness, made only with their verified consent.' },
  ] },
  { title: 'Avatars', qa: [
    { q: 'What kinds of avatars can I make?', a: 'Four: a shared catalogue avatar (free), your own custom avatar, a non-human character or mascot, and an AI clone (a digital twin of yourself). Custom avatars, characters and clones start on the Pro plan.' },
    { q: 'How is an avatar made?', a: 'A persona is built from text prompts (and the catalogue) — never from an uploaded photo of a face. A character can be made from text, or from a reference image you own the rights to. A clone is trained from a short consented video of you.' },
  ] },
  { title: 'Clones & consent', qa: [
    { q: 'How does cloning work, and is it safe?', a: 'You record a short consent video reading a statement; we verify it’s really you by matching it to your training footage before we train anything. At launch you can only clone yourself, voice cloning is clone-only, and you can withdraw consent at any time.' },
    { q: 'Can I clone someone else?', a: 'Not at launch — cloning is self-clone only. Third-party clones with a signed release may come later.' },
  ] },
  { title: 'Making content', qa: [
    { q: 'What can it make?', a: 'Reels (spoken/lipsync or generative video), photos and stills, ad- and viral-video templates, and it can extract the structure of a reel you like to reuse. You approve the storyboard and the stills before the final render.' },
    { q: 'How long does a reel take?', a: 'Usually a few minutes end to end, with two quick approval steps — you okay the storyboard, then the stills, and it finishes the reel.' },
    { q: 'Does my content post automatically?', a: 'No — nothing reaches Instagram or YouTube until you press publish, through your own connected accounts.' },
  ] },
  { title: 'Publishing & disclosure', qa: [
    { q: 'Can it publish to Instagram and YouTube?', a: 'Yes — to your own connected accounts, through the official platform APIs. WhatsApp can also deliver the finished reel to you.' },
    { q: 'Do I have to disclose it’s AI?', a: 'Yes. Every output is labelled AI-generated, and the account bio must disclose that the persona is AI. See our Terms & AI disclosure.' },
  ] },
  { title: 'Plans & credits', qa: [
    { q: 'How do credits work?', a: 'Each plan is a monthly credit wallet. One credit is about one photo; a video is about six. Spend them however you like, and top up any time at ₹500 for 77 credits. See the pricing page for the full breakdown.' },
    { q: 'Is there a free tier?', a: 'Yes — a one-time free grant on a shared catalogue avatar, no card needed. Custom avatars and clones start on Pro.' },
  ] },
  { title: 'Data & support', qa: [
    { q: 'Where is my data stored?', a: 'In India. We log generations so we can act on safety and takedown requests, traceable to your account and the relevant consent or upload attestation.' },
    { q: 'How do I get help?', a: 'Email hello@zoq.app and we’ll help.' },
  ] },
];

export default function Faq() {
  return (
    <div className="z">
      <div className="z-glow tr" />
      <div className="z-wrap">
        <ZoqNav />

        <section className="z-hero zl-hero">
          <span className="z-kick"><span className="dot" />FAQ</span>
          <h1 className="z-h1">Questions, answered.</h1>
          <p className="z-deck" style={{ textAlign: 'center' }}>
            What ZoQ is, how avatars and clones work, and how content, plans and your data are handled.
          </p>
        </section>

        <section className="z-sec zl-faqwrap">
          {GROUPS.map((g) => (
            <div key={g.title}>
              <p className="zl-grp">{g.title}</p>
              {g.qa.map((item) => (
                <details className="zl-faq" key={item.q}>
                  <summary>{item.q}</summary>
                  <p className="a">{item.a}</p>
                </details>
              ))}
            </div>
          ))}
          <p className="zl-meta" style={{ marginTop: 26, textAlign: 'center' }}>
            More detail in the <Link href="/pricing">pricing</Link> and <Link href="/terms">terms</Link> pages · <a href="mailto:hello@zoq.app">hello@zoq.app</a>
          </p>
        </section>

        <ZoqFooter />
      </div>
    </div>
  );
}
