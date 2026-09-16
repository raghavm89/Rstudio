'use client';

import Link from 'next/link';
import '../app/zoq.css';
import '../app/landing.css';
import '../app/legal.css';
import { ZoqNav, ZoqFooter } from './ZoqChrome';

/**
 * /terms — plain-language Terms & AI-disclosure. A LAUNCH DRAFT, not final legal
 * copy: the substance is drawn from the frozen guardrails (offering-frozen-spec
 * §4/§5 + decision-character-avatars-mode3), and it is explicitly marked as
 * pending counsel review (T13). Not legal advice.
 */
export default function Terms() {
  return (
    <div className="z">
      <div className="z-glow tr" />
      <div className="z-wrap">
        <ZoqNav />

        <section className="z-hero zl-hero">
          <span className="z-kick"><span className="dot" />TERMS &amp; AI DISCLOSURE</span>
          <h1 className="z-h1">The plain-language rules.</h1>
          <div className="zl-draft">
            <span aria-hidden="true">⚠️</span>
            <span>This is a launch-time draft written in plain language, <b>not final legal terms</b>. It is being reviewed by counsel and may change, and nothing here is legal advice. Questions? <a href="mailto:hello@zoq.app">hello@zoq.app</a>.</span>
          </div>
          <span className="zl-meta">Last updated 16 Sep 2026 · Draft v0</span>
        </section>

        <section className="z-sec zl-body">
          <h2>1 · Everything ZoQ makes is AI-generated</h2>
          <div className="zl-callout">
            <p><b>ZoQ avatars are not real people, and ZoQ content is not a recording of real events.</b> Every avatar — an invented persona, a mascot, or a clone of a real person — is a synthetic or AI-produced likeness, and every photo, reel and voice it produces is created by AI.</p>
          </div>
          <p>We label all output as AI-generated, and we require the same disclosure on any account that publishes ZoQ content — in the account bio and on every post. You agree to keep that disclosure in place and never to pass ZoQ content off as a real, un-edited recording of a real person or event.</p>

          <h2>2 · Who can use ZoQ</h2>
          <p>You must be 18 or older and able to enter a binding agreement. Keep your account details accurate, keep your password safe, and you are responsible for everything done under your account and for the content you create and publish.</p>

          <h2>3 · Digital clones need verified consent</h2>
          <p>A clone (digital twin) depicts a <b>real person</b>, so we require that person's verified consent before we train it or generate anything with it. Consent is a recorded consent statement that we match to your training footage to confirm you are the same person — not a checkbox.</p>
          <ul>
            <li>At launch, cloning is <b>self-clone only</b> — you consenting to a clone of yourself.</li>
            <li><b>Voice cloning is clone-only</b>, and made from your own consented recording.</li>
            <li>You confirm you are the person in the consent video and the footage, and you can withdraw consent, after which we stop generating with the clone.</li>
          </ul>

          <h2>4 · Custom characters &amp; uploaded images</h2>
          <p>A character (a mascot or creature) depicts nobody. If you build one from an <b>uploaded reference image</b>, you attest that you own or have the rights to that image, you agree to indemnify ZoQ for it, and you accept that infringing uploads are removed on notice. Do not upload anyone else's protected mascot, character, logo or artwork.</p>

          <h2>5 · Your accounts &amp; publishing</h2>
          <p>When you publish to Instagram or YouTube, ZoQ acts through the <b>official platform APIs using your own connected accounts</b> — never headless automation, scraping, or fake engagement. You are responsible for following those platforms' own rules. WhatsApp, where used, only delivers your finished reels to you.</p>

          <h2>6 · Acceptable use</h2>
          <p>Do not use ZoQ to:</p>
          <ul>
            <li>impersonate a real person without their verified consent, or create a non-consensual likeness of anyone;</li>
            <li>make sexual content, content involving minors, or content that harasses, defames, deceives, or defrauds;</li>
            <li>mislead people into believing AI content is a genuine recording where that is unlawful or against platform rules;</li>
            <li>break any law, or any third party's rights.</li>
          </ul>

          <h2>7 · Plans, credits &amp; payments</h2>
          <p>Paid plans are monthly credit wallets; the Free tier is a one-time grant. You can top up credits at any time. Some third-party costs (for example WhatsApp conversations or live-clone streaming) are passed through and billed on top of your plan. Prices are in INR; GST applies as required. Any refund terms will be stated at checkout.</p>

          <h2>8 · Ownership of what you make</h2>
          <p>Subject to these terms and to the rights in any material you upload, you own the outputs you create within your plan and may publish them through your connected accounts. The AI-generated label stays on every output.</p>

          <h2>9 · Data, logging &amp; where it lives</h2>
          <p>We host your data in India. For safety and to be ready to act on valid takedown requests, we log generations so each is traceable to your account, the relevant consent or upload attestation, and its source. We aim to be able to act on a valid report promptly.</p>

          <h2>10 · Takedowns &amp; reporting</h2>
          <p>If you believe content infringes your rights or depicts you without consent, contact <a href="mailto:hello@zoq.app">hello@zoq.app</a> and we will review and remove it where appropriate.</p>

          <h2>11 · Changes to these terms</h2>
          <p>We may update these terms as the product and the law evolve. Material changes will be posted here; continuing to use ZoQ after an update means you accept it.</p>

          <div className="zl-callout" style={{ marginTop: 22 }}>
            <p><b>Not legal advice.</b> This draft is under review by counsel and may change before launch. See also our <Link href="/faq">FAQ</Link>.</p>
          </div>
        </section>

        <ZoqFooter />
      </div>
    </div>
  );
}
