'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { get, post, errorText } from '../../../lib/api';
import { useResource, Resource } from '../../../components/Guard';

/**
 * New avatar.
 *
 * ── Why this is a guided form and not a text box ────────────────────────────
 *
 * The identity block is concatenated VERBATIM into every prompt this avatar
 * will ever generate, and it is frozen: editing it later invalidates the
 * trained LoRA and every calibrated QC baseline. It is the most expensive field
 * in the product to get wrong, and — this is the part that makes a plain
 * textarea dangerous — nothing about getting it wrong is visible at the time.
 * You find out three hundred images later that every one of them is smiling in
 * a red saree at golden hour, because those words went in on day one.
 *
 * A blank box invites prose. Fields invite description. So the fields compose
 * the block, the preview shows exactly the string that will be frozen, and the
 * rules run as you type rather than on submit.
 *
 * The rules themselves come from the server (`GET /avatars/rules`) rather than
 * being restated here. The POST re-checks with the same module and is the
 * authority; this is only so the answer arrives before the click.
 */
export default function NewAvatar() {
  const rules = useResource('/avatars/rules');
  return (
    <>
      <div className="topbar">
        <div className="crumb"><Link className="lnk" href="/avatars">Avatars</Link> · <b>New</b></div>
      </div>
      <div className="page prof">
        <Resource state={rules}>{(r) => <Form rules={r} />}</Resource>
      </div>
    </>
  );
}

const MODES = [
  { key: 'synthetic', label: 'Synthetic',
    blurb: 'A person who does not exist. Nobody to depict, nobody to ask.' },
  { key: 'twin', label: 'Digital twin',
    blurb: 'Your own likeness. Legitimate — you are consenting to yourself.' },
];

function Form({ rules }) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [mode, setMode] = useState('synthetic');
  const [f, setF] = useState({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [fieldErrors, setFieldErrors] = useState({});

  /**
   * Generating starts here rather than on the next screen.
   *
   * "No photos to choose from yet" with a button on it is a dead end: the
   * moment somebody has finished describing a face is the moment they want to
   * see it, and making them press a second button on a second page to find out
   * it costs money is two disappointments instead of one decision.
   *
   * On by default — that is what "automatically" means — but the price is on
   * the form, because a form that quietly spends a month's allowance is one
   * people find out about on an invoice.
   */
  const [genOn, setGenOn] = useState(true);
  const [genCount, setGenCount] = useState(80);
  const [quote, setQuote] = useState(null);

  useEffect(() => {
    if (!genOn) return undefined;
    let live = true;
    // Debounced: a typed count changes on every keystroke, and one request per
    // keystroke is one request per keystroke.
    const t = setTimeout(async () => {
      try {
        const q = await get(`/candidates/quote?count=${genCount}`);
        if (live) setQuote(q);
      } catch { /* the price is a courtesy; the server prices it again on submit */ }
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [genOn, genCount]);

  const set = (k, v) => setF((prev) => ({ ...prev, [k]: v }));

  // Composed the same way the server composes it — a comma join, deliberately
  // trivial, so the preview is the string that gets frozen and not an
  // approximation of it.
  const identity = useMemo(() => compose(f), [f]);
  const check = useMemo(() => validate(identity, rules, name), [identity, rules, name]);

  const missing = rules.fields.filter((x) => x.required && !String(f[x.key] || '').trim());
  const ready = name.trim() && identity && check.ok && !missing.length;

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setErr(null); setFieldErrors({});
    try {
      const out = await post('/avatars', {
        name: name.trim(), mode, identity_fields: f,
        ...(genOn ? { generate: { count: genCount } } : {}),
      });
      // Straight to the face screen either way. If generation was refused it
      // says so there, next to the button that can start a smaller batch —
      // which is a better place for that conversation than this form.
      router.push(out.next || '/avatars');
    } catch (e2) {
      if (e2?.body?.fields) setFieldErrors(e2.body.fields);
      setErr(errorText(e2, 'Could not create the avatar.'));
    } finally { setBusy(false); }
  }

  return (
    <form onSubmit={submit}>
      <h1>New avatar</h1>
      <p className="hint prof-deck">
        Two things are decided here and neither can be changed afterwards without
        retraining: who this person is, physically, and whether they depict anybody real.
      </p>

      <section className="card prof-card">
        <div className="label">Name</div>
        <label className="field">
          <span className="field-label">What you will call them</span>
          <input value={name} onChange={(e) => setName(e.target.value)}
                 placeholder="Aanya Kapoor" autoFocus
                 aria-invalid={fieldErrors.name ? true : undefined} />
          {fieldErrors.name
            ? <span className="prof-err">{fieldErrors.name}</span>
            : <span className="helper">
                For you and the interface only. The name never goes into a prompt — a name
                the model recognises drags the face towards whoever it has seen with it.
              </span>}
        </label>
      </section>

      <section className="card prof-card">
        <div className="label">Who they are</div>
        <div className="mode-row">
          {MODES.map((m) => (
            <button type="button" key={m.key}
                    className={`mode-card${mode === m.key ? ' on' : ''}`}
                    onClick={() => setMode(m.key)}>
              <b>{m.label}</b>
              <span className="helper">{m.blurb}</span>
            </button>
          ))}
        </div>
        {mode === 'twin' && (
          /* Said before it is chosen, not at the train button — by then the seed
             set has been generated and paid for. */
          <div className="lp-msg warn" role="status">
            <b>A twin cannot be trained yet</b>
            <span>
              Depicting a real person needs a verified consent record — the subject
              recording a video on a hosted page, matched against the training material.
              That capture flow is not built, so a twin can be created and described now
              but training and generation will be refused until it is. It still counts
              against your avatar allowance.
            </span>
          </div>
        )}
        {mode === 'synthetic' && (
          <p className="helper">
            Generating a likeness of anyone <i>else</i> is not something this product does,
            in any mode — it is refused by a database constraint, not a setting.
          </p>
        )}
      </section>

      <section className="card prof-card">
        <div className="plan-head">
          <span className="label">Identity — frozen</span>
          <span className={`hint ${check.words > rules.word_max || (check.words && check.words < rules.word_min) ? 'adm-bad' : ''}`}>
            <b>{check.words}</b> / {rules.word_min}–{rules.word_max} words
          </span>
        </div>
        <p className="helper av-freeze-note">
          Physical description only. This exact string goes into every prompt this avatar
          ever generates, so anything that changes shot to shot — clothes, mood, place,
          light — must not be here. Changing it later means retraining.
        </p>

        <div className="id-grid">
          {rules.fields.map((x) => (
            <label className="field" key={x.key}>
              <span className="field-label">
                {x.label}{x.required ? '' : <span className="helper"> optional</span>}
              </span>
              <input value={f[x.key] || ''} placeholder={x.placeholder}
                     onChange={(e) => set(x.key, e.target.value)} />
              {x.hint && <span className="helper">{x.hint}</span>}
            </label>
          ))}
        </div>
      </section>

      <section className="card prof-card">
        <div className="label">What gets frozen</div>
        {identity
          ? <p className="mono id-preview">{identity}</p>
          : <p className="hint">Fill the fields above and the block appears here.</p>}

        {check.errors.map((e) => (
          <p className="prof-err id-err" key={e.code}>{e.message}</p>
        ))}

        {identity && check.ok && (
          <p className="helper adm-ok">
            Reads as a description of a person rather than a photograph of one. That is what
            holds across hundreds of images.
          </p>
        )}
      </section>

      <section className="card prof-card">
        <div className="plan-head">
          <span className="label">Then generate their photos</span>
          <label className="gen-toggle">
            <input type="checkbox" checked={genOn} onChange={(e) => setGenOn(e.target.checked)} />
            <span className="helper">Start straight away</span>
          </label>
        </div>

        <p className="helper av-freeze-note">
          There is no trained model yet, so these are the base model&rsquo;s attempts at the
          description above. You keep the ones that agree with each other, and those become
          what {name.trim() || 'this avatar'} looks like.
        </p>

        {genOn && (
          <>
            <div className="gen-row">
              {[24, 48, 80, 120, 200].map((n) => (
                <button type="button" key={n}
                        className={`btn ghost sm${genCount === n ? ' on' : ''}`}
                        onClick={() => setGenCount(n)}>{n}</button>
              ))}
              <input className="mono gen-count" inputMode="numeric" value={genCount}
                     onChange={(e) => setGenCount(Math.max(1, Number(e.target.value.replace(/\D/g, '')) || 1))} />
              <span className="helper">frames</span>
            </div>

            {quote && (
              <div className="gen-quote">
                <div className="gen-line">
                  <span>Included with this avatar</span>
                  <b>{quote.from_plan} of {quote.allowance.included}</b>
                </div>
                {quote.overage > 0 && (
                  <div className={`gen-line${quote.credits_short > 0 ? ' adm-bad' : ''}`}>
                    <span>From bought credits</span>
                    <b>{quote.credits_needed} of {quote.credits_held} held</b>
                  </div>
                )}
                <p className="helper">
                  {quote.credits_short > 0
                    ? `Short by ${quote.credits_short} credits. ${name.trim() || 'The avatar'} will still be created — `
                      + `you can start ${quote.affordable_count} photos from their page, or top up for the full batch.`
                    : quote.overage > 0
                      ? `${quote.allowance.included} photos come with the avatar; the other ${quote.overage} `
                        + 'come from credits you have already bought.'
                      : `Within the ${quote.allowance.included} that come with every avatar on your plan.`}
                </p>
              </div>
            )}
          </>
        )}

        {!genOn && (
          <p className="helper">
            Nothing will be generated. You can start a batch from {name.trim() || 'the avatar'}&rsquo;s
            page whenever you like — the description is what has to be right first.
          </p>
        )}
      </section>

      {err && (
        <div className="lp-msg warn" role="alert">
          <b>Could not create it</b>
          <span>{err}</span>
        </div>
      )}

      <div className="prof-actions">
        <button className="btn" type="submit" disabled={!ready || busy}>
          {busy ? 'Creating…' : genOn ? `Create and generate ${genCount} frames` : 'Create avatar'}
        </button>
        <Link className="btn ghost" href="/avatars">Cancel</Link>
        {!ready && !busy && (
          <span className="helper">
            {missing.length
              ? `Still needed: ${missing.map((m) => m.label.toLowerCase()).join(', ')}.`
              : !name.trim() ? 'A name first.'
              : 'The identity block is not valid yet.'}
          </span>
        )}
      </div>
    </form>
  );
}

/** The same order the server uses. A comma join, and nothing cleverer. */
function compose(f) {
  const g = (k) => String(f[k] || '').replace(/\s+/g, ' ').trim();
  const head = [g('age') && `${g('age')} year old`, g('origin'), g('presenting')].filter(Boolean).join(' ');
  return [head, g('skin'), g('build'), g('height'), g('hair'), g('eyes'), g('face'), g('mark')]
    .filter(Boolean).join(', ');
}

/**
 * The same checks, against the server's own word lists.
 *
 * This is a preview of the server's answer, not a second opinion: the lists
 * arrive from `/avatars/rules` so there is no copy here to fall out of date,
 * and POST /avatars re-runs the real thing and is what decides.
 */
function validate(identity, rules, name) {
  const words = identity.trim() ? identity.trim().split(/\s+/).length : 0;
  const errors = [];
  if (!identity) return { ok: false, words: 0, errors };

  if (words > rules.word_max) {
    errors.push({ code: 'TOO_LONG',
      message: `${words} words; the cap is ${rules.word_max}. Past that the description dilutes — the model averages the extra detail away and the face drifts.` });
  }
  if (words < rules.word_min) {
    errors.push({ code: 'TOO_SHORT',
      message: `Only ${words} words. Under ${rules.word_min} there is not enough here to hold one face across hundreds of images.` });
  }

  const low = identity.toLowerCase();
  const leaked = rules.leaked.filter((w) => low.includes(w));
  if (leaked.length) {
    errors.push({ code: 'LEAKED',
      message: `Contains ${leaked.join(', ')}. Clothing, mood, location and lighting change shot to shot — freezing one here puts it in every image this avatar ever makes.` });
  }
  const banned = rules.banned.filter((w) => low.includes(w));
  if (banned.length) {
    errors.push({ code: 'BANNED',
      message: `Asks for ${banned.join(', ')} — the plastic look the prompt vocabulary exists to avoid. Skin needs pores and asymmetry to read as real.` });
  }
  const first = String(name || '').trim().split(/\s+/)[0];
  if (first && first.length > 2 && low.includes(first.toLowerCase())) {
    errors.push({ code: 'NAME',
      message: `Contains the name “${first}”. Physical description only — a name pulls the face towards whoever the model already associates with it.` });
  }

  return { ok: errors.length === 0, words, errors };
}
