'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { Steps } from '../../../../components/Shell';
import { useResource, Resource } from '../../../../components/Guard';
import { useAuth } from '../../../../components/AuthProvider';
import { get, post, errorText } from '../../../../lib/api';

/**
 * Find the face — the culling screen.
 *
 * A creator generates a few hundred candidates and keeps twelve to forty. This
 * is the single highest-leverage screen in the product, and it is also the one
 * most likely to be got wrong, because the obvious design (a grid, pick your
 * favourites) produces bad seed sets reliably.
 *
 * Three things fight that, and each is why this is a screen rather than a folder:
 *
 * 1. THE KEPT STRIP. Consistency is a property of the SET, not of any single
 *    image. Judging candidate 200 against your memory of candidate 3 is
 *    hopeless, so everything kept so far stays pinned above the grid and every
 *    decision is made against the face that is actually emerging.
 *
 * 2. COVERAGE IS THE GATE, NOT THE COUNT. A LoRA only holds in the conditions
 *    its training set saw. Twenty beautiful front-on soft-light frames produce a
 *    model that falls apart on the first profile in hard light — quietly, as
 *    drift rather than an error. Export is refused on a hole, and the refusal
 *    names the missing value and the consequence.
 *
 * 3. THE INSTRUCTION IS COUNTERINTUITIVE, SO IT STAYS ON SCREEN. You are keeping
 *    the frames that look like the same person, not the frames that look best.
 *    The mean embedding of what you keep becomes the reference every future
 *    image is judged against, permanently.
 *
 * Keyboard-first because three hundred decisions with a mouse is miserable.
 */

/**
 * The axes and the required counts come from the server.
 *
 * They used to be stated here AND in studio/cull.js, with nothing making them
 * agree. That is the worst shape for a gate: the strip drawn from one copy
 * would show a set as complete while the export, checking the other, refused
 * it. `GET /avatars/:id/candidates` returns the same `coverage` rules the
 * export gate applies, and the `gaps` it has already computed.
 */

/**
 * One source now, and it is the authenticated API.
 *
 * ── What this used to talk to ───────────────────────────────────────────────
 * A standalone HTTP service on :5055 with no authentication and no tenant
 * scoping. `/cull/api/candidates?avatar=N` answered for any N to anyone who
 * could reach the port; `/cull/img/<id>/<file>` served the pictures the same
 * way; and the verdicts lived in a JSON file next to them, belonging to a
 * directory rather than to a workspace. It also read its avatar list once at
 * startup, so an avatar created afterwards did not exist to it — which is how
 * the New avatar button led to a TypeError.
 *
 * Decisions now go to `POST /avatars/:id/candidates` and come back as the whole
 * recomputed state, so the coverage strip is what the DATABASE says rather than
 * what this component thinks it just clicked. A dropped request shows up as the
 * strip not moving, instead of two views quietly disagreeing.
 *
 * The pictures are still local files — a candidate pool is hundreds of
 * throwaway frames and uploading them to look at once would cost money for
 * nothing — but each one now arrives as a short-lived signed URL, because an
 * `<img>` tag cannot carry a bearer token.
 */
export default function FindHerFace({ params }) {
  const avatarId = params.id;
  const state = useResource(`/avatars/${avatarId}/candidates`);
  return (
    <Resource state={state}>
      {(d) => <Cull avatarId={avatarId} initial={d} reload={state.reload} />}
    </Resource>
  );
}

function Cull({ avatarId, initial, reload }) {
  const { user } = useAuth();
  const [data, setData] = useState(initial);
  const [cursor, setCursor] = useState(0);
  const [msg, setMsg] = useState(null);
  const [zoom, setZoom] = useState(false);
  const history = useRef([]);
  const gridRef = useRef(null);

  const avatar = data.avatar;

  /**
   * Pick up frames the generator is still writing, without moving the cursor
   * out from under someone mid-decision.
   *
   * Compares the COUNT before replacing: a poll that always replaced would
   * re-mint every signed URL every fifteen seconds, and every `<img>` would
   * reload because its src changed.
   */
  // Faster while frames are still arriving. Fifteen seconds is right for a
  // generator someone else started an hour ago and wrong for a batch they are
  // watching land right now.
  const arriving = Boolean(data.generating?.pending);
  useEffect(() => {
    const t = setInterval(async () => {
      try {
        const fresh = await get(`/avatars/${avatarId}/candidates`);
        if (!Array.isArray(fresh?.candidates)) return;
        setData((prev) => {
          // Replaced when the count moved OR when the batch's progress did —
          // otherwise a batch whose first frames have not landed shows a
          // progress bar frozen at zero while jobs are plainly finishing.
          const moved = fresh.candidates.length !== prev.candidates.length
            || fresh.generating?.pending !== prev.generating?.pending;
          return moved ? fresh : prev;
        });
      } catch { /* a poll that fails is a poll; the next one will do */ }
    }, arriving ? 4000 : 15000);
    return () => clearInterval(t);
  }, [avatarId, arriving]);

  const candidates = data?.candidates || [];
  const keep = useMemo(() => new Set(data?.keep || []), [data]);
  const reject = useMemo(() => new Set(data?.reject || []), [data]);
  const kept = useMemo(() => candidates.filter((c) => keep.has(c.filename)), [candidates, keep]);
  // Each candidate carries its own signed URL, minted by the server for this
  // response. Looking it up rather than building a path means the page has no
  // opinion about where the bytes live.
  const srcOf = useCallback(
    (filename) => candidates.find((c) => c.filename === filename)?.url || '',
    [candidates]
  );

  const axes = data?.coverage || [];
  const covered = useMemo(() => {
    const out = {};
    for (const { key } of axes) out[key] = new Set(kept.map((k) => k[key]));
    return out;
  }, [axes, kept]);

  // Not recomputed here. The server returns the gaps its own export gate will
  // apply, so the strip and the refusal cannot disagree.
  const gaps = data?.gaps || [];

  // The training panel. Opened by "Use these photos", polled while it is open
  // because a check is a queued job on another machine.
  const [trainOpen, setTrainOpen] = useState(false);
  const [trainState, setTrainState] = useState(null);
  useEffect(() => {
    if (!trainOpen) return undefined;
    let live = true;
    const tick = async () => {
      try {
        const fresh = await get(`/avatars/${avatarId}/train`);
        if (live) setTrainState(fresh);
      } catch { /* a poll that fails is a poll; the next one will do */ }
    };
    tick();
    const t = setInterval(tick, 3000);
    return () => { live = false; clearInterval(t); };
  }, [trainOpen, avatarId]);

  const mark = useCallback(async (verdict) => {
    const c = candidates[cursor];
    if (!c) return;
    const previous = keep.has(c.filename) ? 'keep' : reject.has(c.filename) ? 'reject' : null;
    // `applied` as well as `previous`: undo needs to know what to put back if
    // its own write fails, and "what this frame is now" is not otherwise
    // recorded anywhere the failure handler can reach.
    const entry = { filename: c.filename, previous, applied: verdict };
    history.current.push(entry);

    // Applied locally first so three hundred keystrokes feel like keystrokes,
    // then replaced by whatever the server says. The optimistic copy is a
    // guess; the response is the answer.
    setData((d) => ({
      ...d,
      keep: d.keep.filter((f) => f !== c.filename).concat(verdict === 'keep' ? [c.filename] : []),
      reject: d.reject.filter((f) => f !== c.filename).concat(verdict === 'reject' ? [c.filename] : []),
    }));
    if (verdict) setCursor((i) => Math.min(candidates.length - 1, i + 1));

    // Persisted per keypress, not on export. Three hundred judgements is far too
    // much work to lose to a closed tab.
    try {
      const fresh = await post(`/avatars/${avatarId}/candidates`, { filename: c.filename, verdict });
      // The server returns the recomputed verdicts and gaps. Merged rather than
      // replaced so the freshly minted URLs on `candidates` survive.
      setData((d) => ({ ...d, keep: fresh.keep, reject: fresh.reject, gaps: fresh.gaps }));
    } catch (err) {
      /**
       * A decision that did not land must not look like one that did.
       *
       * This said exactly that and then did not do it: the optimistic edge
       * stayed on the tile, so the screen showed four kept while the server
       * held none, and the count in the corner was counting something that
       * does not exist. Put the frame back the way the server still has it.
       */
      setData((d) => ({
        ...d,
        keep: d.keep.filter((f) => f !== c.filename).concat(previous === 'keep' ? [c.filename] : []),
        reject: d.reject.filter((f) => f !== c.filename).concat(previous === 'reject' ? [c.filename] : []),
      }));
      // And drop it from the undo stack. Undoing something that never happened
      // is a second wrong write, not a correction. Removed by identity rather
      // than popped, because another keystroke may have landed behind it.
      const at = history.current.indexOf(entry);
      if (at > -1) history.current.splice(at, 1);
      setMsg({ kind: 'crit', text: `That decision was not saved — ${errorText(err)}` });
    }
  }, [candidates, cursor, keep, reject, avatarId]);

  const undo = useCallback(async () => {
    const last = history.current.pop();
    if (!last) return;
    const i = candidates.findIndex((c) => c.filename === last.filename);
    if (i > -1) setCursor(i);
    setData((d) => ({
      ...d,
      keep: d.keep.filter((f) => f !== last.filename).concat(last.previous === 'keep' ? [last.filename] : []),
      reject: d.reject.filter((f) => f !== last.filename).concat(last.previous === 'reject' ? [last.filename] : []),
    }));
    try {
      const fresh = await post(`/avatars/${avatarId}/candidates`, { filename: last.filename, verdict: last.previous });
      setData((d) => ({ ...d, keep: fresh.keep, reject: fresh.reject, gaps: fresh.gaps }));
    } catch (err) {
      // Same again: an undo that did not reach the server must not look like
      // one that did. `applied` is what this frame was before the undo.
      setData((d) => ({
        ...d,
        keep: d.keep.filter((f) => f !== last.filename).concat(last.applied === 'keep' ? [last.filename] : []),
        reject: d.reject.filter((f) => f !== last.filename).concat(last.applied === 'reject' ? [last.filename] : []),
      }));
      history.current.push(last);
      setMsg({ kind: 'crit', text: `Undo was not saved — ${errorText(err)}` });
    }
  }, [candidates, avatarId]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.metaKey || e.ctrlKey) return;
      const k = e.key.toLowerCase();
      if (e.key === 'ArrowRight') { e.preventDefault(); setCursor((i) => Math.min(candidates.length - 1, i + 1)); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); setCursor((i) => Math.max(0, i - 1)); }
      else if (k === 'k') { e.preventDefault(); mark(keep.has(candidates[cursor]?.filename) ? null : 'keep'); }
      else if (k === 'x') { e.preventDefault(); mark('reject'); }
      else if (k === 'u') { e.preventDefault(); undo(); }
      else if (e.key === 'Enter') { e.preventDefault(); setZoom((z) => !z); }
      else if (e.key === 'Escape') setZoom(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [candidates, cursor, keep, mark, undo]);

  useEffect(() => {
    gridRef.current?.children?.[cursor]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [cursor]);

  /**
   * Pressing "Use these photos" measures the set. It does not train.
   *
   * Training is the most expensive single action in the product and the one
   * that cannot be undone — the reference vector it writes is what every future
   * frame is judged against. So this asks the question first: is this set
   * confidently one person, and what does the run cost. The second press is in
   * the panel, next to both answers.
   */
  async function train() {
    setMsg({ kind: 'busy', text: 'Checking the set…' });
    try {
      /**
       * If a run is already going, this is somebody coming back to watch it.
       *
       * Without this, the only way back to a training run in progress was the
       * same button that starts one — so returning to see how it was getting on
       * would queue a second check against a set already being trained.
       */
      const now = await get(`/avatars/${avatarId}/train`);
      const busy = now?.training && ['queued', 'claimed', 'running', 'done'].includes(now.training.status);
      if (!busy) await post(`/avatars/${avatarId}/train/check`);
      setTrainState(now);
      setMsg(null);
      setTrainOpen(true);
    } catch (err) {
      // The gate's refusals carry the reason in `gaps` — which axis is missing
      // and what the model does without it. Dropping that leaves "coverage
      // hole" with nothing to act on.
      setMsg({ kind: 'crit', text: errorText(err), detail: err?.body?.gaps });
    }
  }

  // Nothing to cull yet. This is the ordinary state of a brand-new avatar, and
  // it is the moment the next step has to be spelled out — the candidate pool
  // is generated by a script on the machine with the GPU, not by a button on
  // this page, and nothing on screen would otherwise say so.
  // A batch still landing is not "no photos yet". The seconds between queueing
  // eighty frames and the first one arriving would otherwise look exactly like
  // never having generated anything — to somebody who just paid for eighty.
  if (!candidates.length && data.generating) {
    return <Arriving avatarId={avatarId} avatar={avatar} generating={data.generating} />;
  }
  /**
   * The face is chosen before the pool is generated.
   *
   * Text describes a TYPE of person, not a person, so frames generated
   * independently from one description are different people who all match it —
   * which is why culling used to be a hunt. Choosing one face and generating
   * everything else FROM it is what turns culling into confirming.
   */
  if (!candidates.length && (data.anchors || []).length && !data.anchor_chosen_id) {
    return <ChooseFace avatarId={avatarId} avatar={avatar} anchors={data.anchors} reload={reload} />;
  }
  if (!candidates.length) {
    return <NoFrames avatarId={avatarId} avatar={avatar} framesPresent={data.frames_present}
                     anchored={Boolean(data.anchor_chosen_id)}
                     onQueued={() => reload?.()} />;
  }

  const min = data.limits?.min ?? 12;
  const max = data.limits?.max ?? 40;
  const enough = kept.length >= min && kept.length <= max && gaps.length === 0;

  return (
    <>
      <div className="topbar">
        <div className="crumb"><b>{avatar.name}</b><span>·</span><span>Find the face</span></div>
        <Steps current="face" avatarId={avatarId} />
      </div>

      <div className="page">
        <div className="face-head">
          <div>
            <h1>Which of these is your avatar?</h1>
            <p className="hint">
              Keep the ones that look like the <strong>same person</strong> — not the ones that look best.
              A striking photo that is subtly a different face is worse than a plain one that is
              unmistakably the same person.
            </p>
          </div>
          <div className="face-actions">
            {/**
              * The floor, not the range.
              *
              * "needs 12–40" reads as a window you have to land inside, so
              * somebody at four kept thinks they are aiming at a target when
              * they are only short. Twelve is a real requirement — below it the
              * model learns the background instead of the face. Forty is a cap,
              * and a cap is worth saying only to somebody who has reached it.
              */}
            <span className={`pill ${enough ? 'ok' : kept.length > max ? 'crit' : 'warn'}`}>
              {kept.length} kept
              {kept.length < min && ` · needs at least ${min}`}
              {kept.length > max && ` · at most ${max}`}
            </span>
            <button className="btn" onClick={train} disabled={!kept.length}>Use these photos</button>
          </div>
        </div>

        {data.generating && (
          /* Culling can start on the frames that have landed — the grid works
             at any size, and the first twenty-four already span the gate. */
          <p className="helper gen-still">
            <b>{data.generating.landed}</b> of {data.generating.queued} frames so far
            {data.generating.failed > 0 && ` · ${data.generating.failed} failed`}
            {' '}— the rest are still generating. You can start choosing now.
          </p>
        )}

        {/* Coverage. Not decoration — this is the export gate, shown before it fires. */}
        <div className="card cov-card">
          <div className="cov-axes">
            {axes.map((a) => (
              <div className="cov-axis" key={a.key}>
                <span className="helper">{a.label}</span>
                <div className="cov-chips">
                  {a.of.map((v) => (
                    <span key={v} className={`chip ${covered[a.key]?.has(v) ? 'met' : 'gap'}`}>{v}</span>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <p className="helper cov-why">
            {gaps.length
              ? gaps[0].why
              : 'Every angle, distance and light covered — the model will hold in all of them.'}
          </p>
        </div>

        {/* The kept strip. Compare against the emerging set, not against memory. */}
        <div className="strip">
          {kept.length
            ? kept.map((k) => (
                <img key={k.filename} src={srcOf(k.filename)} alt="" />
              ))
            : <span className="helper">Photos you keep appear here, so you can compare each new one against them.</span>}
        </div>

        <div className="grid" ref={gridRef}>
          {candidates.map((c, i) => (
            <button
              key={c.filename}
              className={`cand ${keep.has(c.filename) ? 'keep' : reject.has(c.filename) ? 'rej' : ''} ${i === cursor ? 'sel' : ''}`}
              aria-pressed={keep.has(c.filename)}
              onClick={() => { setCursor(i); }}
              onDoubleClick={() => { setCursor(i); mark(keep.has(c.filename) ? null : 'keep'); }}
            >
              <img loading="lazy" src={c.url} alt="" />
              {/**
                * A tick, not just a coloured edge.
                *
                * Keeping and being under the cursor were both drawn as an
                * outline, in two colours, over photographs of every colour —
                * so "which of these did I choose" was a question you answered
                * by squinting at borders. A decision deserves a mark that says
                * what it is.
                */}
              {keep.has(c.filename) && (
                <span className="cand-mark keep" aria-hidden="true">
                  <svg viewBox="0 0 16 16" width="11" height="11">
                    <path d="M2.5 8.5l3.6 3.6L13.5 4.5" fill="none" stroke="currentColor"
                          strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
              )}
              {reject.has(c.filename) && (
                <span className="cand-mark rej" aria-hidden="true">
                  <svg viewBox="0 0 16 16" width="11" height="11">
                    <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor"
                          strokeWidth="2.6" strokeLinecap="round" />
                  </svg>
                </span>
              )}
              <span className="cand-meta">{c.framing} · {c.angle}</span>
            </button>
          ))}
        </div>

        {!candidates.length && (
          <div className="empty">
            <h2>No photos yet</h2>
            <p>Candidate photos are still being made. They appear here as they finish.</p>
          </div>
        )}
      </div>

      <div className="bar">
        <span className="helper">
          <kbd>←</kbd><kbd>→</kbd> move &nbsp;·&nbsp; <kbd>K</kbd> keep &nbsp;·&nbsp;
          <kbd>X</kbd> skip &nbsp;·&nbsp; <kbd>U</kbd> undo &nbsp;·&nbsp; <kbd>↵</kbd> bigger
        </span>
        {msg && (
          <span className={`bar-msg ${msg.kind}`}>
            {msg.text}
            {msg.detail?.length ? <span className="bar-detail">{msg.detail[0]}</span> : null}
          </span>
        )}
      </div>

      {trainOpen && (
        <TrainPanel
          avatarId={avatarId}
          avatar={avatar}
          state={trainState}
          user={user}
          onClose={() => { setTrainOpen(false); setTrainState(null); }}
          onRecheck={train}
          onSubmitted={() => setTrainState(null)}
        />
      )}

      {zoom && candidates[cursor] && (
        <div className="zoom" onClick={() => setZoom(false)}>
          <img src={candidates[cursor].url} alt="" />
        </div>
      )}
    </>
  );
}

/**
 * What to do when there is nothing to cull.
 *
 * ── This used to print two npm commands ─────────────────────────────────────
 * Which is a developer instruction on a customer-facing screen: a customer has
 * no repository, no GPU and no terminal. The commands were there because the
 * button was not, and the button was not there because generating a pool needs
 * a render path that runs before a LoRA exists — every other still path refuses
 * without one, correctly.
 *
 * So the button now exists, and it says what it costs before it is pressed.
 * Generation is billed by the megapixel out of the monthly still allowance and
 * then out of bought credits, and the amounts are not small: a hundred frames
 * is a hundred megapixels. A button that spends someone's month without saying
 * so first is a button they find out about on an invoice.
 */
function sameOriginUpload(url) {
  try { const u = new URL(url, window.location.origin); return u.pathname.startsWith('/api/studio/') ? u.pathname + u.search : url; } catch { return url; }
}

function TwinSetup({ avatarId, onDone }) {
  const [state, setState] = useState('idle');   // idle | uploading | processing | error
  const [msg, setMsg] = useState(null);
  const fileRef = useRef(null);
  const pollRef = useRef(null);

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  function startPoll() {
    pollRef.current = setInterval(async () => {
      try {
        const st = await get(`/avatars/${avatarId}/twin-status`);
        if (st.state === 'processing') setMsg(st.message || 'Processing…');
        else if (st.state === 'done') { clearInterval(pollRef.current); onDone && onDone(); }
        else if (st.state === 'error') { clearInterval(pollRef.current); setState('error'); setMsg(st.message || 'Could not process the footage'); }
      } catch { /* keep polling */ }
    }, 2500);
  }

  async function process(body, startMsg) {
    setState('processing'); setMsg(startMsg);
    try {
      await post(`/avatars/${avatarId}/twin-material`, body);
      startPoll();
    } catch (err) {
      setState('error'); setMsg(errorText(err, 'Could not start processing.'));
    }
  }

  async function onPick(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    setState('uploading'); setMsg('Uploading your footage…');
    try {
      const target = await post(`/avatars/${avatarId}/upload-target`, {
        filename: file.name || 'footage.mp4', contentType: file.type || 'video/mp4', kind: 'footage',
      });
      const put = await fetch(sameOriginUpload(target.url), { method: 'PUT', headers: target.headers || {}, body: file });
      if (!put.ok) throw new Error(`Upload failed (HTTP ${put.status})`);
      await process({ video_key: target.key }, 'Processing your footage…');
    } catch (err) {
      setState('error'); setMsg(errorText(err, 'Could not upload the footage.'));
    }
  }

  const busy = state === 'uploading' || state === 'processing';
  return (
    <div className="card prof-card" style={{ textAlign: 'left', maxWidth: 640, margin: '18px auto 0' }}>
      <div className="label">Two steps</div>
      <ol className="helper" style={{ paddingLeft: 18, lineHeight: 1.8 }}>
        <li><b>Consent</b> — <Link className="lnk" href={`/avatars/${avatarId}/clone`}>record it on the clone page →</Link></li>
        <li><b>Give it footage to learn from.</b> Upload a video of yourself — ideally a minute of varied,
          front-facing footage (a few angles, distances and expressions) for the best likeness. We check it
          matches your consent video, then build the training set from it.</li>
      </ol>

      <div className="label" style={{ marginTop: 14 }}>For the best likeness, film</div>
      <ul className="helper" style={{ paddingLeft: 18, lineHeight: 1.75, marginTop: 4 }}>
        <li><b>60–90 seconds</b> in good, even light — face a window; avoid backlight and harsh shadows.</li>
        <li><b>Several angles</b> — slowly turn your head: straight on, then left, then right.</li>
        <li><b>A mix of distances</b> — some close (face fills the frame), some at arm&rsquo;s length (head and shoulders).</li>
        <li><b>A few natural expressions</b> — neutral, a smile, talking.</li>
        <li><b>A clear face</b> — hair back, no sunglasses, hat or mask; in focus and steady.</li>
        <li><b>Just you</b> in frame, in the look you want the twin to have — whatever it sees (glasses, hair, outfit) is what it learns.</li>
        <li>Avoid beauty filters, heavy makeup, motion blur and dark rooms.</li>
      </ul>

      <input ref={fileRef} type="file" accept="video/*" style={{ display: 'none' }} onChange={onPick} />
      <div className="btn-row" style={{ marginTop: 12, gap: 10, display: 'flex', flexWrap: 'wrap' }}>
        <Link className="btn sm ghost" href={`/avatars/${avatarId}/clone`}>Capture consent</Link>
        <button type="button" className="btn sm" disabled={busy} onClick={() => fileRef.current && fileRef.current.click()}>
          {busy ? 'Working…' : 'Upload footage'}
        </button>
        <button type="button" className="btn sm ghost" disabled={busy}
          onClick={() => process({ use_consent: true }, 'Building a basic twin from your consent video…')}>
          Use my consent video
        </button>
      </div>
      <p className="helper" style={{ marginTop: 8 }}>
        &ldquo;Use my consent video&rdquo; is the quick path — it trains a basic twin from that single clip.
        A longer, varied video makes a noticeably better one.
      </p>
      {state === 'error'
        ? <p className="lp-msg warn" style={{ marginTop: 10 }}>{msg}</p>
        : msg && <p className="helper adm-ok" style={{ marginTop: 10 }}>{msg}</p>}

      <VoiceClone avatarId={avatarId} />
    </div>
  );
}

/**
 * Clone the twin's VOICE from its consent video (owned, local IndicF5).
 *
 * The consent video is the person reading the consent statement aloud, so it
 * doubles as a clean voice reference. One click extracts that audio and locks
 * the avatar's voice to it — used later for voiceover shoots. Needs a VERIFIED
 * consent record; the backend enforces that and says so if it is missing.
 */
function VoiceClone({ avatarId }) {
  const [state, setState] = useState('idle');   // idle | working | done | error
  const [msg, setMsg] = useState(null);
  async function run() {
    setState('working'); setMsg('Cloning your voice from the consent video…');
    try {
      await post(`/avatars/${avatarId}/voice/clone`, {});
      setState('done'); setMsg('Voice cloned. Voiceover shoots will now speak in your own voice.');
    } catch (err) {
      setState('error'); setMsg(errorText(err, 'Could not clone the voice.'));
    }
  }
  return (
    <div style={{ marginTop: 16, borderTop: '1px solid var(--hair, #e6e2da)', paddingTop: 14 }}>
      <div className="label">Optional · Clone your voice</div>
      <p className="helper">
        Your consent video is you reading a statement aloud, so we can clone your voice straight from it.
        The clone stays on this machine and gives your twin its own voice for voiceovers.
        Verify the consent first (the admin approves it, or the same-person check passes at ingest).
      </p>
      <div className="btn-row" style={{ marginTop: 10 }}>
        <button type="button" className="btn sm" disabled={state === 'working' || state === 'done'} onClick={run}>
          {state === 'working' ? 'Cloning…' : state === 'done' ? 'Voice cloned ✓' : 'Clone my voice'}
        </button>
      </div>
      {state === 'error'
        ? <p className="lp-msg warn" style={{ marginTop: 10 }}>{msg}</p>
        : msg && <p className="helper adm-ok" style={{ marginTop: 10 }}>{msg}</p>}
    </div>
  );
}

function NoFrames({ avatarId, avatar, framesPresent, onQueued, anchored }) {
  // A twin does not GENERATE faces — its training photos come from the person's
  // own footage. So the empty state is a setup panel, not a generate button.
  if (avatar.mode === 'twin') {
    return (
      <>
        <div className="topbar">
          <div className="crumb"><b>{avatar.name}</b><span>·</span><span>Set up your twin</span></div>
          <Steps current="face" avatarId={avatarId} />
        </div>
        <div className="page">
          <div className="empty face-empty">
            <h2>Set up your twin</h2>
            <p>{avatar.name} is a digital twin, so its photos come from a video of the
              real person — nothing is generated. Consent, then ingest your footage,
              and this screen fills with frames to cull.</p>
            <TwinSetup avatarId={avatarId} onDone={onQueued} />
            <p className="helper"><Link className="lnk" href="/avatars">Back to avatars</Link></p>
          </div>
        </div>
      </>
    );
  }
  return (
    <>
      <div className="topbar">
        <div className="crumb"><b>{avatar.name}</b><span>·</span><span>Find the face</span></div>
        <Steps current="face" avatarId={avatarId} />
      </div>

      <div className="page">
        <div className="empty face-empty">
          <h2>{anchored ? 'Now the photo shoot' : 'No photos to choose from yet'}</h2>

          <p>
            {anchored ? (
              <>
                {avatar.name}&rsquo;s face is chosen. Every photo from here is generated
                from that face rather than from the description again, so the pool holds
                together instead of being a room full of people who merely match the words.
              </>
            ) : (
              <>
                {avatar.name} exists and their identity is frozen. The next step is a few
                faces generated from that description — the base model&rsquo;s guesses at
                the person you described. You pick the one that is them, and everything
                afterwards is made from that face.
              </>
            )}
          </p>

          <p className="mono id-preview">{avatar.identity_block}</p>

          {anchored
            ? <Generate avatarId={avatarId} onQueued={onQueued} />
            : <GenerateFaces avatarId={avatarId} onQueued={onQueued} />}

          {framesPresent && (
            <p className="helper">
              There are frames on disk for this avatar that have not been registered.
              Running the local registrar will pick them up along with any older
              cull-state.json.
            </p>
          )}

          <p className="helper">
            Keeping the frames that look like the <b>same person</b> matters more than
            keeping the ones that look best: the mean of what you keep becomes the
            reference every future image is judged against, permanently.{' '}
            <Link className="lnk" href="/avatars">Back to avatars</Link>
          </p>
        </div>
      </div>
    </>
  );
}

/**
 * How many frames, and what that costs.
 *
 * The quote is re-fetched as the number changes, because the answer is not
 * linear: the first frames come out of the monthly allowance and the rest come
 * out of bought credits, so the interesting number — "how much will this
 * actually take from me" — steps rather than scales.
 */
const PRESETS = [24, 48, 80, 120, 200];

function Generate({ avatarId, onQueued }) {
  const [count, setCount] = useState(80);
  const [quote, setQuote] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [queued, setQueued] = useState(null);

  useEffect(() => {
    let live = true;
    // Debounced: the number changes on every keystroke of a typed value, and
    // one request per keystroke would be a request per keystroke.
    const t = setTimeout(async () => {
      try {
        const q = await get(`/avatars/${avatarId}/candidates/quote?count=${count}`);
        if (live) { setQuote(q); setErr(null); }
      } catch (e) { if (live) setErr(errorText(e)); }
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [avatarId, count]);

  async function go() {
    setBusy(true); setErr(null);
    try {
      const out = await post(`/avatars/${avatarId}/candidates/generate`, { count });
      setQueued(out);
      onQueued?.(out);
    } catch (e) {
      setErr(errorText(e));
    } finally { setBusy(false); }
  }

  if (queued) {
    return (
      <div className="lp-msg" role="status">
        <b>{queued.queued} frames queued</b>
        <span>
          They appear on this screen as they finish, usually within a few minutes. You can
          leave and come back — nothing is lost by closing the tab.
        </span>
      </div>
    );
  }

  const short = quote && quote.credits_short > 0;

  return (
    <section className="card prof-card gen-card">
      <div className="plan-head">
        <span className="label">Generate the pool</span>
        {quote && (
          <span className="hint">{quote.min}–{quote.max} frames</span>
        )}
      </div>

      <div className="gen-row">
        {PRESETS.map((n) => (
          <button type="button" key={n}
                  className={`btn ghost sm${count === n ? ' on' : ''}`}
                  onClick={() => setCount(n)}>{n}</button>
        ))}
        <input className="mono gen-count" inputMode="numeric" value={count}
               onChange={(e) => setCount(Math.max(1, Number(e.target.value.replace(/\D/g, '')) || 1))} />
        <span className="helper">frames</span>
      </div>

      {quote && (
        <div className="gen-quote">
          {/* Said in the units the person has, not in megapixels — which is a
              unit nobody has an intuition for until they run out of it. */}
          <div className="gen-line">
            <span>{quote.count} frames</span>
            <b>{quote.megapixels} MP</b>
          </div>
          <div className="gen-line">
            <span>Left in this avatar&rsquo;s allowance</span>
            <b>{quote.from_plan} of {quote.allowance.left}</b>
          </div>
          {quote.overage > 0 && (
            <div className={`gen-line${short ? ' adm-bad' : ''}`}>
              <span>From bought credits</span>
              <b>{quote.credits_needed} of {quote.credits_held} held</b>
            </div>
          )}
          <p className="helper">
            {short
              ? `Short by ${quote.credits_short} credits. Either top up, or generate ${quote.affordable_count} now.`
              : quote.overage > 0
                ? `${quote.allowance.left} left of the ${quote.allowance.included} included with this avatar; `
                  + `the other ${quote.overage} come from credits.`
                : `Within the ${quote.allowance.left} still included with this avatar.`}
          </p>
        </div>
      )}

      {err && <p className="prof-err">{err}</p>}

      <div className="gen-actions">
        <button className="btn" disabled={busy || !quote || short} onClick={go}>
          {busy ? 'Queueing…' : `Generate ${count} frames`}
        </button>
        {short && <Link className="btn ghost" href="/billing">Top up</Link>}
      </div>

      <p className="helper">
        A frame costs the same whether you keep it or not — you are paying for generation,
        not for the ones that survive. Around a quarter usually do.
      </p>
    </section>
  );
}

/**
 * A batch is in flight and nothing has landed yet.
 *
 * The one thing this screen must not do is look like the empty state. Somebody
 * who has just been charged for eighty frames and is shown "no photos to choose
 * from yet" reasonably concludes the money went nowhere.
 */
function Arriving({ avatarId, avatar, generating }) {
  const { user } = useAuth();
  const done = generating.queued - generating.pending;
  const pct = generating.queued ? Math.round((done / generating.queued) * 100) : 0;

  // A running clock, because "a few minutes" with a static zero is
  // indistinguishable from nothing happening — which is exactly what it was.
  const [elapsed, setElapsed] = useState(generating.age_seconds || 0);
  useEffect(() => {
    setElapsed(generating.age_seconds || 0);
    const t = setInterval(() => setElapsed((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [generating.age_seconds]);

  return (
    <>
      <div className="topbar">
        <div className="crumb"><b>{avatar.name}</b><span>·</span><span>Find the face</span></div>
        <Steps current="face" avatarId={avatarId} />
      </div>

      <div className="page">
        <div className="empty face-empty">
          <h2>
            {generating.kind === 'anchor'
              ? `Generating faces for ${avatar.name}`
              : `Generating ${avatar.name}\u2019s photos`}
          </h2>
          <p>
            {generating.kind === 'anchor' ? (
              <>
                {generating.queued} guesses at the description you wrote. In a minute or
                two you pick the one that is them, and the rest of the shoot is generated
                from that face.
              </>
            ) : (
              <>
                {generating.queued} frames, generated from the face you chose. They appear
                here as they finish — usually a few minutes for the whole batch. Nothing is
                lost by closing this tab.
              </>
            )}
          </p>

          <div className="track gen-track">
            <div className="fill" style={{ width: `${Math.max(2, pct)}%` }} />
          </div>
          <p className="helper">
            <b>{done}</b> of {generating.queued} finished · {clock(elapsed)} elapsed
            {generating.failed > 0 && (
              <> · <span className="adm-bad">{generating.failed} failed</span>, and their
              share of the cost has been returned</>
            )}
          </p>

          {generating.stalled && (
            /**
             * Nothing has picked these jobs up.
             *
             * Distinguished from "slow" by the database rather than by a guess:
             * not one of these jobs has ever been claimed, and they are more
             * than two minutes old. A worker that is merely busy would have
             * taken one by now.
             *
             * Said plainly to everybody, because a customer whose photos are
             * not being made deserves to know that rather than watch a zero.
             * The fix is only shown to staff — it is a process on a server, not
             * anything a customer can act on.
             */
            <div className="lp-msg warn" role="alert">
              <b>Nothing has started these yet</b>
              <span>
                The frames are queued but nothing has picked one up in {clock(elapsed)}.
                They are not lost and nothing has been charged twice — they will run as
                soon as a renderer is listening, with no need to queue them again.
                {user?.role === 'admin' && (
                  generating.renderer_ready === false ? (
                    <>
                      {' '}This server is not configured to render: it holds no fal key, so
                      it declined to claim work it could not perform. Set <b>FAL_KEY</b> and
                      restart the API.
                    </>
                  ) : (
                    <>
                      {' '}This server is configured to render and still has not claimed
                      one, so the queue rather than the key is the problem — check the API
                      log, and that <b>STUDIO_CLOUD_RUNNER</b> is not off.
                    </>
                  )
                )}
              </span>
            </div>
          )}

          <p className="helper">
            The first twenty-four frames alone cover every angle, distance and light the
            export gate asks for, so there will be something worth choosing between long
            before the batch finishes.{' '}
            <Link className="lnk" href="/avatars">Back to avatars</Link>
          </p>
        </div>
      </div>
    </>
  );
}

/** m:ss, so a number that is changing looks like one. */
function clock(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Which of these is the person?
 *
 * Asked once, before a pool exists, and it is the most consequential click in
 * the product: every later frame, and the LoRA trained on them, descends from
 * this face. Six independent draws from one description, on a plain ground so
 * what differs between them is the face and not the room.
 */
function ChooseFace({ avatarId, avatar, anchors, reload }) {
  const [picked, setPicked] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  async function choose() {
    if (!picked) return;
    setBusy(true); setErr(null);
    try {
      await post(`/avatars/${avatarId}/anchor`, { candidate_id: picked });
      await reload?.();
    } catch (e) {
      setErr(errorText(e));
      setBusy(false);
    }
  }

  return (
    <>
      <div className="topbar">
        <div className="crumb"><b>{avatar.name}</b><span>·</span><span>Find the face</span></div>
        <Steps current="face" avatarId={avatarId} />
      </div>

      <div className="page">
        <div className="face-head">
          <div>
            <h1>Which of these is {avatar.name}?</h1>
            <p className="hint">
              These are the base model&rsquo;s guesses at the description you wrote. They
              are different people, because a description names a <strong>type</strong> of
              person rather than a person. Pick the one that is them — every photo after
              this is generated from that face, so the rest of the shoot holds together.
            </p>
          </div>
          <div className="face-actions">
            <button className="btn" onClick={choose} disabled={!picked || busy}>
              {busy ? 'Setting the face…' : 'This is them'}
            </button>
          </div>
        </div>

        <div className="grid">
          {anchors.map((a) => (
            <button
              key={a.id}
              className={`cand ${picked === a.id ? 'keep' : ''}`}
              aria-pressed={picked === a.id}
              onClick={() => setPicked(a.id)}
              onDoubleClick={() => { setPicked(a.id); }}
            >
              <img loading="lazy" src={a.url} alt="" />
              {picked === a.id && (
                <span className="cand-mark keep" aria-hidden="true">
                  <svg viewBox="0 0 16 16" width="11" height="11">
                    <path d="M2.5 8.5l3.6 3.6L13.5 4.5" fill="none" stroke="currentColor"
                          strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
              )}
            </button>
          ))}
        </div>

        <p className="helper">
          None of them right? The description is what produced them, so that is what to
          change — <Link className="lnk" href={`/avatars/${avatarId}`}>edit it</Link> and
          generate a new set. Six faces are far cheaper to throw away than a pool is.
        </p>
        {err && <p className="lp-msg crit" role="alert">{err}</p>}
      </div>
    </>
  );
}

/**
 * The faces, before the pool.
 *
 * Its own small component rather than a mode on `Generate`, because the two
 * decisions have nothing in common. This one is "how many guesses do I want to
 * choose between" and the answer is always about six; the other is "how big a
 * pool am I buying" and the answer runs to hundreds.
 */
const FACE_PRESETS = [4, 6, 8];

function GenerateFaces({ avatarId, onQueued }) {
  const [count, setCount] = useState(6);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [queued, setQueued] = useState(null);

  async function go() {
    setBusy(true); setErr(null);
    try {
      const out = await post(`/avatars/${avatarId}/candidates/generate`, { count, kind: 'anchor' });
      setQueued(out);
      onQueued?.(out);
    } catch (e) {
      setErr(errorText(e));
    } finally { setBusy(false); }
  }

  if (queued) {
    return (
      <div className="lp-msg" role="status">
        <b>{queued.queued} faces queued</b>
        <span>They appear here in a minute or two, and then you pick one.</span>
      </div>
    );
  }

  return (
    <section className="card prof-card gen-card">
      <div className="plan-head">
        <span className="label">Generate faces to choose from</span>
        <span className="hint">{count} frames</span>
      </div>

      <div className="gen-row">
        {FACE_PRESETS.map((n) => (
          <button type="button" key={n}
                  className={`btn ghost sm${count === n ? ' on' : ''}`}
                  onClick={() => setCount(n)}>{n}</button>
        ))}
      </div>

      <p className="helper">
        A handful, not a pool. If none of them is the person you had in mind, the
        description is what to change — and finding that out costs {count} frames here
        instead of a few hundred later.
      </p>

      <button className="btn" onClick={go} disabled={busy}>
        {busy ? 'Queueing…' : `Generate ${count} faces`}
      </button>
      {err && <p className="lp-msg crit" role="alert">{err}</p>}
    </section>
  );
}

/**
 * The second press.
 *
 * Everything a person needs before spending $2 on something permanent: whether
 * the set is confidently one person, which frames are not if it is not, and
 * what the run costs — then a button that says what it will do.
 *
 * It is a panel rather than a page because the answer to "these two frames are
 * outliers" is to go and unpick them, which is the grid directly behind it.
 */
function TrainPanel({ avatarId, avatar, state, user, onClose, onRecheck, onSubmitted }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [done, setDone] = useState(null);

  async function confirm() {
    setBusy(true); setErr(null);
    try {
      setDone(await post(`/avatars/${avatarId}/train`));
      /**
       * Drop the last poll's answer.
       *
       * It describes the run that just ended — on a retry, the FAILED one — and
       * the live row wins over the response, so without this the panel would go
       * on saying "Training failed" for the three seconds until the next poll,
       * directly underneath the button that had just worked.
       */
      onSubmitted?.();
    } catch (e) {
      setErr(errorText(e));
    } finally { setBusy(false); }
  }

  const check = state?.check;
  const running = check && ['queued', 'claimed', 'running'].includes(check.status);
  /**
   * In credits, or not at all. Never in dollars.
   *
   * What our renderer charges us is an internal number — it belongs on the job
   * and on the admin screens, not on a customer's button, where it tells them
   * a supplier's price and is not even the number they would pay.
   */
  const price = state?.price;
  const priceLabel = price && !price.included
    ? `${price.credits} credit${price.credits === 1 ? '' : 's'}`
    : null;

  return (
    <div className="zoom train-panel" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <section className="card prof-card train-card">
        <div className="plan-head">
          <span className="label">Train {avatar.name}</span>
          <button className="btn ghost sm" onClick={onClose}>Close</button>
        </div>

        {done || state?.training ? (
          /**
           * What the run is actually doing.
           *
           * This used to say "Training queued as version 1" and then say it
           * forever, whether the run was working, finished, or had failed
           * twenty seconds later — a dead end of exactly the kind a queued
           * candidate batch used to be. The answer comes from the job row now,
           * so it keeps arriving.
           */
          <TrainingRun
            run={state?.training}
            queued={done}
            user={user}
            busy={busy}
            onRetry={confirm}
            versions={state?.versions}
            calibration={state?.calibration}
            onChanged={onSubmitted}
          />
        ) : !state ? (
          <p className="helper">Checking…</p>
        ) : state.gate && !state.gate.ok ? (
          <>
            <p className="lp-msg crit" role="alert">{state.gate.error}</p>
            {state.gate.gaps?.length ? <p className="helper">{state.gate.gaps[0]}</p> : null}
          </>
        ) : state.stale ? (
          <>
            <p>The kept photos changed after the last check.</p>
            <p className="helper">
              The check measures the exact set it was given. Training on the old
              measurement would write a reference from photos you have since unpicked.
            </p>
            <button className="btn" onClick={onRecheck}>Check again</button>
          </>
        ) : check?.stalled ? (
          <>
            <div className="lp-msg warn" role="alert">
              <b>Nothing has started the check</b>
              <span>
                It has been queued for {clock(check.age_seconds)} and nothing has picked it
                up. Nothing is lost — it runs as soon as something is listening.
                {user?.role === 'admin' && (
                  check.can_measure_here === false ? (
                    <>
                      {' '}This server cannot measure faces{check.why_not ? ` — ${check.why_not}` : ''}.
                      Install insightface where the API runs, or run the render worker on a
                      machine that has it.
                    </>
                  ) : (
                    <>
                      {' '}This server can measure faces and still has not claimed it, so the
                      queue rather than the dependency is the problem — check the API log,
                      and that <b>STUDIO_EMBED_RUNNER</b> is not off.
                    </>
                  )
                )}
              </span>
            </div>
          </>
        ) : check?.status === 'failed' ? (
          <>
            <p className="lp-msg crit" role="alert">{check.error || 'The check failed.'}</p>
            <p className="helper">
              Unpick the frames it names and check again — a frame with no detectable face,
              or with two faces in it, cannot go in a seed set.
            </p>
            <button className="btn ghost" onClick={onRecheck}>Check again</button>
          </>
        ) : running || !state.coherence ? (
          <p className="helper">
            Measuring {state.gate?.count} faces{check ? ` · ${clock(check.age_seconds)}` : ''}…
          </p>
        ) : !state.coherence.coherent ? (
          <>
            <p><b>{state.coherence.outliers.length} of {state.gate.count}</b> are not confidently the same person.</p>
            <ul className="helper train-outliers">
              {state.coherence.outliers.map((o) => (
                <li key={o.filename} className="mono">
                  {o.filename}{typeof o.similarity === 'number' ? ` · ${o.similarity.toFixed(3)}` : ''}
                </li>
              ))}
            </ul>
            <p className="helper">
              This is the check worth failing. A striking frame that is subtly a different
              face is worse than a dull one that is unmistakably them — the mean of this set
              is the reference for every photo they ever make.
            </p>
            <button className="btn ghost" onClick={onClose}>Go and unpick them</button>
          </>
        ) : (
          <>
            <p>
              <b>{state.gate.count} photos</b>, all confidently the same person
              {typeof state.coherence.minimum === 'number'
                ? ` — the least similar sits at ${state.coherence.minimum.toFixed(3)}`
                : ''}.
            </p>
            <p className="helper">
              Training takes about twenty minutes.{' '}
              {price?.included
                ? 'It is included with this avatar, and so is retraining — the moment you need a second run is usually the moment a first seed set turned out to need re-culling.'
                : `It costs ${priceLabel}.`}
              {' '}It cannot be undone: this set becomes the reference every future photo is
              judged against.
              {state.versions > 0 && ` This avatar already has ${state.versions} version(s); this makes another.`}
            </p>
            <button className="btn" onClick={confirm} disabled={busy}>
              {busy ? 'Submitting…' : (priceLabel ? `Train — ${priceLabel}` : 'Train')}
            </button>
          </>
        )}

        {err && <p className="lp-msg crit" role="alert">{err}</p>}
      </section>
    </div>
  );
}

/** A training run, from queued to a model that exists. */
function TrainingRun({ run, queued, user, busy, onRetry, versions, calibration, onChanged }) {
  const version = run?.version ?? queued?.version;

  if (!run) {
    return (
      <>
        <p><b>Training queued</b>{version ? ` as version ${version}` : ''}.</p>
        <p className="helper">Picking it up…</p>
      </>
    );
  }

  if (run.status === 'failed') {
    return (
      <>
        <p><b>Training failed</b>{version ? ` on version ${version}` : ''}.</p>
        <div className="lp-msg crit" role="alert">
          <span>{run.error || 'No reason was recorded.'}</span>
        </div>
        <p className="helper">
          Nothing was charged for a run that did not produce a model, and the seed set is
          untouched. The photos you kept are still kept and still checked, so this starts
          again from where it was.
        </p>
        {/* The button the sentence above used to name and not provide. */}
        <button className="btn" onClick={onRetry} disabled={busy}>
          {busy ? 'Submitting…' : 'Train again'}
        </button>
      </>
    );
  }

  if (run.status === 'done') {
    /**
     * A finished job is not the same as a model.
     *
     * The version on screen comes off the JOB's payload — the number the run
     * was going to write — not off a row in `avatar_loras`. Recording happens
     * after the job completes and outside its transaction, deliberately, so a
     * failure there leaves a run that succeeded, cost money, and produced
     * nothing findable. That has happened here before: calibration reported
     * "no trained LoRAs" about a run that worked and billed $2.
     *
     * So the screen counts models, not jobs.
     */
    if (versions === 0) {
      return (
        <>
          <p><b>Training finished, but no model was saved.</b></p>
          <div className="lp-msg crit" role="alert">
            <span>
              The run completed and then failed to record what it produced, so there is
              nothing to calibrate or activate. Nothing further has been charged.
            </span>
          </div>
          <button className="btn" onClick={onRetry} disabled={busy}>
            {busy ? 'Submitting…' : 'Train again'}
          </button>
        </>
      );
    }
    return (
      <>
        <p><b>Trained</b>{version ? ` — version ${version}` : ''}.</p>
        <p className="helper">
          The model lands <b>inactive</b> on purpose: calibration is what decides the
          likeness thresholds every future photo is judged against, and activating before
          that would judge them against a permissive floor.
        </p>
        {/* The step that sentence names. It used to name it and stop there. */}
        <Calibration state={calibration} user={user} onChanged={onChanged} />
      </>
    );
  }

  if (run.abandoned) {
    /**
     * Claimed, then whatever held it stopped — a restarted server, usually.
     *
     * The row still says `running`, which is why this needs saying: from the
     * outside a job nobody is working on looks exactly like one that is, and
     * the screen was counting upward past the time it had promised.
     */
    return (
      <>
        <p><b>Training stopped</b>{version ? ` on version ${version}` : ''}.</p>
        <div className="lp-msg warn" role="status">
          <b>Picking it up again</b>
          <span>
            Whatever was running it stopped reporting — usually a restarted server. It goes
            back on the queue within a minute and starts over.
            {run.attempts >= 3 && ' This was the last attempt, so it will be marked failed instead.'}
          </span>
        </div>
      </>
    );
  }

  if (run.stalled) {
    return (
      <>
        <p><b>Training queued</b>{version ? ` as version ${version}` : ''}.</p>
        <div className="lp-msg warn" role="alert">
          <b>Nothing has started it</b>
          <span>
            Queued for {clock(run.age_seconds)} with nothing picking it up. It is not lost
            and nothing has been charged.
            {user?.role === 'admin' && (
              run.renderer_ready === false
                ? ' This server holds no fal key, so it declined to claim work it could not perform.'
                : ' This server can render and still has not claimed it — check the API log.'
            )}
          </span>
        </div>
      </>
    );
  }

  return (
    <>
      <p>
        <b>{run.status === 'running' ? 'Training' : 'Training queued'}</b>
        {version ? ` — version ${version}` : ''} · {clock(run.running_seconds || run.age_seconds)}
      </p>
      <p className="helper">
        {(run.running_seconds || 0) > 25 * 60
          /* Twenty minutes is the usual case, not a promise. Repeating it at
             thirty-three is the screen insisting on something the person can
             see is not true. */
          ? 'This is longer than usual — most runs finish inside twenty minutes. It has not been forgotten: if whatever is running it stops reporting, it goes back on the queue by itself.'
          : 'It takes roughly twenty minutes.'}
        {' '}Nothing else needs doing, and closing this does not stop it — the model lands
        inactive, and calibration is the step after this.
        {run.attempts > 1 && ` Attempt ${run.attempts}.`}
      </p>
    </>
  );
}

/**
 * Calibration, on the same screen as the thing it follows.
 *
 * ── Why it is not its own page ──────────────────────────────────────────────
 * It is one step of setting an avatar up, and it happens once. A page would
 * mean a route somebody has to find, and the only way to find it is from here —
 * which makes it a link that goes somewhere to press a button, rather than a
 * button.
 *
 * ── What it is for, in a sentence the customer can hold ─────────────────────
 * A crying face legitimately looks less like the reference than a neutral one:
 * the geometry moved. Judge both against one number and the gate silently eats
 * every emotional photo, and the conclusion is "the model can't do crying"
 * when the truth is the gate was never told what crying looks like. So the
 * model takes a few photos of each expression and measures how far each one
 * moves. None of that belongs on screen in those words — "it learns what each
 * expression should look like" is the same fact and is the one that fits.
 *
 * ── The rule every state here obeys ─────────────────────────────────────────
 * Nothing is remembered from a button press. Every state below is read from
 * `state`, which is read from rows, because the bug this screen has had four
 * times is a panel that says what it was told at the moment of the click and
 * goes on saying it after the world moves.
 */
function Calibration({ state, user, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  async function act(path) {
    setBusy(true); setErr(null);
    try {
      await post(path);
      onChanged?.();
    } catch (e) {
      setErr(errorText(e));
    } finally { setBusy(false); }
  }

  if (!state) return null;

  const failure = err ? <p className="lp-msg crit" role="alert">{err}</p> : null;

  /**
   * The price, in credits, never in what our supplier charges.
   *
   * Read off the status rather than computed here — the rate card is the only
   * thing that decides a price, and a screen that does its own arithmetic is a
   * screen that disagrees with the bill.
   */
  const price = state.price;
  const priceLabel = price && price.credits > 0
    ? `${price.credits} credit${price.credits === 1 ? '' : 's'}`
    : null;
  const short = price && !price.affordable
    ? (
      <div className="lp-msg warn" role="alert">
        <b>{price.short} credits short</b>
        <span>
          Calibrating the {state.missing?.length === 1 ? 'remaining expression' : `remaining ${state.missing?.length} expressions`}
          {' '}takes {price.credits} credits and you hold {price.held}. Credits arrive with your
          plan each month, and you can top up if you would rather not wait.
        </span>
      </div>
    )
    : null;

  if (state.active) {
    return (
      <div className="lp-msg ok" role="status">
        <b>Ready to shoot</b>
        <span>
          Version {state.version} is live and every photo it makes is checked against what
          calibration measured.
        </span>
      </div>
    );
  }

  if (state.state === 'blocked') {
    return (
      <div className="lp-msg crit" role="alert">
        <b>Cannot calibrate this model</b>
        <span>{state.why}</span>
      </div>
    );
  }

  if (state.state === 'ready') {
    return (
      <>
        <div className="lp-msg ok" role="status">
          <b>Measured</b>
          <span>
            {state.measured} of {state.measurable} expressions are calibrated. Turning the
            model on is the last step — after it, shoots use this face.
          </span>
        </div>
        {failure}
        <button className="btn" onClick={() => act(`/loras/${state.lora_id}/activate`)} disabled={busy}>
          {busy ? 'Turning on…' : 'Turn this model on'}
        </button>
      </>
    );
  }

  if (state.state === 'working') {
    const f = state.frames || {};
    /**
     * Counted, not spun at.
     *
     * "Working…" for eight minutes is the same dead end as "Training queued"
     * was: true, useless, and indistinguishable from broken. A number that
     * moves is the difference.
     */
    return (
      <>
        <p>
          <b>Calibrating</b> — {f.done} of {f.total} photos
          {state.measurements?.pending ? `, measuring ${state.measurements.pending}` : ''}.
        </p>
        {/* `.track`/`.fill` only, never wrapped in `.meter` — that class is the
            sidebar's own frame (a top border, page padding, margin-top:auto)
            and borrowing it here drags all three in. */}
        <div className="track" style={{ margin: '8px 0 6px' }}>
          <div className="fill" style={{ width: `${Math.round(100 * (f.done || 0) / (f.total || 1))}%` }} />
        </div>
        <p className="helper">
          It takes a few minutes. Nothing else needs doing and closing this does not stop
          it — the photos are taken, then each expression is measured once.
        </p>
        {f.stalled && (
          <div className="lp-msg warn" role="alert">
            <b>Nothing has started it</b>
            <span>
              Queued for {clock(f.age_seconds)} with nothing picking it up. Nothing is lost
              and nothing has been charged.
            </span>
          </div>
        )}
        {state.can_measure_here === false && user?.role === 'admin' && (
          <div className="lp-msg warn" role="alert">
            <b>The photos are taken and nothing can measure them</b>
            <span>
              This server cannot measure faces{state.why_not ? ` — ${state.why_not}` : ''}.
              Install insightface where the API runs, or run the render worker on a machine
              that has it. The photos are kept; measuring resumes on its own.
            </span>
          </div>
        )}
      </>
    );
  }

  /**
   * Not started, or started and short.
   *
   * Both end at the same button, and the difference is what is said above it —
   * which is why they are one branch rather than two nearly identical ones.
   */
  const started = state.state === 'incomplete';
  return (
    <>
      {started ? (
        <>
          <p><b>{state.measured} of {state.measurable} expressions measured.</b></p>
          {state.unmeasurable?.length ? (
            <div className="lp-msg warn" role="alert">
              <b>{state.unmeasurable.length} could not be measured</b>
              <span>
                {state.unmeasurable.map((u) => u.preset_key).join(', ')} — not enough of the
                photos had a usable face. More photos of those expressions is the fix.
              </span>
            </div>
          ) : null}
          <p className="helper">
            The model stays off until every expression has been measured: an unmeasured one
            would be judged against a permissive floor, which is the gate not doing its job
            rather than the gate being lenient.
          </p>
        </>
      ) : (
        <p className="helper">
          Calibration teaches the likeness check what each expression should look like. A
          laughing photo genuinely resembles the reference less than a calm one — without
          this, the check quietly rejects the most expressive photos and the model looks
          worse than it is. It takes {price?.frames ?? 'a few dozen'} photos and a few minutes.
        </p>
      )}
      {short}
      {failure}
      <button
        className="btn"
        onClick={() => act(`/loras/${state.lora_id}/calibration/run`)}
        disabled={busy || (price && !price.affordable)}
      >
        {busy
          ? 'Starting…'
          /* The price goes ON the button. Somebody about to spend credits should
             not have to read a paragraph to find out how many. */
          : `${started ? 'Take more photos' : 'Calibrate'}${priceLabel ? ` — ${priceLabel}` : ''}`}
      </button>
    </>
  );
}
