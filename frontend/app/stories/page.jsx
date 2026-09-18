"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { post, errorText } from "../../lib/api";
import { useResource, Resource } from "../../components/Guard";
const toLocal = (u) => { if (!u) return u; try { const x = new URL(u); return x.pathname + x.search; } catch (_) { return u; } };

/**
 * Story — its own lane. Pick a GENRE, pick a STORY, then CAST it from the
 * catalogue (a person or a character per role) and create a multi-character
 * reel. The story is the script + open roles; nothing is baked to a face.
 */

const GENRE_LABEL = {
  romance: "Romance", drama: "Drama", friendship: "Friendship",
  festival: "Festival", slice_of_life: "Slice of life", comedy: "Comedy", other: "More",
};
const GENRE_BLURB = {
  romance: "First dates, confessions, the soft stuff.",
  drama: "Honest two-handers and the talks you can't postpone.",
  friendship: "Catch-ups, inside jokes, the group chat energy.",
  festival: "Function prep, festive chaos, family plans.",
  slice_of_life: "Everyday, relatable, first-person.",
  comedy: "Bickering, bits, the daily nonsense.",
  other: "Everything else.",
};
const label = (g) => GENRE_LABEL[g] || (g ? g[0].toUpperCase() + g.slice(1) : "More");

export default function Stories() {
  const stories = useResource("/stories");
  const castOpts = useResource("/stories/cast-options");
  return (
    <>
      <div className="topbar">
        <div className="crumb"><b>Story</b></div>
      </div>
      <div className="page">
        <Resource state={stories}>
          {(d) => (
            <Resource state={castOpts}>
              {(c) => <Browse stories={d.stories || []} cast={c.cast || []} />}
            </Resource>
          )}
        </Resource>
      </div>
    </>
  );
}

function Browse({ stories, cast }) {
  const router = useRouter();
  const [genre, setGenre] = useState(null);       // null = genre grid
  const [story, setStory] = useState(null);       // null = story list
  const [casting, setCasting] = useState({});     // { roleKey: avatarId }
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const genres = useMemo(() => {
    const by = new Map();
    for (const s of stories) {
      const g = s.genre || "other";
      if (!by.has(g)) by.set(g, []);
      by.get(g).push(s);
    }
    return [...by.entries()].map(([key, list]) => ({ key, list }));
  }, [stories]);

  if (!stories.length) {
    return <p className="hint">No stories yet — the story library appears here.</p>;
  }

  // ── Step 3: cast the selected story ──────────────────────────────────────
  if (story) {
    const roles = story.roles || [];
    const allCast = roles.every((r) => casting[r.key]);
    async function create() {
      setErr(null); setBusy(true);
      try {
        await post(`/templates/${story.id}/apply-story`, { casting });
        router.push("/shoots");
      } catch (e) { setErr(errorText(e)); } finally { setBusy(false); }
    }
    return (
      <div style={S.wrap}>
        <button style={S.back} onClick={() => { setStory(null); setCasting({}); setErr(null); }}>← {label(story.genre)}</button>
        <h1 style={S.h1}>{story.name}</h1>
        {story.brief?.concept && <p className="hint" style={{ marginTop: 4 }}>{story.brief.concept}</p>}
        <p className="hint" style={{ marginTop: 2 }}>{story.scene_count} scene{story.scene_count === 1 ? "" : "s"} · {story.frame_count} shots · cast {roles.length} role{roles.length === 1 ? "" : "s"} from your catalogue.</p>

        {err && <div className="load-err" style={{ margin: "12px 0" }}><span>{err}</span></div>}

        {!cast.length && (
          <p className="hint" style={{ marginTop: 12 }}>
            No avatars ready to cast yet — build or catalogue an avatar first, then come back.
          </p>
        )}

        {roles.map((role) => (
          <div key={role.key} style={S.roleBlock}>
            <div style={S.roleHead}>
              <span style={S.roleLabel}>{role.label}</span>
              {role.hint && <span style={S.roleHint}>{role.hint}</span>}
            </div>
            <div style={S.castRow}>
              {cast.map((a) => {
                const on = casting[role.key] === a.id;
                return (
                  <button key={a.id} onClick={() => setCasting((c) => ({ ...c, [role.key]: a.id }))}
                    style={{ ...S.castCard, ...(on ? S.castCardOn : {}) }} title={a.name}>
                    <span style={S.castThumb}>
                      {a.preview_url
                        ? <img src={toLocal(a.preview_url)} alt={a.name} style={S.castImg} />
                        : <span style={S.castGlyph}>{a.subject_type === "character" ? "◆" : "◑"}</span>}
                    </span>
                    <span style={S.castName}>{a.name}</span>
                    <span style={S.castKind}>{a.subject_type === "character" ? "character" : "person"}{a.is_catalogue ? " · catalogue" : ""}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}

        <div style={{ marginTop: 20 }}>
          <button className="btn" disabled={busy || !allCast || !cast.length} onClick={create}>
            {busy ? "Creating…" : allCast ? "Create story reel →" : "Cast every role to continue"}
          </button>
        </div>
      </div>
    );
  }

  // ── Step 2: stories in the chosen genre ──────────────────────────────────
  if (genre) {
    const g = genres.find((x) => x.key === genre);
    const list = g ? g.list : [];
    return (
      <div style={S.wrap}>
        <button style={S.back} onClick={() => setGenre(null)}>← All genres</button>
        <h1 style={S.h1}>{label(genre)}</h1>
        <p className="hint" style={{ marginTop: 2 }}>{GENRE_BLURB[genre] || ""}</p>
        <div style={S.grid}>
          {list.map((s) => (
            <button key={s.id} style={S.storyCard} onClick={() => { setStory(s); setCasting({}); }}>
              <div style={S.storyName}>{s.name}</div>
              {s.brief?.concept && <div style={S.storyConcept}>{s.brief.concept}</div>}
              <div style={S.storyMeta}>{(s.roles || []).length} role{(s.roles || []).length === 1 ? "" : "s"} · {s.frame_count} shots</div>
              <div style={S.storyGo}>Cast it →</div>
            </button>
          ))}
        </div>
      </div>
    );
  }

  // ── Step 1: genres ───────────────────────────────────────────────────────
  return (
    <div style={S.wrap}>
      <h1 style={S.h1}>Story</h1>
      <p className="hint" style={{ marginTop: 2, marginBottom: 18 }}>
        Pick a genre, pick a story, then cast it from your catalogue — a person or a character in each role.
      </p>
      <div style={S.grid}>
        {genres.map((g) => (
          <button key={g.key} style={S.genreCard} onClick={() => setGenre(g.key)}>
            <div style={S.genreName}>{label(g.key)}</div>
            <div style={S.genreBlurb}>{GENRE_BLURB[g.key] || ""}</div>
            <div style={S.genreCount}>{g.list.length} stor{g.list.length === 1 ? "y" : "ies"} →</div>
          </button>
        ))}
      </div>
    </div>
  );
}

const S = {
  wrap: { maxWidth: 1000 },
  h1: { fontSize: 30, fontWeight: 600, margin: "6px 0 0" },
  back: { border: "none", background: "none", color: "#6b6459", cursor: "pointer", fontSize: 13, padding: "2px 0", marginBottom: 6 },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 16, marginTop: 18 },
  genreCard: { textAlign: "left", border: "1px solid #e6e1d8", borderRadius: 14, background: "#fff", padding: "18px 18px 16px", cursor: "pointer", display: "flex", flexDirection: "column", gap: 8, minHeight: 130 },
  genreName: { fontSize: 19, fontWeight: 600 },
  genreBlurb: { fontSize: 13, color: "#6b665c", lineHeight: 1.45, flex: 1 },
  genreCount: { fontSize: 12.5, color: "#5b3df5", fontWeight: 500 },
  storyCard: { textAlign: "left", border: "1px solid #e6e1d8", borderRadius: 14, background: "#fff", padding: "16px", cursor: "pointer", display: "flex", flexDirection: "column", gap: 8 },
  storyName: { fontSize: 16, fontWeight: 600 },
  storyConcept: { fontSize: 12.5, color: "#6b665c", lineHeight: 1.4, flex: 1 },
  storyMeta: { fontSize: 12, color: "#8a8478" },
  storyGo: { fontSize: 12.5, color: "#5b3df5", fontWeight: 500 },
  roleBlock: { marginTop: 20 },
  roleHead: { display: "flex", alignItems: "baseline", gap: 10, marginBottom: 8 },
  roleLabel: { fontSize: 15, fontWeight: 600 },
  roleHint: { fontSize: 12, color: "#9a9284" },
  castRow: { display: "flex", gap: 10, flexWrap: "wrap" },
  castCard: { width: 116, border: "1px solid #e0dace", borderRadius: 12, background: "#fff", padding: 8, cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 6 },
  castCardOn: { borderColor: "#5b3df5", boxShadow: "0 0 0 2px rgba(91,61,245,.25)" },
  castThumb: { width: "100%", aspectRatio: "1 / 1", borderRadius: 9, overflow: "hidden", background: "#efece6", display: "flex", alignItems: "center", justifyContent: "center" },
  castImg: { width: "100%", height: "100%", objectFit: "cover" },
  castGlyph: { fontSize: 28, color: "#b9b1a3" },
  castName: { fontSize: 13, fontWeight: 500, textAlign: "center" },
  castKind: { fontSize: 10.5, color: "#9a9284", textAlign: "center" },
};
