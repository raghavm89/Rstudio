'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { get, post, errorText } from '../../../../lib/api';

/**
 * Clone consent capture — the hosted flow the twin path was stubbed on.
 *
 * A twin depicts a real person, so before training we record that person's
 * consent (name + a short spoken-consent video). The same-person check — that
 * the person consenting IS the person in the training footage — runs at INGEST
 * time (consent video vs the uploaded footage), which is the only comparison
 * that actually means anything. So this page just records consent; ingest
 * verifies it.
 *
 * The statement below is a PLACEHOLDER pending the Indian-lawyer sign-off (T13).
 */

// Placeholder — replace with lawyer-approved wording before the first paying clone (T13).
const CONSENT_STATEMENT =
  'I consent to ZoQ creating an AI clone of my likeness and voice from footage I ' +
  'provide, and to that clone posting content as me. I confirm I am the person in ' +
  'this video and in the material I am providing, and that I can withdraw this ' +
  'consent at any time.';

function useAvatar(id) {
  const [state, setState] = useState({ loading: true });
  useEffect(() => {
    let live = true;
    get(`/avatars/${id}`)
      .then((a) => live && setState({ loading: false, avatar: a }))
      .catch((e) => live && setState({ loading: false, error: errorText(e, 'Could not load this avatar.') }));
    return () => { live = false; };
  }, [id]);
  return state;
}

// Our own storage upload endpoint lives on /api/studio/... — PUT it through the
// SAME-ORIGIN proxy (:3100 → :3000), never the absolute STUDIO_PUBLIC_BASE URL,
// which is cross-origin (CORS) and, on the ngrok stopgap, hits the warning page.
// A real S3 presigned URL is a different host and is used as-is.
function sameOriginUpload(url) {
  try {
    const u = new URL(url, window.location.origin);
    if (u.pathname.startsWith('/api/studio/')) return u.pathname + u.search;
    return url;
  } catch { return url; }
}

// upload-target → presigned PUT → public URL the ingest verifier can fetch.
async function uploadFile(id, file, kind, filename) {
  const target = await post(`/avatars/${id}/upload-target`, {
    filename, contentType: file.type || 'application/octet-stream', kind,
  });
  const res = await fetch(sameOriginUpload(target.url), { method: 'PUT', headers: target.headers || {}, body: file });
  if (!res.ok) throw new Error(`Upload failed (HTTP ${res.status})`);
  return target.public_url;
}

export default function CloneConsent() {
  const { id } = useParams();
  const { loading, avatar, error } = useAvatar(id);

  const [subjectName, setSubjectName] = useState('');

  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const recorderRef = useRef(null);
  const chunksRef = useRef([]);
  const [recording, setRecording] = useState(false);
  const [clip, setClip] = useState(null);       // { blob, url }
  const [camReady, setCamReady] = useState(false);
  const [camError, setCamError] = useState(null);

  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);      // record created
  const [err, setErr] = useState(null);

  // Stop the camera ONLY when leaving the page — not on every clip change, which
  // was the bug that killed the stream and crashed the second recording.
  useEffect(() => () => {
    if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
  }, []);

  const startCam = useCallback(async () => {
    setCamError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: true });
      streamRef.current = stream;
      if (videoRef.current) { videoRef.current.srcObject = stream; videoRef.current.muted = true; await videoRef.current.play().catch(() => {}); }
      setCamReady(true);
    } catch (e) {
      setCamError('Could not access the camera and microphone. Allow permission and try again — capture needs a secure (https or localhost) page.');
    }
  }, []);

  const startRec = useCallback(() => {
    if (!streamRef.current) return;
    // Re-record: drop the old clip (and free its blob URL) but keep the live stream.
    setClip((prev) => { if (prev?.url) URL.revokeObjectURL(prev.url); return null; });
    chunksRef.current = [];
    let mime = '';
    if (typeof MediaRecorder !== 'undefined') {
      if (MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')) mime = 'video/webm;codecs=vp8,opus';
      else if (MediaRecorder.isTypeSupported('video/webm')) mime = 'video/webm';
      else if (MediaRecorder.isTypeSupported('video/mp4')) mime = 'video/mp4';
    }
    let rec;
    try {
      rec = mime ? new MediaRecorder(streamRef.current, { mimeType: mime }) : new MediaRecorder(streamRef.current);
    } catch (e) {
      setCamError('This browser could not start recording. Try Chrome, or reload the page.');
      return;
    }
    const type = rec.mimeType || mime || 'video/webm';
    rec.ondataavailable = (ev) => { if (ev.data && ev.data.size) chunksRef.current.push(ev.data); };
    rec.onstop = () => {
      const blob = new Blob(chunksRef.current, { type });
      setClip({ blob, url: URL.createObjectURL(blob), ext: type.includes('mp4') ? 'mp4' : 'webm' });
    };
    recorderRef.current = rec;
    try { rec.start(); } catch (e) {
      setCamError('Recording did not start. Reload the page and try again.');
      return;
    }
    setRecording(true);
  }, []);

  const stopRec = useCallback(() => {
    try { recorderRef.current?.stop(); } catch { /* already stopped */ }
    setRecording(false);
  }, []);

  const ready = subjectName.trim() && clip && !busy && !done;

  async function submit() {
    setBusy(true); setErr(null);
    try {
      const ext = clip.ext || 'webm';
      const consentFile = new File([clip.blob], `consent.${ext}`, { type: clip.blob.type || 'video/webm' });
      const videoUrl = await uploadFile(id, consentFile, 'consent', `consent.${ext}`);
      await post(`/avatars/${id}/consent`, {
        subject_name: subjectName.trim(),
        method: 'hosted_capture',
        statement_language: 'en',
        video_url: videoUrl,
      });
      // Stop the camera now that we're done.
      if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
      setDone(true);
    } catch (e) {
      setErr(errorText(e, 'Could not save your consent.'));
    } finally { setBusy(false); }
  }

  if (loading) return <main className="wrap"><p className="hint">Loading…</p></main>;
  if (error) return <main className="wrap"><p className="lp-msg warn">{error}</p></main>;
  if (avatar?.mode === 'synthetic') {
    return (
      <main className="wrap">
        <h1>{avatar.name}</h1>
        <p className="lp-msg warn">This is a synthetic avatar — it depicts nobody, so it needs no consent. This page is only for a digital twin.</p>
        <p><Link className="btn sm ghost" href="/avatars">Back to avatars</Link></p>
      </main>
    );
  }

  return (
    <main className="wrap consent-wrap">
      <p className="mono crumb"><Link href="/avatars">avatars</Link> / {avatar?.slug} / consent</p>
      <h1>Consent to clone {avatar?.name}</h1>
      <p className="hint prof-deck">
        A twin is a real person, so training it needs recorded consent from that person. Record it here;
        the same-person check runs when you ingest your footage.
      </p>

      {done ? (
        <div className="card prof-card" style={{ borderColor: '#2f7d5b' }}>
          <div className="label">Consent recorded ✓</div>
          <p className="helper">Now ingest your training footage on your machine — that step verifies the
            consent (it matches this video against your footage) and builds the training set:</p>
          <pre className="mono code-block">node studio/ingest-twin.js --avatar {id} --video ~/your-footage.mp4 --yes</pre>
          <p className="helper">If the footage is the same person, it is marked verified and you can cull and train.</p>
          <p style={{ marginTop: 10 }}><Link className="btn sm ghost" href="/avatars">Back to avatars</Link></p>
        </div>
      ) : (
        <>
          <section className="card prof-card">
            <div className="label">1 · Your legal name</div>
            <label className="field">
              <span className="field-label">The name on the consent record</span>
              <input value={subjectName} onChange={(e) => setSubjectName(e.target.value)} placeholder="Your full name" />
            </label>
          </section>

          <section className="card prof-card">
            <div className="label">2 · Record your consent</div>
            <p className="helper">Look at the camera and read this aloud:</p>
            <blockquote className="consent-statement">{CONSENT_STATEMENT}</blockquote>
            {camError && <p className="lp-msg warn">{camError}</p>}
            <div className="consent-cam">
              <video ref={videoRef} playsInline style={{ width: '100%', maxWidth: 420, background: '#000', borderRadius: 10 }} />
            </div>
            <div className="btn-row" style={{ marginTop: 10 }}>
              {!camReady && <button type="button" className="btn sm" onClick={startCam}>Enable camera</button>}
              {camReady && !recording && <button type="button" className="btn sm" onClick={startRec}>{clip ? 'Re-record' : 'Start recording'}</button>}
              {camReady && recording && <button type="button" className="btn sm danger" onClick={stopRec}>Stop</button>}
            </div>
            {clip && !recording && (
              <div style={{ marginTop: 10 }}>
                <p className="helper">Your consent clip:</p>
                <video src={clip.url} controls playsInline style={{ width: '100%', maxWidth: 420, borderRadius: 10 }} />
              </div>
            )}
          </section>

          {err && <p className="lp-msg warn">{err}</p>}

          <div className="btn-row">
            <button type="button" className="btn" disabled={!ready} onClick={submit}>
              {busy ? 'Saving…' : 'Submit consent'}
            </button>
            <Link className="btn sm ghost" href="/avatars">Cancel</Link>
            {!ready && !busy && (
              <span className="helper">
                {!subjectName.trim() ? 'Your name first.' : !clip ? 'Record the consent video.' : ''}
              </span>
            )}
          </div>
          <p className="hint" style={{ marginTop: 12 }}>
            The wording above is a placeholder pending legal sign-off. Nothing is published; the video is stored only
            to prove consent and identity, and every clone output is labelled AI-generated.
          </p>
        </>
      )}
    </main>
  );
}
