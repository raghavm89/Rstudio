"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { post, api, errorText } from "../../lib/api";
import { useResource, Resource } from "../../components/Guard";
import { useAuth } from "../../components/AuthProvider";
const toLocal = (u) => { if (!u) return u; try { const x = new URL(u); return x.pathname + x.search; } catch (_) { return u; } };

/**
 * Content templates — pick a ready-made ad / viral recipe and shoot it.
 *
 * A template is a saved shoot recipe (format + shot-by-shot plan + brief).
 * Applying one is a normal shoot through the orchestrator — same quota, same
 * pipeline — so this screen is: choose which avatar shoots, pick a format, go.
 * The library is platform templates (shared) plus this tenant's own.
 */

const CATEGORY_LABEL = {
  ad_video: "Ad video",
  viral_video: "Viral video",
  viral_stills: "Viral stills",
};

export default function Templates() {
  const templates = useResource("/templates");
  const avatars = useResource("/avatars");
  return (
    <>
      <div className="topbar">
        <div className="crumb"><b>Templates</b></div>
      </div>
      <div className="page">
        <Resource state={templates}>
          {(d) => (
            <Resource state={avatars}>
              {(av) => <Browse d={d} avatars={av.avatars || []} reload={templates.reload} />}
            </Resource>
          )}
        </Resource>
      </div>
    </>
  );
}

function Browse({ d, avatars, reload }) {
  const router = useRouter();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const trained = avatars.filter((a) => a.trained);
  const [category, setCategory] = useState("all");
  const [avatarId, setAvatarId] = useState(trained[0]?.id ?? null);
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState(null);

  const templates = d.templates || [];
  const cats = Array.from(new Set(templates.map((t) => t.category)));
  const shown = category === "all" ? templates : templates.filter((t) => t.category === category);

  async function use(t) {
    setErr(null);
    if (!avatarId) { setErr("Pick an avatar to shoot as first."); return; }
    setBusy(t.id);
    try {
      await post(`/templates/${t.id}/apply`, { avatar_id: Number(avatarId) });
      router.push("/shoots");
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  async function remove(t) {
    setErr(null);
    setBusy(t.id);
    try {
      await api(`/templates/${t.id}`, { method: "DELETE" });
      await reload();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  async function publish(t) {
    setErr(null);
    setBusy(t.id);
    try {
      await post(`/templates/${t.id}/publish`);
      await reload();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  if (!templates.length) {
    return (
      <p className="hint">
        No templates yet — the platform library appears here, and you can save a
        shoot you like as a template from its page.
      </p>
    );
  }

  return (
    <div style={S.wrap}>
      <p className="hint" style={{ marginTop: 0 }}>
        Pick a format and shoot it in one click. Templates carry the whole plan —
        the shots, the hook, the caption angle — so there is nothing to write.
      </p>

      <div style={S.controls}>
        <label style={S.shootAs}>
          <span style={S.shootAsLabel}>Shoot as</span>
          {trained.length ? (
            <select style={S.select} value={avatarId ?? ""} onChange={(e) => setAvatarId(e.target.value)}>
              {trained.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          ) : (
            <span className="hint" style={{ margin: 0 }}>
              No trained avatar yet — <Link className="lnk" href="/avatars">set one up</Link> first.
            </span>
          )}
        </label>

        <div style={S.filters}>
          <Chip on={category === "all"} onClick={() => setCategory("all")}>All</Chip>
          {cats.map((c) => (
            <Chip key={c} on={category === c} onClick={() => setCategory(c)}>{CATEGORY_LABEL[c] || c}</Chip>
          ))}
        </div>
      </div>

      {err && <div className="load-err" style={{ marginBottom: 16 }}><span>{err}</span></div>}

      <div style={S.grid}>
        {shown.map((t) => (
          <div key={t.id} style={S.card}>
            <div style={S.cover}>
              {t.cover_url
                ? <img src={toLocal(t.cover_url)} alt={t.name} style={S.img} />
                : <span style={S.kindGlyph}>{t.kind === "carousel" || t.kind === "post" ? "▦" : "►"}</span>}
              <span style={S.badge}>{CATEGORY_LABEL[t.category] || t.category}</span>
              {!t.is_platform && <span style={S.mine}>Yours</span>}
            </div>
            <div style={S.body}>
              <div style={S.name}>{t.name}</div>
              <div style={S.meta}>{cap(t.kind)} · {t.frame_count} shot{t.frame_count === 1 ? "" : "s"}</div>
            </div>
            <div style={S.action}>
              <button className="btn" disabled={busy === t.id || !trained.length} onClick={() => use(t)}>
                {busy === t.id ? "Starting…" : "Use this →"}
              </button>
              {isAdmin && !t.is_platform && (
                <button style={S.publish} title="Publish to the shared library" disabled={busy === t.id} onClick={() => publish(t)}>Publish</button>
              )}
              {!t.is_platform && (
                <button style={S.del} title="Delete this template" disabled={busy === t.id} onClick={() => remove(t)}>×</button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Chip({ on, onClick, children }) {
  return <button onClick={onClick} style={{ ...S.chip, ...(on ? S.chipOn : {}) }}>{children}</button>;
}

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

const S = {
  wrap: { maxWidth: 1080 },
  controls: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, flexWrap: "wrap", margin: "8px 0 20px" },
  shootAs: { display: "flex", alignItems: "center", gap: 10 },
  shootAsLabel: { fontSize: 13, color: "#5a554c" },
  select: { border: "1px solid #d8d2c8", borderRadius: 8, padding: "7px 10px", fontSize: 14, background: "#fff" },
  filters: { display: "flex", gap: 8, flexWrap: "wrap" },
  chip: { border: "1px solid #d8d2c8", background: "#fff", borderRadius: 999, padding: "6px 14px", cursor: "pointer", fontSize: 13 },
  chipOn: { background: "#141414", color: "#fff", borderColor: "#141414" },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 18 },
  card: { border: "1px solid #e6e1d8", borderRadius: 12, overflow: "hidden", background: "#fff", display: "flex", flexDirection: "column" },
  cover: { position: "relative", aspectRatio: "4 / 5", background: "#efece6", display: "flex", alignItems: "center", justifyContent: "center" },
  img: { width: "100%", height: "100%", objectFit: "cover" },
  kindGlyph: { fontSize: 52, color: "#b9b1a3" },
  badge: { position: "absolute", top: 10, left: 10, background: "rgba(20,20,20,.72)", color: "#fff", fontSize: 11, padding: "3px 8px", borderRadius: 6, letterSpacing: ".03em" },
  mine: { position: "absolute", top: 10, right: 10, background: "#5b3df5", color: "#fff", fontSize: 11, padding: "3px 8px", borderRadius: 6 },
  body: { padding: "14px 14px 8px", flex: 1 },
  name: { fontWeight: 600, fontSize: 15, marginBottom: 6 },
  meta: { fontSize: 12, color: "#8a8478" },
  action: { padding: "12px 14px", borderTop: "1px solid #f0ece4", display: "flex", gap: 8, alignItems: "center" },
  publish: { border: "1px solid #cfc6f5", background: "#fff", color: "#5b3df5", borderRadius: 8, padding: "0 12px", height: 34, cursor: "pointer", fontSize: 13 },
  del: { border: "1px solid #e6d5d5", background: "#fff", color: "#b04a4a", borderRadius: 8, width: 34, height: 34, cursor: "pointer", fontSize: 18, lineHeight: 1 },
};
