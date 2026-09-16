'use client';

import { post } from '../../../lib/api';
import { useResource, Resource } from '../../../components/Guard';
import { AdminPage, Action, Pill, ago } from '../../../components/Admin';

/**
 * Clone consents (admin back office).
 *
 * A review surface: watch the recorded consent video, then approve. Approving
 * marks the record verified — a human review path alongside the automated
 * same-person match run at ingest (which still enforces "the footage must be
 * this person" regardless of what is approved here).
 */

// Play stored media through the same-origin proxy (/api/studio/files/... on
// :3100 → :3000), never the raw absolute URL — the app's standard for media.
function toLocal(u) {
  if (!u) return u;
  try { const x = new URL(u, window.location.origin); return x.pathname + x.search; } catch { return u; }
}

export default function AdminConsents() {
  const state = useResource('/admin/consents');
  return (
    <AdminPage
      title="Clone consents"
      deck="Watch the consent video, then approve. Ingest still matches the footage to this video regardless."
    >
      <Resource state={state}>{(d) => (
        !d.consents.length
          ? <p className="hint adm-empty">No twin consents recorded yet.</p>
          : (
            <div style={{ display: 'grid', gap: 16 }}>
              {d.consents.map((c) => (
                <div key={c.consent_id} className="card prof-card">
                  <div className="plan-head">
                    <span className="label">{c.avatar_name}</span>
                    {c.verified ? <Pill kind="ok">verified</Pill> : <Pill kind="warn">pending</Pill>}
                  </div>
                  <p className="helper">
                    Consenting as <b>{c.subject_name || '—'}</b> · tenant {c.tenant_id} · recorded {ago(c.created_at)}
                    {c.match_score ? ` · footage match ${c.match_score}` : ''}
                  </p>
                  {c.video_url
                    ? <video src={toLocal(c.video_url)} controls playsInline
                             style={{ width: '100%', maxWidth: 460, borderRadius: 10, background: '#000', marginTop: 6 }} />
                    : <p className="helper">No consent video was recorded.</p>}
                  {!c.verified && (
                    <div style={{ marginTop: 12 }}>
                      <Action
                        label="Approve consent"
                        busyLabel="Approving…"
                        confirm={`Approve consent for "${c.avatar_name}"? Confirm the person in the video consented.`}
                        run={() => post(`/admin/consents/${c.avatar_id}/approve`, {})}
                        onDone={state.reload}
                      />
                    </div>
                  )}
                </div>
              ))}
            </div>
          )
      )}</Resource>
    </AdminPage>
  );
}
