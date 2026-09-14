"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import Link from "next/link";
import { get, post } from "../../../lib/api";

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
  const alive = useRef(true);

  const tick = useCallback(async () => {
    try {
      const d = await get(`/shoots/${id}`);
      if (!alive.current) return;
      setData(d); setErr(null);
      if (d && d.progress && d.progress.status === "running") timer.current = setTimeout(tick, 4000);
    } catch (e) { if (alive.current) setErr(String((e && e.message) || e)); }
  }, [id]);

  useEffect(() => {
    alive.current = true;
    tick();
    return () => { alive.current = false; if (timer.current) clearTimeout(timer.current); };
  }, [id, tick]);

  async function approve() {
    await post(`/shoots/${id}/approve`);
    tick();
  }

  return (
    <>
      <div className="topbar">
        <div className="crumb"><Link className="lnk" href="/shoots">Shoots</Link> / <b>{(data && data.project && data.project.title) || "Shoot"}</b></div>
      </div>
      <div className="page">
        {err && <div className="load-err" style={{ marginBottom: 12 }}><span>{err}</span></div>}
        {!data ? <p className="hint">Loading…</p> : <Detail data={data} onApprove={approve} onRefresh={tick} />}
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

function Detail({ data, onApprove, onRefresh }) {
  const p = data.project || {};
  const pr = data.progress || {};
  const assets = data.assets || [];
  const done = pr.status === "done";
  const failed = pr.status === "failed";
  const review = pr.status === "review";
  const [approving, setApproving] = useState(false);
  const statusText = failed ? "Failed" : done ? "Done" : review ? "Ready to review" : "Generating";
  const statusColor = failed ? "#b04a4a" : done ? "#2f7d4f" : review ? "#5b3df5" : "#8a7d3a";
  async function doApprove() { setApproving(true); try { await onApprove(); } catch (_) {} finally { setApproving(false); } }
  const [regenning, setRegenning] = useState(false);
  const [regenErr, setRegenErr] = useState(null);
  async function regen() {
    setRegenErr(null); setRegenning(true);
    try { await post(`/shoots/${p.id}/regenerate-stills`); if (onRefresh) await onRefresh(); }
    catch (e) { setRegenErr(String((e && e.message) || e)); } finally { setRegenning(false); }
  }
  const stills = assets.filter((a) => a.kind === "still");
  const videos = assets.filter((a) => isVideo(a.kind));
  const shotIds = [...new Set(stills.map((a) => a.shot_id))].sort((x, y) => (x || 0) - (y || 0));
  const shown = [...videos, ...stills.filter((a) => a.selected)];
  const [selecting, setSelecting] = useState(null);
  async function pick(shotId, assetId) {
    setSelecting(assetId);
    try { await post(`/shoots/${p.id}/select-still`, { shot_id: shotId, asset_id: assetId }); if (onRefresh) await onRefresh(); }
    catch (_) {} finally { setSelecting(null); }
  }
  const [reanimating, setReanimating] = useState(false);
  const [takeErr, setTakeErr] = useState(null);
  const takeOf = new Map([...videos].sort((a, b) => new Date(a.created_at) - new Date(b.created_at)).map((a, i) => [a.id, i + 1]));
  async function newTake() {
    setTakeErr(null); setReanimating(true);
    try { await post(`/shoots/${p.id}/reanimate`); if (onRefresh) await onRefresh(); }
    catch (e) { setTakeErr(String((e && e.message) || e)); } finally { setReanimating(false); }
  }

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

      {review && (
        <div style={S.reviewBox}>
          <div style={S.reviewHead}>Review your stills — pick the best for each scene</div>
          <div style={S.reviewMsg}>Nothing is animated yet, and no video renders until you approve. {shotIds.length} scene{shotIds.length === 1 ? "" : "s"}, {stills.length} candidate{stills.length === 1 ? "" : "s"}. Tap a frame to choose it (a ✓ marks the pick); then approve to animate the chosen ones.</div>
          <div style={S.sceneGroups}>
            {shotIds.map((sid, si) => {
              const cands = stills.filter((a) => a.shot_id === sid).sort((a, b) => (a.candidate_index || 0) - (b.candidate_index || 0));
              return (
                <div key={sid} style={S.sceneGroup}>
                  <div style={S.sceneLbl}>Scene {si + 1}</div>
                  <div style={S.cands}>
                    {cands.map((a) => (
                      <button key={a.id} type="button" onClick={() => pick(sid, a.id)} disabled={selecting === a.id} style={{ ...S.cand, ...(a.selected ? S.candOn : {}), opacity: selecting === a.id ? 0.5 : 1 }} title={a.face_similarity != null ? `match ${a.face_similarity}` : ""}>
                        <img src={toLocal(a.storage_url)} alt="" style={S.candImg} />
                        {a.selected ? <span style={S.candTick}>✓</span> : null}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
          <div style={S.reviewActions}>
            <button className="btn" disabled={approving || regenning} onClick={doApprove}>{approving ? "Releasing…" : "Approve & animate →"}</button>
            <button className="btn ghost" disabled={approving || regenning} onClick={regen} title="Render a fresh set of stills to pick from — new frames, same plan.">{regenning ? "Reshooting…" : "↻ Regenerate stills"}</button>
            {p.avatar_id ? <Link className="btn ghost" href={`/avatars/${p.avatar_id}/create?from=${p.id}`}>✎ Edit the plan</Link> : null}
          </div>
          {regenErr ? <div className="load-err" style={{ marginTop: 8 }}><span>{regenErr}</span></div> : null}
          <p style={S.rejectHint}>Not right? <b>Regenerate</b> reshoots the frames with the same plan; <b>Edit the plan</b> reopens these scenes to change and reshoot this same shoot.</p>
        </div>
      )}

      {data.failure && (
        <div style={S.failBox}>
          <div style={S.failHead}>Couldn’t finish — {data.failure.label || cap(data.failure.stage)}.</div>
          <div style={S.failMsg}>{data.failure.stage === "qc" ? qcReason((assets.find((a) => a.qc_reason) || {}).qc_reason) : data.failure.message}</div>
        </div>
      )}

      {done && videos.length > 0 && (
        <div style={S.takeBar}>
          <span style={S.takeMsg}>{videos.length} video{videos.length === 1 ? "" : "s"} in this shoot — motion varies each take.</span>
          <button className="btn sm" disabled={reanimating} onClick={newTake}>{reanimating ? "Starting…" : "+ Generate another take"}</button>
        </div>
      )}
      {takeErr ? <div className="load-err" style={{ margin: "8px 0" }}><span>{takeErr}</span></div> : null}

      {!review && (shown.length > 0 ? (
        <div style={S.assets}>
          {shown.map((a) => {
            const src = toLocal(a.storage_url);
            const base = String(p.title || "shoot").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
            const name = `${base}-${a.kind}-${a.id}.${isVideo(a.kind) ? "mp4" : "jpg"}`;
            return (
              <div key={a.id} style={S.asset}>
                {isVideo(a.kind)
                  ? <video src={src} controls playsInline style={S.media} />
                  : <img src={src} alt={a.kind} style={S.media} />}
                <div style={S.assetFoot}>
                  <span style={S.assetKind}>{isVideo(a.kind) ? `Take ${takeOf.get(a.id) || 1}` : cap(a.kind)}{a.seconds ? ` · ${Math.round(a.seconds)}s` : ""}{!isVideo(a.kind) && a.face_similarity != null ? ` · match ${a.face_similarity}` : ""}</span>
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
      ))}
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
  reviewBox: { border: "1px solid #cfc6f5", background: "#f5f3ff", borderRadius: 10, padding: "14px 16px", marginBottom: 18 },
  reviewActions: { display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginTop: 14 },
  rejectHint: { fontSize: 12, color: "#8a86a0", marginTop: 8, marginBottom: 0 },
  reviewHead: { fontSize: 15, fontWeight: 600, color: "#5b3df5" },
  reviewMsg: { fontSize: 13, color: "#6a6580", marginTop: 4 },
  sceneGroups: { display: "flex", flexDirection: "column", gap: 12, marginTop: 12 },
  sceneGroup: {},
  sceneLbl: { fontSize: 12, fontWeight: 600, color: "#5a554c", marginBottom: 6 },
  cands: { display: "flex", gap: 8, flexWrap: "wrap" },
  cand: { position: "relative", padding: 0, border: "2px solid transparent", borderRadius: 8, background: "none", cursor: "pointer", width: 180, height: 320, overflow: "hidden" },
  candOn: { borderColor: "#5b3df5", boxShadow: "0 0 0 2px rgba(91,61,245,.15)" },
  candImg: { width: "100%", height: "100%", objectFit: "cover", display: "block", borderRadius: 6 },
  candTick: { position: "absolute", top: 4, right: 4, background: "#5b3df5", color: "#fff", borderRadius: 999, width: 18, height: 18, fontSize: 12, lineHeight: "18px", textAlign: "center" },
  takeBar: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", border: "1px solid #e6e1d8", borderRadius: 10, padding: "10px 14px", marginBottom: 14, background: "#fff" },
  takeMsg: { fontSize: 13, color: "#5a554c" },
};
