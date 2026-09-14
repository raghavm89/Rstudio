"use client";

import { useState, useRef } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { post, errorText } from "../../../../lib/api";
import { useResource, Resource } from "../../../../components/Guard";

/**
 * Create — what you do with a trained avatar.
 *
 * Two content paths: describe an idea and let the creative director plan the
 * whole shoot, or start from a ready-made template. Plus the (not-yet-built)
 * Interactive AI lane. This replaces the old per-avatar Shoot form: the form
 * only set the camera; the story lives in the scene + concept, which is what
 * both paths here actually capture.
 */

const FORMATS = [
  { key: "reel", label: "Reel", motion: true },
  { key: "short", label: "Short", motion: true },
  { key: "post", label: "Post", motion: false },
  { key: "carousel", label: "Carousel", motion: false },
];
const CATEGORY_LABEL = { ad_video: "Ad video", viral_video: "Viral video", viral_stills: "Viral stills" };
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

export default function Page({ params }) {
  return (
    <>
      <div className="topbar"><div className="crumb"><b>Create</b></div></div>
      <div className="page">
        <div style={S.wrap}>
          <Idea avatarId={params.id} />
          <div style={S.divider}>or start from a template</div>
          <Templates avatarId={params.id} />
          <div style={S.divider}>or go live</div>
          <Interactive />
        </div>
      </div>
    </>
  );
}

function Idea({ avatarId }) {
  const router = useRouter();
  const [idea, setIdea] = useState("");
  const [kind, setKind] = useState("reel");
  const [clip, setClip] = useState(5);
  const [beats, setBeats] = useState(3);   // reel = a storyboard of N beats, stitched
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const recRef = useRef(null);
  const fileRef = useRef(null);
  const motion = (FORMATS.find((f) => f.key === kind) || {}).motion;
  const micOk = typeof window !== "undefined" && (window.SpeechRecognition || window.webkitSpeechRecognition);

  function appendIdea(t) {
    const clean = String(t || "").trim();
    if (!clean) return;
    setIdea((prev) => (prev.trim() ? prev.trim() + " " + clean : clean));
  }

  function toggleMic() {
    if (recording) {
      try { if (recRef.current) recRef.current.stop(); } catch (_) {}
      setRecording(false);
      return;
    }
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { setErr("This browser can't do live dictation — use Chrome, or upload a voice note."); return; }
    setErr(null);
    const rec = new SR();
    rec.lang = "en-IN";
    rec.continuous = true;
    rec.interimResults = false;
    rec.onresult = (e) => {
      let t = "";
      for (let i = e.resultIndex; i < e.results.length; i++) t += e.results[i][0].transcript;
      appendIdea(t);
    };
    rec.onend = () => setRecording(false);
    rec.onerror = () => setRecording(false);
    recRef.current = rec;
    try { rec.start(); setRecording(true); } catch (_) { setRecording(false); }
  }

  async function onFile(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { setErr("Audio too large — keep it under ~5MB (a short clip)."); return; }
    setErr(null); setTranscribing(true);
    try {
      const b64 = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result).split(",")[1] || "");
        r.onerror = rej;
        r.readAsDataURL(file);
      });
      const out = await post("/transcribe", { audio_base64: b64, content_type: file.type || "audio/webm" });
      if (out && out.text) appendIdea(out.text);
      else setErr("Couldn't make out any speech in that audio.");
    } catch (e2) { setErr(errorText(e2)); } finally { setTranscribing(false); }
  }

  async function go() {
    setErr(null);
    if (!idea.trim()) { setErr("Describe the video first."); return; }
    setBusy(true);
    try {
      await post("/shoots/plan", { avatar_id: Number(avatarId), idea: idea.trim(), kind, clip_seconds: clip, ...(motion ? { frame_count: beats } : {}) });
      router.push("/shoots");
    } catch (e) { setErr(errorText(e)); } finally { setBusy(false); }
  }

  return (
    <section style={S.card}>
      <h2 style={S.h2}>Describe your idea</h2>
      <p className="hint" style={{ marginTop: 0 }}>
        Type it, speak it, or upload a voice note — say what the video is about: the
        scene, the vibe, the moment. A creative director writes the shot plan, the
        setting and the caption. Her face stays exactly as trained.
      </p>
      <textarea
        value={idea} onChange={(e) => setIdea(e.target.value)} rows={4} style={S.textarea}
        placeholder="e.g. A get-ready-with-me for a Mumbai monsoon evening — chai on the balcony, a cosy kurta, ending with a smile at the rain."
      />
      <div style={S.tools}>
        <button type="button" onClick={toggleMic} style={{ ...S.tool, ...(recording ? S.toolRec : {}) }}>
          {recording ? "● Stop dictation" : "🎤 Dictate"}
        </button>
        <button type="button" onClick={() => fileRef.current && fileRef.current.click()} style={S.tool} disabled={transcribing}>
          {transcribing ? "Transcribing…" : "📎 Upload voice note"}
        </button>
        <input ref={fileRef} type="file" accept="audio/*" onChange={onFile} style={{ display: "none" }} />
        {!micOk && <span style={S.toolHint}>Dictation needs Chrome; upload works anywhere.</span>}
      </div>
      <div style={S.row}>
        <div style={S.chips}>
          {FORMATS.map((f) => (
            <button key={f.key} onClick={() => setKind(f.key)} style={{ ...S.chip, ...(kind === f.key ? S.chipOn : {}) }}>{f.label}</button>
          ))}
        </div>
        {motion && (
          <div style={S.reelCtl}>
            <label style={S.clip}>
              <span style={S.ctlLbl}>Scenes</span>
              <input type="range" min={1} max={6} value={beats} onChange={(e) => setBeats(Number(e.target.value))} />
              <span style={S.clipVal}>{beats}</span>
            </label>
            <label style={S.clip}>
              <span style={S.ctlLbl}>Each</span>
              <input type="range" min={2} max={10} value={clip} onChange={(e) => setClip(Number(e.target.value))} />
              <span style={S.clipVal}>{clip}s</span>
            </label>
            <span style={S.total}>~{beats * clip}s{beats > 1 ? ` · ${beats} cuts` : ""}</span>
          </div>
        )}
      </div>
      {err && <div className="load-err" style={{ margin: "10px 0" }}><span>{err}</span></div>}
      <button className="btn" style={S.go} disabled={busy} onClick={go}>
        {busy ? "Planning your video…" : "Generate video →"}
      </button>
    </section>
  );
}

function Templates({ avatarId }) {
  const templates = useResource("/templates");
  const router = useRouter();
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState(null);

  async function use(t) {
    setErr(null); setBusy(t.id);
    try { await post(`/templates/${t.id}/apply`, { avatar_id: Number(avatarId) }); router.push("/shoots"); }
    catch (e) { setErr(errorText(e)); } finally { setBusy(null); }
  }

  return (
    <section>
      {err && <div className="load-err" style={{ marginBottom: 12 }}><span>{err}</span></div>}
      <Resource state={templates}>
        {(d) => {
          const list = (d.templates || []).slice(0, 8);
          if (!list.length) return <p className="hint">No templates yet.</p>;
          return (
            <div style={S.tgrid}>
              {list.map((t) => (
                <div key={t.id} style={S.tcard}>
                  <div style={S.tcover}>
                    {t.cover_url ? <img src={t.cover_url} alt={t.name} style={S.timg} /> : <span style={S.tglyph}>{t.kind === "carousel" || t.kind === "post" ? "▦" : "►"}</span>}
                    <span style={S.tbadge}>{CATEGORY_LABEL[t.category] || t.category}</span>
                  </div>
                  <div style={S.tbody}>
                    <div style={S.tname}>{t.name}</div>
                    <div style={S.tmeta}>{cap(t.kind)} · {t.frame_count} shot{t.frame_count === 1 ? "" : "s"}</div>
                  </div>
                  <button className="btn sm" style={{ margin: 12 }} disabled={busy === t.id} onClick={() => use(t)}>
                    {busy === t.id ? "Starting…" : "Use this →"}
                  </button>
                </div>
              ))}
            </div>
          );
        }}
      </Resource>
      <p className="hint" style={{ marginTop: 10 }}><Link className="lnk" href="/templates">See all templates →</Link></p>
    </section>
  );
}

function Interactive() {
  return (
    <section style={{ ...S.card, marginBottom: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <h2 style={{ ...S.h2, margin: 0 }}>Interactive AI</h2>
        <span className="pill warn">Coming soon</span>
      </div>
      <p className="hint" style={{ marginBottom: 0 }}>
        A real-time, talking version of this avatar — answers on camera, lip-synced,
        for lives and DMs. Not live yet.
      </p>
    </section>
  );
}

const S = {
  wrap: { maxWidth: 720 },
  card: { border: "1px solid #e6e1d8", borderRadius: 14, background: "#fff", padding: "22px 24px", marginBottom: 8 },
  h2: { margin: "0 0 6px", fontSize: 20 },
  textarea: { width: "100%", border: "1px solid #d8d2c8", borderRadius: 10, padding: "12px 14px", fontSize: 15, lineHeight: 1.5, resize: "vertical", background: "#fdfcfa", boxSizing: "border-box", marginTop: 6 },
  row: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap", margin: "14px 0" },
  chips: { display: "flex", gap: 8, flexWrap: "wrap" },
  chip: { border: "1px solid #d8d2c8", background: "#fff", borderRadius: 999, padding: "7px 16px", cursor: "pointer", fontSize: 13 },
  chipOn: { background: "#141414", color: "#fff", borderColor: "#141414" },
  clip: { display: "flex", alignItems: "center", gap: 8 },
  clipVal: { fontSize: 13, color: "#5a554c", minWidth: 26 },
  reelCtl: { display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" },
  ctlLbl: { fontSize: 12, color: "#8a8478", marginRight: 2 },
  total: { fontSize: 12, color: "#8a8478", fontVariantNumeric: "tabular-nums" },
  go: { fontSize: 15, padding: "11px 24px" },
  tools: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", margin: "10px 0 2px" },
  tool: { border: "1px solid #d8d2c8", background: "#fff", borderRadius: 8, padding: "6px 12px", cursor: "pointer", fontSize: 13 },
  toolRec: { background: "#fdecec", borderColor: "#e6b0b0", color: "#b04a4a" },
  toolHint: { fontSize: 12, color: "#a49d90" },
  divider: { textAlign: "center", color: "#a49d90", fontSize: 12, letterSpacing: ".05em", textTransform: "uppercase", margin: "26px 0 16px" },
  tgrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 14 },
  tcard: { border: "1px solid #e6e1d8", borderRadius: 12, overflow: "hidden", background: "#fff", display: "flex", flexDirection: "column" },
  tcover: { position: "relative", aspectRatio: "4 / 5", background: "#efece6", display: "flex", alignItems: "center", justifyContent: "center" },
  timg: { width: "100%", height: "100%", objectFit: "cover" },
  tglyph: { fontSize: 40, color: "#b9b1a3" },
  tbadge: { position: "absolute", top: 8, left: 8, background: "rgba(20,20,20,.72)", color: "#fff", fontSize: 10, padding: "2px 7px", borderRadius: 5 },
  tbody: { padding: "10px 12px 4px", flex: 1 },
  tname: { fontWeight: 600, fontSize: 14 },
  tmeta: { fontSize: 11, color: "#8a8478", marginTop: 3 },
};
