"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { get } from "../../../lib/api";

/**
 * One shoot: live progress, then the finished video/stills with a Download.
 *
 * Assets are served through the same-origin API proxy (their public URL's path),
 * so playback and download work without CORS. Polls while it is still rendering.
 */

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const isVideo = (k) => k === "reel" || k === "clip" || k === "longform" || k === "short";
function toLocal(u) {
  if (!u) return u;
  try { const x = new URL(u); return x.pathname + x.search; } catch (_) { return u; }
}

export default function Page({ params }) {
  const id = params.id;
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const timer = useRef(null);

  useEffect(() => {
    let alive = true;
    async function tick() {
      try {
        const d = await get(`/shoots/${id}`);
        if (!alive) return;
        setData(d); setErr(null);
        if (d && d.progress && d.progress.status === "running") timer.current = setTimeout(tick, 4000);
      } catch (e) { if (alive) setErr(String((e && e.message) || e)); }
    }
    tick();
    return () => { alive = false; if (timer.current) clearTimeout(timer.current); };
  }, [id]);

  return (
    <>
      <div className="topbar">
        <div className="crumb"><Link className="lnk" href="/shoots">Shoots</Link> / <b>{(data && data.project && data.project.title) || "Shoot"}</b></div>
      </div>
      <div className="page">
        {err && <div className="load-err" style={{ marginBottom: 12 }}><span>{err}</span></div>}
        {!data ? <p className="hint">Loading…</p> : <Detail data={data} />}
      </div>
    </>
  );
}

const QC_REASON = {
  below_baseline: "the face didn’t match the persona closely enough",
  multiple_faces: "more than one face in the frame",
  no_face: "no face was detected",
  malformed_hands: "the hands rendered wrong",
  aspect: "the aspect ratio was off",
  text: "a text or watermark artifact appeared",
};
const qcReason = (r) => QC_REASON[r] || (r ? String(r).replace(/_/g, " ") : "rejected");

function Detail({ data }) {
  const p = data.project || {};
  const pr = data.progress || {};
  const assets = data.assets || [];
  const done = pr.status === "done";
  const failed = pr.status === "failed";
  const statusText = failed ? "Failed" : done ? "Done" : "Generating";
  const statusColor = failed ? "#b04a4a" : done ? "#2f7d4f" : "#8a7d3a";

  return (
    <div style={S.wrap}>
      <div style={S.head}>
        <div>
          <div style={S.title}>{p.title || "Shoot"}</div>
          <div style={S.meta}>{cap(p.kind)} · <span style={{ color: statusColor }}>{statusText}</span></div>
        </div>
        <div style={{ ...S.pct, color: statusColor }}>{pr.percent || 0}%</div>
      </div>

      <div style={S.bar}><div style={{ ...S.barFill, width: `${pr.percent || 0}%`, background: failed ? "#e6b0b0" : "#5b3df5" }} /></div>

      <div style={S.steps}>
        {(pr.steps || []).map((s, i) => (
          <span key={i} style={{ ...S.step, ...(s.status === "done" ? S.stepDone : s.status === "failed" ? S.stepFail : s.status === "running" ? S.stepRun : {}) }}>
            {s.status === "done" ? "✓ " : s.status === "failed" ? "✗ " : ""}{s.label}
          </span>
        ))}
      </div>

      {data.failure && (
        <div style={S.failBox}>
          <div style={S.failHead}>Couldn’t finish — {data.failure.label || cap(data.failure.stage)}.</div>
          <div style={S.failMsg}>{data.failure.stage === "qc" ? qcReason((assets.find((a) => a.qc_reason) || {}).qc_reason) : data.failure.message}</div>
        </div>
      )}

      {assets.length > 0 ? (
        <div style={S.assets}>
          {assets.map((a) => {
            const src = toLocal(a.storage_url);
            const base = String(p.title || "shoot").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
            const name = `${base}-${a.kind}-${a.id}.${isVideo(a.kind) ? "mp4" : "jpg"}`;
            return (
              <div key={a.id} style={S.asset}>
                {isVideo(a.kind)
                  ? <video src={src} controls playsInline style={S.media} />
                  : <img src={src} alt={a.kind} style={S.media} />}
                <div style={S.assetFoot}>
                  <span style={S.assetKind}>{cap(a.kind)}{a.seconds ? ` · ${Math.round(a.seconds)}s` : ""}{!isVideo(a.kind) && a.face_similarity != null ? ` · match ${a.face_similarity}` : ""}</span>
                  <a className="btn sm" href={src} download={name} target="_blank" rel="noreferrer">Download</a>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="hint" style={{ marginTop: 18 }}>
          {done ? "No downloadable output was produced." : failed ? "This shoot didn’t finish — see the reason above." : "Rendering… the video appears here the moment it finishes."}
        </p>
      )}
    </div>
  );
}

const S = {
  wrap: { maxWidth: 720 },
  head: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 },
  title: { fontSize: 22, fontWeight: 600 },
  meta: { fontSize: 13, color: "#8a8478", marginTop: 4 },
  pct: { fontSize: 22, fontWeight: 600 },
  bar: { height: 8, background: "#e9e4da", borderRadius: 999, overflow: "hidden", margin: "14px 0 16px" },
  barFill: { height: "100%", transition: "width .4s ease" },
  steps: { display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 20 },
  step: { fontSize: 12, border: "1px solid #e2ddd3", borderRadius: 999, padding: "4px 11px", color: "#8a8478", background: "#fff" },
  stepDone: { color: "#2f7d4f", borderColor: "#bfe0c8", background: "#f2faf4" },
  stepFail: { color: "#b04a4a", borderColor: "#e6c0c0", background: "#fdf3f3" },
  stepRun: { color: "#5b3df5", borderColor: "#cfc6f5", background: "#f5f3ff" },
  assets: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 16 },
  asset: { border: "1px solid #e6e1d8", borderRadius: 12, overflow: "hidden", background: "#fff" },
  media: { width: "100%", display: "block", background: "#000", maxHeight: 480, objectFit: "contain" },
  assetFoot: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 12px", gap: 10 },
  assetKind: { fontSize: 12, color: "#8a8478" },
  failBox: { border: "1px solid #e6c0c0", background: "#fdf3f3", borderRadius: 10, padding: "12px 14px", marginBottom: 18 },
  failHead: { fontSize: 14, fontWeight: 600, color: "#b04a4a" },
  failMsg: { fontSize: 13, color: "#8a6a6a", marginTop: 3 },
};
