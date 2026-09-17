'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { post, errorText } from '../../../lib/api';

/**
 * Extract a format (T31) — describe a reel/short/post format you like and get a
 * reusable template structure you can apply to your own avatar. Structure only:
 * it reads YOUR description, never the original's footage/audio/brand.
 */

const KINDS = [
  { key: 'reel', label: 'Reel' },
  { key: 'short', label: 'Short' },
  { key: 'post', label: 'Post' },
  { key: 'carousel', label: 'Carousel' },
];

export default function ExtractFormatPage() {
  const router = useRouter();
  const [description, setDescription] = useState('');
  const [kind, setKind] = useState('reel');
  const [clip, setClip] = useState(5);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [tpl, setTpl] = useState(null);   // extracted, unsaved
  const [saved, setSaved] = useState(false);

  const motion = kind === 'reel' || kind === 'short';

  async function runExtract() {
    setBusy(true); setErr(null); setSaved(false); setTpl(null);
    try {
      const r = await post('/templates/extract', { description: description.trim(), kind, clip_seconds: clip });
      setTpl(r.template);
    } catch (e) { setErr(errorText(e, 'Could not extract the format.')); }
    finally { setBusy(false); }
  }

  async function save() {
    setBusy(true); setErr(null);
    try {
      await post('/templates', { name: tpl.name, category: tpl.category, kind: tpl.kind, recipe: tpl.recipe });
      setSaved(true);
    } catch (e) { setErr(errorText(e, 'Could not save the template.')); }
    finally { setBusy(false); }
  }

  const shots = (tpl && tpl.recipe && tpl.recipe.shots) || [];

  return (
    <div className="page prof">
      <h1>Extract a format</h1>
      <p className="hint prof-deck">
        Describe a reel or post format you like — the beats, the pacing, the hook — and we&rsquo;ll turn it into a
        reusable template you can shoot with your own avatar. It reads only your description; nothing is downloaded,
        and no footage, audio or brand is copied.
      </p>

      <section className="card prof-card" style={{ maxWidth: 680 }}>
        <div className="label">Describe the format</div>
        <label className="field">
          <span className="field-label">What happens, beat by beat?</span>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={6}
            placeholder="e.g. A get-ready-with-me: starts bare-faced with a hook to camera, quick cuts through each step in soft window light, ends on a confident close-up. Upbeat, first-person captions." />
        </label>
        <div className="btn-row" style={{ gap: 10, flexWrap: 'wrap', marginTop: 10 }}>
          <label className="field" style={{ maxWidth: 180 }}>
            <span className="field-label">Format</span>
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              {KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
            </select>
          </label>
          {motion && (
            <label className="field" style={{ maxWidth: 150 }}>
              <span className="field-label">Seconds / beat</span>
              <input type="number" min={2} max={10} value={clip} onChange={(e) => setClip(Number(e.target.value) || 5)} />
            </label>
          )}
        </div>
        {err && <p className="lp-msg warn" style={{ marginTop: 10 }}>{err}</p>}
        <div className="btn-row" style={{ marginTop: 12 }}>
          <button type="button" className="btn" disabled={busy || description.trim().length < 12} onClick={runExtract}>
            {busy && !tpl ? 'Extracting…' : 'Extract the format'}
          </button>
          <Link className="btn sm ghost" href="/templates">My templates</Link>
        </div>
      </section>

      {tpl && (
        <section className="card prof-card" style={{ maxWidth: 680, marginTop: 16 }}>
          <div className="label">Extracted template</div>
          <label className="field">
            <span className="field-label">Name</span>
            <input value={tpl.name} onChange={(e) => setTpl({ ...tpl, name: e.target.value })} />
          </label>
          <p className="helper" style={{ marginTop: 6 }}>
            <b>{tpl.kind}</b> · {tpl.category.replace('_', ' ')} · {tpl.frame_count} shot{tpl.frame_count === 1 ? '' : 's'}
          </p>
          {tpl.recipe.brief.concept && <p className="helper">{tpl.recipe.brief.concept}</p>}
          {tpl.recipe.brief.hook && <p className="helper"><b>Hook:</b> {tpl.recipe.brief.hook}</p>}

          <div className="label" style={{ marginTop: 12 }}>The beats</div>
          <ol className="helper" style={{ paddingLeft: 18, lineHeight: 1.7 }}>
            {shots.map((s, i) => (
              <li key={i}><b>{s.framing}</b> · {s.expression_key}{s.pose_key ? ` — ${s.pose_key}` : ''}</li>
            ))}
          </ol>

          {saved ? (
            <p className="helper adm-ok" style={{ marginTop: 12 }}>
              Saved ✓ — find it under <Link className="lnk" href="/templates">My templates</Link> and apply it to any avatar.
            </p>
          ) : (
            <div className="btn-row" style={{ marginTop: 12 }}>
              <button type="button" className="btn" disabled={busy} onClick={save}>
                {busy ? 'Saving…' : 'Save to my templates'}
              </button>
              <button type="button" className="btn sm ghost" disabled={busy} onClick={runExtract}>Re-extract</button>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
