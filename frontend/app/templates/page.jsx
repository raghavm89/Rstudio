"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { post, api, errorText } from "../../lib/api";
import { useResource, Resource } from "../../components/Guard";
import { useAuth } from "../../components/AuthProvider";
const toLocal = (u) => { if (!u) return u; try { const x = new URL(u); return x.pathname + x.search; } catch (_) { return u; } };

/**
 * Templates — ready-made ad / viral recipes, browsed by sub-page (Viral Reels,
 * Ad, Viral Stills) and shot onto an avatar. Stories are NOT here — they live in
 * the Story lane. A template is a saved shoot recipe; applying one is a normal
 * shoot through the orchestrator.
 */

const CATEGORY_LABEL = { viral_video: "Viral Reels", ad_video: "Ad", viral_stills: "Viral Stills" };
const CATEGORY_BLURB = {
  viral_video: "Trend-led reels — GRWM, transitions, day-in-my-life.",
  ad_video: "Punchy product-drop and sale ads with a clear CTA.",
  viral_stills: "Carousels and photo-dump stills that read as a real day.",
};
const CATEGORY_ORDER = ["viral_video", "ad_video", "viral_stills"];
const catLabel = (c) => CATEGORY_LABEL[c] || (c ? c.replace(/_/g, " ") : c);
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

export default function Templates() {
  const templates = useResource("/templates");
  const avatars = useResource("/avatars");
  return (
    <>
      <div className="topbar">
        <div className="crumb"><b>Templates</b></div>
        <Link className="btn sm" href="/templates/extract">Extract a format →</Link>
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
  const [category, setCategory] = useState(null);   // null = sub-page landing
  const [avatarId, setAvatarId] = useState(trained[0]?.id ?? null);
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState(null);

  const templates = d.templates || [];
  const groups = useMemo(() => {
    const by = new Map();
    for (const t of templates) {
      if (!by.has(t.category)) by.set(t.category, []);
      by.get(t.category).push(t);
    }
    const keys = [...by.keys()].sort((a, b) => {
      const ia = CATEGORY_ORDER.indexOf(a), ib = CATEGORY_ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    return keys.map((k) => ({ key: k, list: by.get(k) }));
  }, [templates]);

  async function use(t) {
    setErr(null);
    if (!avatarId) { setErr("Pick an avatar to shoot as first."); return; }
    setBusy(t.id);
    try { await post(`/templates/${t.id}/apply`, { avatar_id: Number(avatarId) }); router.push("/shoots"); }
    catch (e) { setErr(errorText(e)); } finally { setBusy(null); }
  }
  async function remove(t) {
    setErr(null); setBusy(t.id);
    try { await api(`/templates/${t.id}`, { method: "DELETE" }); await reload(); }
    catch (e) { setErr(errorText(e)); } finally { setBusy(null); }
  }
  async function publish(t) {
    setErr(null); setBusy(t.id);
    try { await post(`/templates/${t.id}/publish`); await reload(); }
    catch (e) { setErr(errorText(e)); } finally { setBusy(null); }
  }

  if (!templates.length) {
    return (
      <p className="hint">
        No templates yet — the platform library appears here, and you can save a
        shoot you like as a template from its page.
      </p>
    );
  }

  // ── Sub-page landing: category tiles ─────────────────────────────────────
  if (!category) {
    return (
      <div style={S.wrap}>
        <p className="hint" style={{ marginTop: 0, marginBottom: 18 }}>
          Pick a format and shoot it in one click. Templates carry the whole plan — the shots, the hook, the caption angle.
        </p>
        <div style={S.grid}>
          {groups.map((g) => (
            <button key={g.key} style={S.catCard} onClick={() => setCategory(g.key)}>
              <div style={S.catName}>{catLabel(g.key)}</div>
              <div style={S.catBlurb}>{CATEGORY_BLURB[g.key] || ""}</div>
              <div style={S.catCount}>{g.list.length} template{g.list.length === 1 ? "" : "s"} →</div>
            </button>
          ))}
        </div>
      </div>
    );
  }

  // ── A sub-page: templates in the chosen category ─────────────────────────
  const shown = (groups.find((g) => g.key === category) || { list: [] }).list;
  return (
    <div style={S.wrap}>
      <button style={S.back} onClick={() => setCategory(null)}>← All formats</button>
      <div style={S.controls}>
        <h1 style={S.h1}>{catLabel(category)}</h1>
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
      </div>

      {err && <div className="load-err" style={{ marginBottom: 16 }}><span>{err}</span></div>}

      <div style={S.grid}>
        {shown.map((t) => (
          <div key={t.id} style={S.card}>
            <div style={S.cover}>
              {t.cover_url
                ? <img src={toLocal(t.cover_url)} alt={t.name} style={S.img} />
                : <span style={S.kindGlyph}>{t.kind === "carousel" || t.kind === "post" ? "▦" : "►"}</span>}
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

const S = {
  wrap: { maxWidth: 1080 },
  h1: { fontSize: 26, fontWeight: 600, margin: 0 },
  back: { border: "none", background: "none", color: "#6b6459", cursor: "pointer", fontSize: 13, padding: "2px 0", marginBottom: 8 },
  controls: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, flexWrap: "wrap", margin: "0 0 20px" },
  shootAs: { display: "flex", alignItems: "center", gap: 10 },
  shootAsLabel: { fontSize: 13, color: "#5a554c" },
  select: { border: "1px solid #d8d2c8", borderRadius: 8, padding: "7px 10px", fontSize: 14, background: "#fff" },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 18 },
  catCard: { textAlign: "left", border: "1px solid #e6e1d8", borderRadius: 14, background: "#fff", padding: "18px 18px 16px", cursor: "pointer", display: "flex", flexDirection: "column", gap: 8, minHeight: 130 },
  catName: { fontSize: 19, fontWeight: 600 },
  catBlurb: { fontSize: 13, color: "#6b665c", lineHeight: 1.45, flex: 1 },
  catCount: { fontSize: 12.5, color: "#5b3df5", fontWeight: 500 },
  card: { border: "1px solid #e6e1d8", borderRadius: 12, overflow: "hidden", background: "#fff", display: "flex", flexDirection: "column" },
  cover: { position: "relative", aspectRatio: "4 / 5", background: "#efece6", display: "flex", alignItems: "center", justifyContent: "center" },
  img: { width: "100%", height: "100%", objectFit: "cover" },
  kindGlyph: { fontSize: 52, color: "#b9b1a3" },
  mine: { position: "absolute", top: 10, right: 10, background: "#5b3df5", color: "#fff", fontSize: 11, padding: "3px 8px", borderRadius: 6 },
  body: { padding: "14px 14px 8px", flex: 1 },
  name: { fontWeight: 600, fontSize: 15, marginBottom: 6 },
  meta: { fontSize: 12, color: "#8a8478" },
  action: { padding: "12px 14px", borderTop: "1px solid #f0ece4", display: "flex", gap: 8, alignItems: "center" },
  publish: { border: "1px solid #cfc6f5", background: "#fff", color: "#5b3df5", borderRadius: 8, padding: "0 12px", height: 34, cursor: "pointer", fontSize: 13 },
  del: { border: "1px solid #e6d5d5", background: "#fff", color: "#b04a4a", borderRadius: 8, width: 34, height: 34, cursor: "pointer", fontSize: 18, lineHeight: 1 },
};
