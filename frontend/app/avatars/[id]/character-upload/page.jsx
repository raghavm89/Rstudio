'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { get, post, errorText } from '../../../../lib/api';

/**
 * Mode 3 — build a character from an uploaded image.
 *
 * The one path in the character line that raises third-party-rights risk, so it
 * is gated by a LOGGED attestation, not a bare disclaimer
 * (decision-character-avatars-mode3.md). The tick is recorded BEFORE the bytes:
 * this page POSTs the attestation, gets a presigned target back, and only then
 * PUTs the file. An operator ingest turns the upload into the character's anchor.
 *
 * The attestation wording is served by the API (so a T13 rewrite is one place),
 * and is a PLACEHOLDER pending the Indian-lawyer sign-off.
 */

// Our own storage endpoint is same-origin via the proxy; a real S3 presigned URL
// is a different host and used as-is. (Same rule as the clone page.)
function sameOriginUpload(url) {
  try {
    const u = new URL(url, window.location.origin);
    if (u.pathname.startsWith('/api/studio/')) return u.pathname + u.search;
    return url;
  } catch { return url; }
}

export default function CharacterUpload() {
  const { id } = useParams();
  const [state, setState] = useState({ loading: true });
  const [attested, setAttested] = useState(false);
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState(null);
  const fileRef = useRef(null);

  const load = () => {
    get(`/avatars/${id}/character-upload/status`)
      .then((s) => setState({ loading: false, status: s }))
      .catch((e) => setState({ loading: false, error: errorText(e, 'Could not load this avatar.') }));
  };
  useEffect(load, [id]);

  const submit = async () => {
    setErr(null);
    if (!attested) { setErr('Please confirm you hold the rights to this image.'); return; }
    if (!file) { setErr('Choose an image to upload.'); return; }
    setBusy(true);
    try {
      // 1. Record the attestation → presigned target (attestation is logged first).
      const target = await post(`/avatars/${id}/character-upload/attest`, {
        attested: true, filename: file.name, contentType: file.type || 'image/png',
      });
      // 2. PUT the bytes.
      const res = await fetch(sameOriginUpload(target.url), {
        method: 'PUT', headers: target.headers || {}, body: file,
      });
      if (!res.ok) throw new Error(`Upload failed (HTTP ${res.status})`);
      setDone(true);
      load();
    } catch (e) {
      setErr(errorText(e, 'Could not record the upload.'));
    } finally {
      setBusy(false);
    }
  };

  if (state.loading) return <main className="wrap"><p>Loading…</p></main>;
  if (state.error) return <main className="wrap"><p className="err">{state.error}</p></main>;

  const s = state.status || {};
  const notCharacter = s.subject_type !== 'character';
  const hasAttestation = Boolean(s.attestation && s.attestation.active);

  return (
    <main className="wrap">
      <p className="crumb"><Link href={`/avatars/${id}`}>← Back to avatar</Link></p>
      <h1>Build from an uploaded image</h1>

      {notCharacter ? (
        <p className="err">
          Uploading a reference image is only for <strong>character</strong> avatars
          (a mascot, a personified fruit, a creature). This avatar is not a character.
        </p>
      ) : (
        <>
          <p className="lead">
            Upload one clear image of your character. We’ll use it as the reference
            every generated frame is drawn from. You keep full responsibility for
            the rights in what you upload.
          </p>

          <div className="card">
            <label className="attest">
              <input
                type="checkbox"
                checked={attested}
                onChange={(e) => setAttested(e.target.checked)}
                disabled={busy}
              />
              <span>{s.attestation_text || 'I own this image, or I have all rights needed to use it.'}</span>
            </label>
            <p className="fine">
              This confirmation is recorded with a timestamp before your image is
              accepted. Wording v{s.attestation_version ?? 1} — final legal terms pending review.
            </p>

            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              onChange={(e) => setFile(e.target.files?.[0] || null)}
              disabled={busy}
            />

            <button className="go" onClick={submit} disabled={busy || !attested || !file}>
              {busy ? 'Uploading…' : 'Upload reference'}
            </button>

            {err && <p className="err">{err}</p>}
            {done && (
              <p className="ok">
                Uploaded and attestation recorded. Our team will process the reference
                into your character shortly.
              </p>
            )}
          </div>

          {hasAttestation && (
            <p className="fine">
              A rights attestation is on file for this character
              {s.has_anchor ? ' and its reference has been ingested.' : ' (reference pending processing).'}
            </p>
          )}
        </>
      )}

      <style jsx>{`
        .wrap { max-width: 640px; margin: 0 auto; padding: 32px 16px 64px; }
        .crumb { margin: 0 0 8px; }
        .crumb :global(a) { color: #6b7280; text-decoration: none; font-size: 14px; }
        h1 { font-size: 26px; margin: 0 0 12px; }
        .lead { color: #4b5563; line-height: 1.5; }
        .card { border: 1px solid #e5e7eb; border-radius: 14px; padding: 20px; margin-top: 16px;
                display: flex; flex-direction: column; gap: 14px; background: #fff; }
        .attest { display: flex; gap: 10px; align-items: flex-start; line-height: 1.45; font-size: 15px; }
        .attest input { margin-top: 3px; }
        .fine { color: #6b7280; font-size: 13px; margin: 0; }
        .go { align-self: flex-start; background: #111827; color: #fff; border: 0; border-radius: 10px;
              padding: 10px 18px; font-size: 15px; cursor: pointer; }
        .go:disabled { opacity: .5; cursor: not-allowed; }
        .err { color: #b91c1c; }
        .ok { color: #047857; }
      `}</style>
    </main>
  );
}
