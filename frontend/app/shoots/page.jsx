"use client";

import { useState } from "react";
import Link from "next/link";
import { post, errorText } from "../../lib/api";
import { useResource, Resource } from "../../components/Guard";

/**
 * Shoots — every post and reel this account has made, and the step each is on.
 *
 * A shoot can be saved back as a reusable template from here: the recipe is the
 * PLAN (format + shots + brief), which exists the moment the shoot is created,
 * so "I liked this one, make it a template" works on any shoot, not only a
 * finished one.
 */

// Which template categories a shoot's format can become.
function categoriesForKind(kind) {
  if (kind === "reel" || kind === "short") return [
    { key: "viral_video", label: "Viral video" },
    { key: "ad_video", label: "Ad video" },
  ];
  if (kind === "post" || kind === "carousel") return [{ key: "viral_stills", label: "Viral stills" }];
  return [];
}

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const STATUS_LABEL = {
  draft: "Draft", generating: "Generating", review: "In review",
  approved: "Approved", published: "Published", failed: "Failed", done: "Done",
};

export default function Shoots() {
  const state = useResource("/shoots");
  return (
    <>
      <div className="topbar"><div className="crumb"><b>Shoots</b></div></div>
      <div className="page">
        <Resource state={state}>{(d) => <List shoots={d.shoots || []} />}</Resource>
      </div>
    </>
  );
}

function List({ shoots }) {
  if (!shoots.length) {
    return (
      <p className="hint">
        Nothing shot yet. Start one from a <Link className="lnk" href="/templates">template</Link>,
        or <Link className="lnk" href="/avatars">set up an avatar</Link> first.
      </p>
    );
  }
  return (
    <div style={S.wrap}>
      <div style={S.list}>
        {shoots.map((s) => <Row key={s.id} s={s} />)}
      </div>
    </div>
  );
}

function Row({ s }) {
  const cats = categoriesForKind(s.kind);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(s.title || "");
  const [category, setCategory] = useState(cats[0]?.key || "");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [err, setErr] = useState(null);

  async function save() {
    setErr(null); setMsg(null); setBusy(true);
    try {
      await post(`/templates/from-shoot/${s.id}`, { name: name.trim() || undefined, category });
      setMsg("Saved to your templates.");
      setOpen(false);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={S.row}>
      <div style={S.rowMain}>
        <Link href={`/shoots/${s.id}`} style={{ ...S.title, textDecoration: "none", color: "inherit" }}>{s.title || `${cap(s.kind)} shoot`} <span style={{ color: "#5b3df5", fontWeight: 400 }}>→</span></Link>
        <div style={S.meta}>
          {cap(s.kind)} · {s.shots} shot{s.shots === 1 ? "" : "s"}
          {s.avatar_name ? <> · {s.avatar_name}</> : null}
          <span> · </span><span style={S.status}>{STATUS_LABEL[s.status] || s.status}</span>
        </div>
        {msg && <div style={S.ok}>{msg}</div>}
        {err && <div className="load-err" style={{ marginTop: 8 }}><span>{err}</span></div>}
      </div>
      <div style={S.rowAction}>
        {cats.length ? (
          open ? (
            <div style={S.form}>
              <input style={S.input} value={name} placeholder="Template name" onChange={(e) => setName(e.target.value)} />
              <select style={S.select} value={category} onChange={(e) => setCategory(e.target.value)}>
                {cats.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
              </select>
              <button className="btn" disabled={busy} onClick={save}>{busy ? "Saving…" : "Save"}</button>
              <button style={S.ghost} onClick={() => setOpen(false)}>Cancel</button>
            </div>
          ) : (
            <button style={S.ghost} onClick={() => setOpen(true)}>Save as template</button>
          )
        ) : (
          <span className="hint" style={{ margin: 0, fontSize: 12 }}>—</span>
        )}
      </div>
    </div>
  );
}

const S = {
  wrap: { maxWidth: 900 },
  list: { display: "flex", flexDirection: "column", gap: 10 },
  row: { border: "1px solid #e6e1d8", borderRadius: 12, background: "#fff", padding: "14px 16px", display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, flexWrap: "wrap" },
  rowMain: { flex: 1, minWidth: 220 },
  title: { fontWeight: 600, fontSize: 15, marginBottom: 4 },
  meta: { fontSize: 12.5, color: "#8a8478" },
  status: { color: "#5a554c" },
  rowAction: { display: "flex", alignItems: "center" },
  form: { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" },
  input: { border: "1px solid #d8d2c8", borderRadius: 8, padding: "7px 10px", fontSize: 13, minWidth: 150 },
  select: { border: "1px solid #d8d2c8", borderRadius: 8, padding: "7px 10px", fontSize: 13, background: "#fff" },
  ghost: { border: "1px solid #d8d2c8", background: "#fff", borderRadius: 8, padding: "7px 12px", cursor: "pointer", fontSize: 13 },
  ok: { color: "#28a745", fontSize: 13, marginTop: 8 },
};
