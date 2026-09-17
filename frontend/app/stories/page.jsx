"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { post, errorText } from "../../lib/api";
import { useResource, Resource } from "../../components/Guard";
const toLocal = (u) => { if (!u) return u; try { const x = new URL(u); return x.pathname + x.search; } catch (_) { return u; } };

/**
 * Stories — the ready-to-go, multi-character library (facelessreels-style).
 *
 * A story is a template with its CAST baked in: pick a story and a reel is
 * created with those characters and their dialogue already written. There is no
 * avatar to choose — the cast are catalogue avatars the app auto-selects for you
 * on apply. A story whose cast is not fully in the catalogue yet shows as
 * "Coming soon" until it is. Applying is a normal multi-character shoot through
 * the orchestrator — same quota, same pipeline.
 */

export default function Stories() {
  const stories = useResource("/stories");
  return (
    <>
      <div className="topbar">
        <div className="crumb"><b>Stories</b></div>
      </div>
      <div className="page">
        <Resource state={stories}>
          {(d) => <Browse stories={d.stories || []} />}
        </Resource>
      </div>
    </>
  );
}

function Browse({ stories }) {
  const router = useRouter();
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState(null);

  async function create(story) {
    if (!story.available) return;
    setErr(null);
    setBusy(story.id);
    try {
      await post(`/templates/${story.id}/apply-story`, {});
      router.push("/shoots");
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  if (!stories.length) {
    return (
      <p className="hint">
        No stories yet — the ready-to-go story library appears here. Each one is a
        multi-character reel with the cast already cast for you.
      </p>
    );
  }

  return (
    <div style={S.wrap}>
      <p className="hint" style={{ marginTop: 0 }}>
        Pick a story and a multi-character reel is created for you — the cast and
        the dialogue are already written. Nothing to set up: the characters are
        catalogue avatars, added to your workspace when you create the reel.
      </p>

      {err && <div className="load-err" style={{ marginBottom: 16 }}><span>{err}</span></div>}

      <div style={S.grid}>
        {stories.map((story) => (
          <div key={story.id} style={S.card}>
            <div style={S.cover}>
              {story.cover_url
                ? <img src={toLocal(story.cover_url)} alt={story.name} style={S.img} />
                : <span style={S.kindGlyph}>►</span>}
              <span style={S.badge}>Story</span>
              {!story.available && <span style={S.soon}>Coming soon</span>}
            </div>
            <div style={S.body}>
              <div style={S.name}>{story.name}</div>
              {story.brief?.concept && <div style={S.concept}>{story.brief.concept}</div>}
              <div style={S.castRow}>
                {(story.cast || []).map((c) => (
                  <span key={c.key} style={{ ...S.castChip, ...(c.available ? {} : S.castChipOff) }} title={c.available ? "In the catalogue" : "Not in the catalogue yet"}>
                    {c.name}{c.role === "lead" ? " · lead" : ""}
                  </span>
                ))}
              </div>
              <div style={S.meta}>{story.frame_count} shot{story.frame_count === 1 ? "" : "s"} · {story.clip_seconds}s each</div>
            </div>
            <div style={S.action}>
              <button
                className="btn"
                disabled={busy === story.id || !story.available}
                onClick={() => create(story)}
              >
                {busy === story.id ? "Creating…" : story.available ? "Create story reel →" : "Coming soon"}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const S = {
  wrap: { maxWidth: 1080 },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 18 },
  card: { border: "1px solid #e6e1d8", borderRadius: 12, overflow: "hidden", background: "#fff", display: "flex", flexDirection: "column" },
  cover: { position: "relative", aspectRatio: "4 / 5", background: "#efece6", display: "flex", alignItems: "center", justifyContent: "center" },
  img: { width: "100%", height: "100%", objectFit: "cover" },
  kindGlyph: { fontSize: 52, color: "#b9b1a3" },
  badge: { position: "absolute", top: 10, left: 10, background: "rgba(91,61,245,.85)", color: "#fff", fontSize: 11, padding: "3px 8px", borderRadius: 6, letterSpacing: ".03em" },
  soon: { position: "absolute", top: 10, right: 10, background: "rgba(20,20,20,.62)", color: "#fff", fontSize: 11, padding: "3px 8px", borderRadius: 6 },
  body: { padding: "14px 14px 8px", flex: 1 },
  name: { fontWeight: 600, fontSize: 15, marginBottom: 6 },
  concept: { fontSize: 12.5, color: "#6b665c", lineHeight: 1.4, marginBottom: 10 },
  castRow: { display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 },
  castChip: { border: "1px solid #d7cff5", background: "#f4f1ff", color: "#4b34c9", borderRadius: 999, padding: "3px 9px", fontSize: 11.5 },
  castChipOff: { border: "1px solid #ddd7cd", background: "#f3f0ea", color: "#9a9284" },
  meta: { fontSize: 12, color: "#8a8478" },
  action: { padding: "12px 14px", borderTop: "1px solid #f0ece4", display: "flex", gap: 8, alignItems: "center" },
};
