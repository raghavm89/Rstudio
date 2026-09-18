'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * The plate — one component, two pages.
 *
 * A lit frame carrying crop marks, film grain, a roll counter and a slate. On
 * the landing page it is the hero; on the sign-in page it is the left half. It
 * is shared rather than copied because the two would otherwise drift: someone
 * improves the lighting on the home page, the sign-in page keeps the old one,
 * and a person moving between them sees two products.
 *
 * ── Two states, both finished ───────────────────────────────────────────────
 * With `assets` it plays real generated footage. Without, it draws a lit empty
 * frame that re-lights every few seconds. The second is not a placeholder — it
 * is what these pages look like before `studio/hero-assets.js` has been run, and
 * both are meant to be shippable.
 *
 * The grain, vignette, marks and slate sit OVER the footage rather than instead
 * of it. They are not decoration on top of a video; they are the reason a
 * generated frame reads as photographed, which is the same argument the look
 * screen makes about visible pores.
 */

const SETUPS = [
  { framing: 'Close · 85mm', light: 'Soft key, camera left', grade: 'Warm', tc: '00:00:04:12' },
  { framing: 'Medium · 50mm', light: 'Window, camera right', grade: 'Neutral', tc: '00:01:18:03' },
  { framing: 'Full · 35mm', light: 'Late afternoon, backlit', grade: 'Warm', tc: '00:02:47:21' },
];

/**
 * How long the loop dissolve takes. Kept in step with the CSS transition on
 * .lp-plate-video — the JS decides when to start the fade, the CSS performs it,
 * and if the two disagree the swap lands early and you see the cut this exists
 * to hide.
 */
const FADE_MS = 600;

export default function Plate({ assets = null, caption = true, className = '', label = 'Aanya Kapoor, generated — one take' }) {
  const [frame, setFrame] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  // A clip that cannot decode leaves a black rectangle where the picture should
  // be — a browser build without an H.264 decoder, a proxy mangling the range
  // request, a corrupt upload. Falling back to the drawn plate means the worst
  // case is the version we already consider shippable rather than a hole.
  const [failed, setFailed] = useState(false);

  /**
   * Two clips, cross-dissolved at the loop point.
   *
   * A generated clip almost never ends where it began. Hers ends mid-laugh and
   * restarts on a closed-mouth neutral face; the sign-in clip ends with her
   * close to camera and restarts with her further away, so she appears to
   * teleport backwards. A native `loop` cuts hard between those frames every
   * five seconds, and people read that as a broken page without being able to
   * say why.
   *
   * The prompt cannot fix it — "settles back to how she started" was ignored,
   * and so was "closed-mouth". So the player fixes it instead, which also means
   * it is fixed for every clip Studio ever generates rather than for this one.
   *
   * `front` is the element on top. As it nears the end, the other starts from
   * zero UNDERNEATH at full opacity and the front fades out over it. Fading one
   * layer over an opaque one avoids the luminance dip you get from fading both
   * to 50% at once.
   */
  const vidA = useRef(null);
  const vidB = useRef(null);
  const [front, setFront] = useState(0);
  const [frontVisible, setFrontVisible] = useState(true);
  /**
   * Off until the clip proves it can support it.
   *
   * Requires a finite duration longer than two fades, and readyState >= 3 —
   * which also means the file is buffered, so starting the second element reads
   * from cache instead of pulling the clip down a second time. Until then the
   * plain `loop` attribute behaves exactly as it does today, so the worst case
   * is the version already shipping rather than a video that plays once and
   * stops.
   */
  const [xfade, setXfade] = useState(false);

  /**
   * Reduced motion, read at runtime rather than assumed.
   *
   * Defaults to false because `window` does not exist during the server render
   * and this is a server component's child; the effect corrects it on the first
   * client pass, before autoplay has done anything worth undoing.
   *
   * A cross-dissolving autoplay video is close to the definition of what this
   * setting is asking us not to do, so with it on the plate shows the poster —
   * a real photograph, not a blank — and no video element is mounted at all.
   */
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const onChange = (e) => setReduced(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const hasFootage = Boolean(assets?.video) && !failed;
  const stillOnly  = hasFootage && reduced;
  const live = hasFootage && !reduced;
  // A hero with a poster but no clip (e.g. a still-only showcase set) still shows
  // its photograph, not the empty drawn plate.
  const posterOnly = !hasFootage && Boolean(assets && assets.poster);

  useEffect(() => {
    if (hasFootage) return;
    if (reduced) return;
    const id = setInterval(() => setFrame((f) => (f + 1) % SETUPS.length), 4000);
    return () => clearInterval(id);
  }, [hasFootage, reduced]);

  // Turn the crossfade on only once the clip can actually carry one.
  useEffect(() => {
    if (!live) return;
    const el = vidA.current;
    if (!el) return;
    const consider = () => {
      const d = el.duration;
      if (Number.isFinite(d) && d > (FADE_MS / 1000) * 2 && el.readyState >= 3) setXfade(true);
    };
    consider();
    el.addEventListener('loadedmetadata', consider);
    el.addEventListener('canplaythrough', consider);
    return () => {
      el.removeEventListener('loadedmetadata', consider);
      el.removeEventListener('canplaythrough', consider);
    };
  }, [live]);

  // The dissolve itself.
  useEffect(() => {
    if (!live || !xfade) return;
    const els = [vidA.current, vidB.current];
    const cur = els[front];
    const other = els[1 - front];
    if (!cur || !other) return;

    let swapped = false;
    let timer = null;

    const onTime = () => {
      if (swapped) return;
      const d = cur.duration;
      if (!Number.isFinite(d)) return;
      if (d - cur.currentTime > FADE_MS / 1000) return;

      swapped = true;
      try { other.currentTime = 0; } catch { /* not seekable yet */ }
      const started = other.play();
      // If the browser refuses the second play — an autoplay policy we did not
      // anticipate — give up on the effect rather than leave a frozen frame:
      // `xfade` false restores the native loop, cut and all.
      if (started && started.catch) started.catch(() => setXfade(false));

      setFrontVisible(false);
      timer = setTimeout(() => {
        cur.pause();
        try { cur.currentTime = 0; } catch { /* ignore */ }
        setFront((f) => 1 - f);
        setFrontVisible(true);
      }, FADE_MS);
    };

    cur.addEventListener('timeupdate', onTime);
    return () => {
      cur.removeEventListener('timeupdate', onTime);
      if (timer) clearTimeout(timer);
    };
  }, [live, xfade, front]);

  // A timecode off the real video clock. Small, but a counter ticking in step
  // with the picture is the difference between a camera and a decoration of one.
  // Reads from whichever element is currently front, or it would freeze at the
  // first swap.
  useEffect(() => {
    if (!live) return;
    const el = [vidA.current, vidB.current][front];
    if (!el) return;
    const tick = () => setElapsed(el.currentTime || 0);
    el.addEventListener('timeupdate', tick);
    return () => el.removeEventListener('timeupdate', tick);
  }, [live, front]);

  const s = SETUPS[frame];

  return (
    <div className={`lp-plate-col ${className}`}>
      {/* `hasFootage`, not `live`: the reduced-motion still is a real frame of
          the real clip, and keying the class to `live` would put the drawn
          plate's backdrop and heavier grain behind an actual photograph. */}
      <figure className={`lp-plate ${hasFootage || posterOnly ? 'has-footage' : ''}`} data-frame={frame + 1}>
        {(stillOnly || posterOnly) ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="lp-plate-video" src={assets.poster} alt={label} />
        ) : live ? (
          [vidA, vidB].map((ref, i) => (
            <video
              key={i}
              ref={ref}
              className="lp-plate-video"
              src={assets.video}
              // Only the first carries the poster and autoplays. The second is
              // preload="none" so it costs nothing until its first turn, by
              // which point the file is buffered and it loads from cache — the
              // clip is not pulled down twice on a mobile connection in India.
              poster={i === 0 ? assets.poster : undefined}
              autoPlay={i === 0}
              muted
              // Native looping is the fallback, so it is on until the crossfade
              // takes over — and on BOTH, so disabling the effect mid-cycle
              // cannot leave whichever element is playing frozen on its last
              // frame.
              loop={!xfade}
              playsInline
              preload={i === 0 ? 'metadata' : 'none'}
              style={{
                zIndex: front === i ? 2 : 1,
                opacity: front === i && !frontVisible ? 0 : 1,
              }}
              onError={i === 0 ? () => setFailed(true) : undefined}
              aria-label={i === 0 ? label : undefined}
              aria-hidden={i === 0 ? undefined : true}
            />
          ))
        ) : (
          <div className="lp-lights">
            <div className="lp-light lp-key" />
            <div className="lp-light lp-fill" />
            <div className="lp-light lp-rim" />
          </div>
        )}

        <div className="lp-plate-grain" />
        <div className="lp-plate-vig" />
        <div className="lp-marks"><span /><span /><span /><span /></div>

        <div className="lp-slate-top">
          <span className="rec">Roll 01 · Take {String(hasFootage ? 1 : frame + 1).padStart(2, '0')}</span>
          {/* The timecode ticks only when something is actually playing. On the
              reduced-motion still it is frozen at the poster's own position,
              which is 0 — a stopped clock over a stopped picture is honest;
              the drawn plate's invented timecode over a real photograph is not. */}
          <span>{hasFootage ? timecode(live ? elapsed : 0) : s.tc}</span>
        </div>

        <figcaption className="lp-slate">
          <span>{hasFootage ? captionFor(assets) : `${s.framing} · ${s.grade}`}</span>
          {/* A likeness score appears only when the manifest carries one, which
              happens after calibration has actually measured frames against
              baselines. Otherwise: generation metadata, which is true. A number
              invented for a screenshot is worth nothing. */}
          {assets?.qc?.score
            ? <span className="qc">Looks like them · {assets.qc.score}</span>
            : <span className="meta">{hasFootage ? `${assets.resolution} · ${assets.seconds}s` : 'Likeness check'}</span>}
        </figcaption>
      </figure>

      {caption && (
        <div className="lp-plate-cap">
          <span>{hasFootage ? 'Generated · one continuous take' : s.light}</span>
          {!hasFootage && (
            <span className="lp-ticks" aria-hidden="true">
              {SETUPS.map((_, i) => <i key={i} className={i === frame ? 'on' : ''} />)}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** Frames and seconds, the way a slate reads it. 24fps, because the clip is. */
export function timecode(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(Math.floor(s % 60)).padStart(2, '0');
  const ff = String(Math.floor((s % 1) * 24)).padStart(2, '0');
  return `00:${mm}:${ss}:${ff}`;
}

function captionFor(assets) {
  const bits = ['Medium · 85mm', 'Warm'];
  if (assets.seed != null) bits.push(`Seed ${assets.seed}`);
  return bits.join(' · ');
}
