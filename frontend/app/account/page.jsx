'use client';

import { useState } from 'react';
import Link from 'next/link';
import { put } from '../../lib/api';
import { useResource, Resource } from '../../components/Guard';

/**
 * Account — who you are.
 *
 * Split from billing on purpose. These are two different questions asked at two
 * different times: your name is set once at sign-up, a GSTIN is dug out of a
 * folder when the first invoice is due. One page holding both meant the person
 * who came to fix a typo in their name had to scroll past a tax form.
 *
 * Loading goes through `useResource`, which every other authenticated screen
 * uses. Written by hand, this page rendered the backend's own words — "Missing
 * or invalid Authorization header" — to anyone whose session had expired while
 * the tab sat open. `Resource` knows that a 401 means "taking you to sign in",
 * not "here is an error message".
 */
export default function AccountPage() {
  const state = useResource('/profile');
  return (
    <Resource state={state}>
      {(data) => <AccountForm key={data.account.email} data={data} state={state} />}
    </Resource>
  );
}

function AccountForm({ data, state }) {
  const [name, setName]   = useState(data.account.name || '');
  const [busy, setBusy]   = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr]     = useState(null);
  const [fieldErr, setFieldErr] = useState(null);

  const a = data.account;

  async function save(e) {
    e.preventDefault();
    setBusy(true); setErr(null); setFieldErr(null); setSaved(false);
    try {
      const out = await put('/profile', { name });
      state.mutate(out);
      setName(out.account.name || '');
      setSaved(true);
    } catch (e2) {
      // A dead session is not this form's problem to report — `useResource`
      // owns that, and the redirect is already on its way.
      if (e2?.needsSignIn) { state.fail(e2); return; }
      if (e2?.body?.fields?.name) setFieldErr(e2.body.fields.name);
      else setErr(e2.message || 'Could not save.');
    } finally { setBusy(false); }
  }

  return (
    <div className="page prof">
      <h1>Account</h1>
      <p className="hint prof-deck">
        Your name is what appears in the app. For the name on an invoice, see{' '}
        <Link className="lnk" href="/billing">Billing</Link>.
      </p>

      <form onSubmit={save}>
        <section className="card prof-card">
          <div className="label">You</div>

          <label className="field">
            <span className="field-label">Name</span>
            <input
              value={name}
              onChange={(e) => { setName(e.target.value); setSaved(false); setFieldErr(null); }}
              aria-invalid={fieldErr ? true : undefined}
            />
            {fieldErr && <span className="prof-err">{fieldErr}</span>}
          </label>

          <dl className="prof-read">
            <div>
              <dt>Email</dt>
              <dd>
                {a.email}
                {a.email_verified
                  ? <span className="pill ok">Verified</span>
                  : <span className="pill warn">Unverified</span>}
              </dd>
            </div>
            <div>
              <dt>Mobile</dt>
              <dd>
                {a.phone_number
                  ? <>
                      <span className="mono">{a.phone_number}</span>
                      {a.phone_verified
                        ? <span className="pill ok">Verified</span>
                        : <span className="pill warn">Unverified</span>}
                    </>
                  : <span className="hint">Not on this account</span>}
              </dd>
            </div>
          </dl>

          {/* Saying why, rather than leaving someone hunting for an edit control
              that does not exist. */}
          <p className="helper">
            Email and mobile are verified credentials, so they change through a
            verification step rather than here.
          </p>
        </section>

        <div className="prof-actions">
          <button className="btn" type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
          {saved && <span className="prof-saved">Saved.</span>}
          {err && <span className="prof-err">{err}</span>}
        </div>
      </form>
    </div>
  );
}
