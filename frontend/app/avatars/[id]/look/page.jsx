'use client';

import { useState } from 'react';
import { Steps } from '../../../../components/Shell';
import { useResource, Resource } from '../../../../components/Guard';
import { put, ApiError } from '../../../../lib/api';

/**
 * Set the look.
 *
 * Seven choices, frozen once the likeness check is calibrated. The interesting
 * half of this screen is the right rail.
 *
 * THE DARK PANEL is the only dark surface in the app, and it is here rather than
 * anywhere else on purpose. Direction C's risk is reading unserious to an agency
 * buyer at ₹15,000 a month — rounded corners and friendly labels can look like a
 * toy. So at exactly the point where a buyer is evaluating, the app shows the
 * real assembled prompt, and beneath it the phrases that are NEVER SENT, struck
 * through.
 *
 * That second list is the actual argument. Every phrase in it is one that makes
 * an image look like an AI image, and none of them exists anywhere in the
 * vocabulary — so no combination of these pickers can emit them. A prompt box
 * cannot make that promise; a closed vocabulary can. The panel is how you show
 * it rather than claim it.
 *
 * The labels are human ("Skin", "Grain") while the fragments underneath stay
 * technical. Friendly language, not hidden data — the same rule as the QC pill
 * reading "Likeness · 0.91 / 0.89".
 */

export default function SetHerLookPage({ params }) {
  const avatarId = params.id;
  const state = useResource(`/avatars/${avatarId}/look`);
  return (
    <Resource state={state}>
      {(data) => <SetHerLook avatarId={avatarId} data={data} state={state} />}
    </Resource>
  );
}

function SetHerLook({ avatarId, data, state }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  async function choose(field, value) {
    if (data.frozen || saving) return;
    setSaving(true);
    setError(null);
    // Optimistic, because a picker that lags feels broken. The response is
    // authoritative — it carries the newly assembled prompt, which is the whole
    // reason to make the round trip at all.
    state.mutate({ ...data, profile: { ...data.profile, [field]: value } });
    try {
      state.mutate(await put(`/avatars/${avatarId}/look`, { [field]: value }));
    } catch (err) {
      // Put the optimistic guess back where it came from. A picker that keeps
      // showing a choice the server refused is worse than one that lags.
      setError(err instanceof ApiError ? err.message : String(err));
      await state.reload();
    } finally {
      setSaving(false);
    }
  }

  const p = data.profile || {};

  return (
    <>
      <div className="topbar">
        <div className="crumb"><b>{data.avatar.name}</b><span>·</span><span>Set the look</span></div>
        <Steps current="look" avatarId={avatarId} />
      </div>

      <div className="look">
        <div className="look-main">
          <h1>How the photos should feel</h1>
          <p className="hint look-intro">
            Chosen once and kept. Every photo uses these, which is what makes a
            feed look like one person shot it rather than a folder of stock images.
          </p>

          {data.frozen && (
            <div className="frozen-note">
              <span className="pill warn">Locked</span>
              <span>
                The likeness check was calibrated against photos taken with these settings.
                Changing them now would judge every future photo against a face made a
                different way.
              </span>
            </div>
          )}

          {data.facets.map((facet) => (
            <section className="facet" key={facet.key}>
              <div className="facet-head">
                <h3>{facet.label}</h3>
                {facet.note && <span className="helper facet-note">{facet.note}</span>}
              </div>
              <div className="facet-opts">
                {(data.options[facet.key] || []).map((o) => (
                  <button
                    key={o.key}
                    className={`chip ${p[facet.key] === o.key ? 'on' : ''}`}
                    disabled={data.frozen}
                    onClick={() => choose(facet.key, o.key)}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </section>
          ))}

          <section className="facet">
            <div className="facet-head"><h3>Detail</h3></div>
            <div className="toggles">
              {data.toggles.map((t) => (
                <button
                  key={t.key}
                  className={`toggle ${p[t.key] ? 'on' : ''}`}
                  disabled={data.frozen}
                  onClick={() => choose(t.key, !p[t.key])}
                >
                  <span className="box">{p[t.key] ? '✓' : ''}</span>
                  <span>
                    <b>{t.label}</b>
                    {t.note && <span className="helper">{t.note}</span>}
                  </span>
                </button>
              ))}
            </div>
          </section>

          {error && <p className="look-error">{error}</p>}
        </div>

        {/* The counterweight. Only dark surface in the app, placed where a buyer
            is deciding whether this is serious. */}
        <aside className="rail">
          <div className="rail-head">
            <h3>What gets sent</h3>
            {data.preview && !data.preview.trained && (
              <span className="pill warn">Not trained yet</span>
            )}
          </div>

          <pre className="prompt mono">{data.preview?.prompt || '—'}</pre>

          {data.preview && !data.preview.trained && (
            <p className="rail-note">
              <code className="mono">TRIGGER</code> stands in for the character model, which does not
              exist yet. Everything after it is exactly what will be sent.
            </p>
          )}

          <div className="never">
            <h4>Never sent</h4>
            <p className="rail-note">
              No option above can produce these. They are not filtered out — there is no
              row in the vocabulary that emits them.
            </p>
            <ul>
              {data.never_sent.map((phrase) => <li key={phrase}>{phrase}</li>)}
            </ul>
          </div>
        </aside>
      </div>
    </>
  );
}
