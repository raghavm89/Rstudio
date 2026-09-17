'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { post, errorText } from '../../lib/api';
import { useResource, Resource } from '../../components/Guard';

/**
 * Talking head (T30, Phase 1) — a clip of an avatar speaking to camera.
 *
 * A friendly front for a single-scene, scripted, lip-synced reel: pick an
 * avatar, write what it should say, choose the lipsync quality, and the pipeline
 * runs still -> motion -> voice -> lipsync (relip the clip to the voice). The
 * avatar needs a locked voice for the audio; the backend enforces it.
 */

const TIERS = [
  { key: 'budget',  label: 'Budget',  note: 'LatentSync · fastest · 6 credits' },
  { key: 'premium', label: 'Premium', note: 'Sync v2 · sharper · 35 credits' },
  { key: 'max',     label: 'Max',     note: 'VEED · best · 48 credits' },
];

export default function TalkingHeadPage() {
  const avatars = useResource('/avatars');
  const router = useRouter();

  const [avatarId, setAvatarId] = useState('');
  const [script, setScript] = useState('');
  const [tier, setTier] = useState('budget');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const ready = avatarId && script.trim().length >= 4 && !busy;

  async function submit() {
    setBusy(true); setErr(null);
    try {
      const res = await post('/shoots', {
        avatar_id: Number(avatarId),
        kind: 'reel',
        frame_count: 1,
        brief: {
          concept: 'Speaking directly to camera, warm and natural, front-facing portrait',
          script: script.trim(),
          lipsync: true,
          lipsync_tier: tier,
        },
      });
      const id = res?.project?.id || res?.project_id || res?.id;
      if (id) router.push(`/shoots/${id}`);
      else setErr('Started, but no shoot id came back — check your Shoots.');
    } catch (e) {
      setErr(errorText(e, 'Could not start the talking head.'));
    } finally { setBusy(false); }
  }

  return (
    <div className="page prof">
      <h1>Talking head</h1>
      <p className="hint prof-deck">
        Make a clip of your avatar speaking to camera. Pick an avatar with a locked voice, write the script,
        and we lip-sync it to the voiceover. You&rsquo;ll approve the frame first, then it renders.
      </p>

      <Resource state={avatars}>
        {(d) => {
          const list = d.avatars || d || [];
          if (!list.length) {
            return <p className="lp-msg warn">No avatars yet. <Link className="lnk" href="/avatars">Create one first →</Link></p>;
          }
          return (
            <section className="card prof-card" style={{ maxWidth: 640 }}>
              <div className="label">1 · Avatar</div>
              <label className="field">
                <span className="field-label">Who&rsquo;s talking</span>
                <select value={avatarId} onChange={(e) => setAvatarId(e.target.value)}>
                  <option value="">Choose an avatar…</option>
                  {list.map((a) => (
                    <option key={a.id} value={a.id}>{a.name}{a.voice_id ? ' · voice ✓' : ' · no voice yet'}</option>
                  ))}
                </select>
              </label>
              <p className="helper">A talking head needs a locked voice — pick one that shows “voice ✓”, or set a voice on the avatar first.</p>

              <div className="label" style={{ marginTop: 16 }}>2 · Script</div>
              <label className="field">
                <span className="field-label">What should it say?</span>
                <textarea value={script} onChange={(e) => setScript(e.target.value)} rows={5}
                  placeholder="Namaste! Aaj main aapko dikhati hoon…" />
              </label>

              <div className="label" style={{ marginTop: 16 }}>3 · Lip-sync quality</div>
              <div className="btn-row" style={{ gap: 10, flexWrap: 'wrap' }}>
                {TIERS.map((t) => (
                  <button type="button" key={t.key}
                    className={`btn sm ${tier === t.key ? '' : 'ghost'}`}
                    onClick={() => setTier(t.key)} title={t.note}>
                    {t.label}
                  </button>
                ))}
              </div>
              <p className="helper">{TIERS.find((t) => t.key === tier)?.note}</p>

              {err && <p className="lp-msg warn" style={{ marginTop: 12 }}>{err}</p>}

              <div className="btn-row" style={{ marginTop: 16 }}>
                <button type="button" className="btn" disabled={!ready} onClick={submit}>
                  {busy ? 'Starting…' : 'Make the talking head'}
                </button>
                <Link className="btn sm ghost" href="/shoots">My shoots</Link>
              </div>
            </section>
          );
        }}
      </Resource>
    </div>
  );
}
