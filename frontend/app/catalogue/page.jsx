"use client";

import { useState } from "react";
import { post, errorText } from "../../lib/api";
import { useResource, Resource } from "../../components/Guard";

/**
 * The shared catalogue — browse ready-made avatars and adopt one.
 *
 * This is the Free / Catalogue tier's whole onboarding: instead of the week of
 * bible -> seed -> cull -> train -> calibrate that a custom avatar needs, a
 * customer picks a face here and can shoot immediately. The avatar is SHARED
 * (offering-frozen-spec.md 1) and costs nothing to adopt — it was built once by
 * the platform. Selecting it consumes the plan's single avatar slot.
 */
export default function Catalogue() {
  const state = useResource("/catalogue");
  return (
    <>
      <div className="topbar">
        <div className="crumb"><b>Catalogue</b></div>
      </div>
      <div className="page">
        <Resource state={state}>{(d) => <Browse d={d} reload={state.reload} />}</Resource>
      </div>
    </>
  );
}

function Browse({ d, reload }) {
  const [region, setRegion] = useState("all");
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState(null);

  const regions = Array.from(new Set(d.catalogue.map((a) => a.region).filter(Boolean)));
  const shown = region === "all" ? d.catalogue : d.catalogue.filter((a) => a.region === region);

  async function choose(a) {
    setErr(null);
    setBusy(a.id);
    try {
      await post(`/catalogue/${a.id}/select`);
      await reload();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  if (!d.catalogue.length) {
    return (
      <p className="hint">
        The catalogue is empty for now — faces appear here once the platform
        publishes them. Your own avatar (Pro and up) is built from
        <span> </span><b>New avatar</b> instead.
      </p>
    );
  }

  return (
    <div style={S.wrap}>
      <p className="hint" style={{ marginTop: 0 }}>
        Pick a ready-made avatar and start posting today. It is shared, so it is
        not exclusive to you — an own, one-of-one avatar is a Pro feature.
      </p>

      {regions.length > 1 && (
        <div style={S.filters}>
          <Chip on={region === "all"} onClick={() => setRegion("all")}>All</Chip>
          {regions.map((r) => (
            <Chip key={r} on={region === r} onClick={() => setRegion(r)}>{cap(r)}</Chip>
          ))}
        </div>
      )}

      {err && <div className="load-err" style={{ marginBottom: 16 }}><span>{err}</span></div>}

      <div style={S.grid}>
        {shown.map((a) => (
          <div key={a.id} style={S.card}>
            <div style={S.face}>
              {a.preview_url
                ? <img src={a.preview_url} alt={a.name} style={S.img} />
                : <span style={S.initial}>{(a.name || "?")[0]}</span>}
              {a.region && <span style={S.region}>{cap(a.region)}</span>}
            </div>
            <div style={S.body}>
              <div style={S.name}>{a.name}</div>
              <div style={S.identity}>{a.identity_block}</div>
              <div style={S.meta}>
                {a.voice_id ? "Voice ready" : "Voice TBD"}
                <span> · </span>{a.disclosure_line}
              </div>
            </div>
            <div style={S.action}>
              {a.selected ? (
                <span style={S.selected}>✓ Your avatar</span>
              ) : !a.ready ? (
                <button className="btn" disabled title="Not published yet">Coming soon</button>
              ) : (
                <button className="btn" disabled={busy === a.id} onClick={() => choose(a)}>
                  {busy === a.id ? "Selecting…" : "Use this avatar"}
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Chip({ on, onClick, children }) {
  return (
    <button onClick={onClick} style={{ ...S.chip, ...(on ? S.chipOn : {}) }}>{children}</button>
  );
}

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

const S = {
  wrap: { maxWidth: 1080 },
  filters: { display: "flex", gap: 8, margin: "8px 0 20px", flexWrap: "wrap" },
  chip: { border: "1px solid #d8d2c8", background: "#fff", borderRadius: 999, padding: "6px 14px", cursor: "pointer", fontSize: 13 },
  chipOn: { background: "#141414", color: "#fff", borderColor: "#141414" },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 18 },
  card: { border: "1px solid #e6e1d8", borderRadius: 12, overflow: "hidden", background: "#fff", display: "flex", flexDirection: "column" },
  face: { position: "relative", aspectRatio: "4 / 5", background: "#efece6", display: "flex", alignItems: "center", justifyContent: "center" },
  img: { width: "100%", height: "100%", objectFit: "cover" },
  initial: { fontSize: 56, color: "#b9b1a3", fontWeight: 300 },
  region: { position: "absolute", top: 10, left: 10, background: "rgba(20,20,20,.72)", color: "#fff", fontSize: 11, padding: "3px 8px", borderRadius: 6, letterSpacing: ".04em" },
  body: { padding: "14px 14px 8px", flex: 1 },
  name: { fontWeight: 600, fontSize: 15, marginBottom: 6 },
  identity: { fontSize: 12.5, lineHeight: 1.5, color: "#5a554c", display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" },
  meta: { fontSize: 11, color: "#8a8478", marginTop: 10 },
  action: { padding: "12px 14px", borderTop: "1px solid #f0ece4" },
  selected: { color: "#28a745", fontWeight: 600, fontSize: 14 },
};
