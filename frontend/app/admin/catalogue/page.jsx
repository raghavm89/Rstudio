"use client";

import { useState } from "react";
import { api, post } from "../../../lib/api";
import { useResource, Resource } from "../../../components/Guard";
import { AdminPage, Stats, Table, Action, ago, nullish } from "../../../components/Admin";

/**
 * Catalogue management (admin).
 *
 * The catalogue is the shared avatar library every tenant browses. Adding a face
 * publishes an already-built avatar — it must have a trained LoRA, a look profile
 * and calibration baselines, or it could not be shot the instant a customer picks
 * it, so the picker below only offers avatars that qualify. Removing a face clears
 * the flag (reversible) and is refused while customers have it selected.
 */
export default function AdminCatalogue() {
  const state = useResource("/admin/catalogue");
  return (
    <AdminPage
      title="Catalogue"
      deck="The shared avatar library. Publishing and removing here write across every tenant."
    >
      <Resource state={state}>{(d) => <Body d={d} reload={state.reload} />}</Resource>
    </AdminPage>
  );
}

function Body({ d, reload }) {
  const adoptions = d.catalogue.reduce((a, c) => a + (c.selections || 0), 0);
  return (
    <>
      <Stats items={[
        { label: "In catalogue", value: d.catalogue.length },
        { label: "Ready to publish", value: d.publishable.length },
        { label: "Total adoptions", value: adoptions },
      ]} />

      <AddForm publishable={d.publishable} reload={reload} />

      <h3 className="adm-h" style={{ marginTop: 28 }}>In the catalogue</h3>
      <Table
        cols={[
          { key: "name", label: "Avatar", render: (r) => <b>{r.name}</b> },
          { key: "region", label: "Region", render: (r) => nullish(r.region) },
          { key: "selections", label: "Adoptions", align: "right", render: (r) => r.selections },
          { key: "published", label: "Published", render: (r) => ago(r.catalogue_published_at) },
          { key: "act", label: "", align: "right", render: (r) => (
              <Action
                label="Remove"
                busyLabel="Removing…"
                confirm={`Remove "${r.name}" from the catalogue? Customers can no longer pick it. This is reversible.`}
                run={() => api(`/admin/catalogue/${r.id}`, { method: "DELETE" })}
                onDone={reload}
              />
            ) },
        ]}
        rows={d.catalogue}
        empty="No avatars in the catalogue yet — publish a built one below."
      />
    </>
  );
}

function AddForm({ publishable, reload }) {
  const [avatarId, setAvatarId] = useState(publishable[0]?.id ?? "");
  const [region, setRegion] = useState("");

  if (!publishable.length) {
    return (
      <p className="hint adm-empty">
        No avatars are ready to publish yet. An avatar needs a trained LoRA, a look
        profile and calibration baselines before it can go in the catalogue — build one
        through the normal seed → train → calibrate flow first.
      </p>
    );
  }

  return (
    <section className="adm-card" style={{ padding: 16, border: "1px solid #e6e1d8", borderRadius: 10, margin: "8px 0 4px" }}>
      <div style={{ fontWeight: 600, marginBottom: 10 }}>Add an avatar to the catalogue</div>
      <div style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
        <label style={{ display: "flex", flexDirection: "column", fontSize: 12, gap: 4 }}>
          Built avatar
          <select value={avatarId} onChange={(e) => setAvatarId(Number(e.target.value))}
                  style={{ padding: "7px 10px", minWidth: 220 }}>
            {publishable.map((a) => (
              <option key={a.id} value={a.id}>{a.name} · #{a.id} (tenant {a.tenant_id})</option>
            ))}
          </select>
        </label>
        <label style={{ display: "flex", flexDirection: "column", fontSize: 12, gap: 4 }}>
          Region (optional)
          <input value={region} onChange={(e) => setRegion(e.target.value)}
                 placeholder="delhi, punjab…" style={{ padding: "7px 10px", minWidth: 160 }} />
        </label>
        <Action
          label="Publish to catalogue"
          busyLabel="Publishing…"
          run={() => post("/admin/catalogue", { avatarId: Number(avatarId), region: region.trim() || null })}
          onDone={() => { setRegion(""); reload(); }}
        />
      </div>
    </section>
  );
}
