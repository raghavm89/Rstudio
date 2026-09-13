'use client';

import { useState } from 'react';
import Link from 'next/link';
import { put, errorText } from '../../lib/api';
import { useResource, Resource } from '../../components/Guard';
import { useAuth } from '../../components/AuthProvider';
import { buyCredits, subscribeToPlan } from '../../lib/checkout';

/**
 * Billing — the plan, the credits, the invoices, and where to send them.
 *
 * Prices are GST-exclusive, so every figure that a customer will actually be
 * charged shows the tax alongside it. A page that says ₹2,000 and a checkout
 * that asks for ₹2,360 is a page that gets abandoned at the last step.
 */
export default function BillingPage() {
  const plans    = useResource('/plans');
  const profile  = useResource('/profile');
  const credits  = useResource('/billing/credits');
  const invoices = useResource('/invoices');

  return (
    <div className="page prof">
      <h1>Billing</h1>
      <p className="hint prof-deck">
        One credit is one photo; a video is about six. See{' '}
        <Link className="lnk" href="/usage">Usage</Link> for what you have spent.
        Prices exclude GST.
      </p>

      <AddressNotice profile={profile} />

      <Resource state={plans}>
        {(d) => <>
          <Plans data={d} profile={profile} />
          <Topups data={d} credits={credits} profile={profile} />
        </>}
      </Resource>

      <Resource state={invoices}>{(d) => <Invoices data={d} />}</Resource>

      <Resource state={profile}>
        {(d) => <BillingForm key={d.account.email} data={d} state={profile} />}
      </Resource>
    </div>
  );
}

const rs = (n) => `₹${Number(n).toLocaleString('en-IN')}`;

/**
 * Shown above the plans when nothing here can be bought yet.
 *
 * Before the click, not after it. Discovering a missing address at the moment
 * you press Choose is a worse experience than being told while you were still
 * reading the prices — and it is the difference between a form to fill and a
 * checkout that appeared to break.
 */
function AddressNotice({ profile }) {
  const { complete, missing } = addressGate(profile);
  if (complete) return null;
  return (
    <div className="lp-msg warn" role="status">
      <b>Add your billing address to buy anything</b>
      <span>
        We still need your {joinLabels(missing)}. Every payment here is invoiced
        with GST, and the invoice cannot be issued without it —{' '}
        <button type="button" className="lnk" onClick={() => goToAddress(missing)}>
          fill it in below
        </button>.
      </span>
    </div>
  );
}

/**
 * Whether we could invoice this account, and what is missing if not.
 *
 * The server computes it — `/profile` returns `billing_complete` and
 * `billing_missing` from the same list the payment endpoints refuse on. The
 * browser deliberately does not have its own copy: two lists drift, and this
 * is the one nobody would remember to update.
 *
 * While the profile is still loading we report complete. Blocking on data we
 * have not got yet would disable the buttons on every page load; the server
 * refuses anyway, and that path is handled below.
 */
function addressGate(profile) {
  const d = profile?.data;
  if (!d) return { complete: true, missing: [] };
  return { complete: d.billing_complete !== false, missing: d.billing_missing || [] };
}

function joinLabels(missing) {
  const l = missing.map((m) => m.label);
  if (l.length <= 1) return l[0] || 'billing address';
  return `${l.slice(0, -1).join(', ')} and ${l[l.length - 1]}`;
}

/** Take them to the field they need, rather than telling them it exists. */
function goToAddress(missing) {
  if (typeof document === 'undefined') return;
  const section = document.getElementById('billing-address');
  section?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const first = missing?.[0]?.field;
  // After the scroll, or the focus fights it.
  if (first) setTimeout(() => document.getElementById(first)?.focus({ preventScroll: true }), 400);
}

/**
 * The refusal the server sends when the address is not there yet.
 * Recognised by code, not by message — the message is written for a person and
 * will be reworded.
 */
const needsAddress = (e) => e?.body?.code === 'BILLING_ADDRESS_REQUIRED' || e?.code === 'BILLING_ADDRESS_REQUIRED';

function Plans({ data, profile }) {
  const { user } = useAuth();
  const [busy, setBusy] = useState(null);
  const [err, setErr]   = useState(null);
  const [done, setDone] = useState(null);

  const gate = addressGate(profile);

  async function choose(slug) {
    setDone(null);
    // Checked before the modal opens rather than after the payment. A Razorpay
    // window that appears and then fails on the way back is the worst version
    // of this: the person has entered a UPI PIN by then.
    if (!gate.complete) {
      setErr(`A GST invoice needs your ${joinLabels(gate.missing)}. Fill in Billing address below, save it, then choose a plan.`);
      goToAddress(gate.missing);
      return;
    }

    setBusy(slug); setErr(null);
    try {
      await subscribeToPlan({ slug, user });
      // Not "you are on Pro". A subscription becomes active when the webhook
      // sees the first charge captured, which can happen after this tab closes.
      setDone('Payment received. Your plan activates as soon as the charge settles — usually under a minute.');
    } catch (e) {
      // errorText keeps the half that says what to do about it; see lib/api.js.
      if (e.cancelled) return;
      setErr(errorText(e));
      // A tab open since before the address was cleared elsewhere. Re-read it so
      // the buttons agree with the server from here on.
      if (needsAddress(e)) { profile?.reload?.(); goToAddress(e.body?.missing?.map((f) => ({ field: f })) || []); }
    } finally { setBusy(null); }
  }

  return (
    <>
      <section className="plans">
        {data.plans.map((p) => {
          const gst = Math.round(p.price * (data.gst_rate ?? 18) / 100);
          return (
            <article className={`card plan${p.current ? ' on' : ''}`} key={p.slug}>
              <div className="plan-head">
                <span className="label">{p.name}</span>
                {p.current && <span className="pill ok">Current</span>}
              </div>

              <div className="plan-price">
                {p.price === 0
                  ? <span className="plan-n">Free</span>
                  : <><span className="plan-n">{rs(p.price)}</span><span className="hint">/{p.interval}</span></>}
              </div>
              {p.price > 0 && (
                <span className="helper">+ {rs(gst)} GST · {rs(p.price + gst)} charged</span>
              )}

              <p className="plan-tag">{p.tagline}</p>

              <div className="plan-credits">
                <b>{p.credits.toLocaleString('en-IN')}</b> credits a month
              </div>

              <ul className="plan-ents">
                {p.entitlements.map((e) => (
                  <li key={e.metric}>
                    <b>{e.value === 0 ? 'No' : e.value.toLocaleString('en-IN')}</b> {e.label.toLowerCase()}
                    <span className="helper">{e.period === 'month' ? 'per month' : 'total'}</span>
                  </li>
                ))}
              </ul>

              {p.current || p.price === 0 ? (
                <button className="btn ghost sm" disabled>
                  {p.current ? 'Your plan' : 'Included'}
                </button>
              ) : p.purchasable === false ? (
                /* The server says this plan has no Razorpay counterpart yet.
                   Offering the button anyway means every click ends in an error
                   banner — the card should say so once, quietly, instead. */
                <button className="btn ghost sm" disabled title="No Razorpay plan is linked to this yet">
                  Not available yet
                </button>
              ) : (
                <button className="btn sm" disabled={busy === p.slug} onClick={() => choose(p.slug)}>
                  {busy === p.slug ? 'Opening…' : `Choose ${p.name}`}
                </button>
              )}
            </article>
          );
        })}
      </section>

      {done && <div className="lp-msg" role="status"><b>Thank you</b><span>{done}</span></div>}
      {err && (
        <div className="lp-msg warn" role="alert">
          <b>Checkout did not start</b>
          <span>{err}</span>
        </div>
      )}
    </>
  );
}

function Topups({ data, credits, profile }) {
  const { user } = useAuth();
  const packs = data.topups || [];
  const [busy, setBusy] = useState(false);
  const [err, setErr]   = useState(null);
  const [ok, setOk]     = useState(null);
  if (!packs.length) return null;

  const balance = credits.data?.balance ?? 0;

  const gate = addressGate(profile);

  async function buy(slug) {
    setOk(null);
    if (!gate.complete) {
      setErr(`A GST invoice needs your ${joinLabels(gate.missing)}. Fill in Billing address below and save it first.`);
      goToAddress(gate.missing);
      return;
    }

    setBusy(true); setErr(null);
    try {
      const out = await buyCredits({ slug, user });
      // Only after the SERVER verified the signature. The browser saying the
      // payment worked is not evidence that it did.
      setOk(`Added. Your balance is ${Number(out.balance).toLocaleString('en-IN')} credits.`);
      credits.reload();
    } catch (e) {
      if (e.cancelled) return;
      setErr(errorText(e));
      if (needsAddress(e)) { profile?.reload?.(); goToAddress(e.body?.missing?.map((f) => ({ field: f })) || []); }
    } finally { setBusy(false); }
  }

  return (
    <section className="card prof-card">
      <div className="plan-head">
        <span className="label">Bought credits</span>
        <span className="hint"><b>{Number(balance).toLocaleString('en-IN')}</b> in hand</span>
      </div>
      <p className="helper" style={{ marginBottom: 12 }}>
        Spent only after the month&rsquo;s plan allowance runs out. These do not expire.
      </p>

      <div className="topups">
        {packs.map((t) => {
          const gst = Math.round(t.price * (data.gst_rate ?? 18) / 100);
          return (
            <div className="topup" key={t.slug}>
              <div>
                <b>{t.credits.toLocaleString('en-IN')} credits</b>
                <span className="helper">
                  {rs(t.price)} + {rs(gst)} GST · {rs(t.price + gst)} charged
                </span>
              </div>
              <button className="btn ghost sm" disabled={busy} onClick={() => buy(t.slug)}>
                {busy ? 'Opening…' : 'Buy'}
              </button>
            </div>
          );
        })}
      </div>

      {ok && <p className="prof-saved">{ok}</p>}
      {err && <p className="prof-err">{err}</p>}
    </section>
  );
}

function Invoices({ data }) {
  const list = data.invoices || [];
  return (
    <section className="card prof-card">
      <div className="label">Invoices</div>
      {!list.length && <p className="hint">No invoices yet.</p>}
      {list.map((inv) => (
        <details className="inv" key={inv.id}>
          <summary>
            <span className="mono inv-no">{inv.number}</span>
            <span className="inv-desc">
              {inv.description}
              {inv.payment_ref && <span className="mono inv-ref">{inv.payment_ref}</span>}
            </span>
            <span className="inv-date helper">
              {new Date(inv.issued_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
            </span>
            <span className="inv-total"><b>{rs(inv.total.toFixed(2))}</b></span>
          </summary>

          <dl className="inv-lines">
            <div><dt>Subtotal</dt><dd className="mono">{rs(inv.subtotal.toFixed(2))}</dd></div>
            {/* Only the head that actually applies. Showing three rows where two
                are zero invites the question of why they are zero. */}
            {inv.cgst > 0 && <div><dt>CGST {inv.tax_rate / 2}%</dt><dd className="mono">{rs(inv.cgst.toFixed(2))}</dd></div>}
            {inv.sgst > 0 && <div><dt>SGST {inv.tax_rate / 2}%</dt><dd className="mono">{rs(inv.sgst.toFixed(2))}</dd></div>}
            {inv.igst > 0 && <div><dt>IGST {inv.tax_rate}%</dt><dd className="mono">{rs(inv.igst.toFixed(2))}</dd></div>}
            {!inv.taxed && <div><dt>Tax</dt><dd className="helper">Bill of supply — no GST charged</dd></div>}
            <div className="inv-sum"><dt>Total</dt><dd className="mono">{rs(inv.total.toFixed(2))}</dd></div>
          </dl>

          <dl className="inv-lines inv-meta">
            <div>
              <dt>Payment</dt>
              <dd className="mono">{inv.payment_ref || <span className="helper">not recorded</span>}</dd>
            </div>
            {inv.payment_method && (
              <div><dt>Paid by</dt><dd>{inv.payment_method}</dd></div>
            )}
            <div>
              <dt>Issued</dt>
              <dd>{new Date(inv.issued_at).toLocaleString('en-IN', {
                day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
              })}</dd>
            </div>
          </dl>

          <div className="inv-parties">
            <div>
              <span className="label">From</span>
              <p>{inv.seller?.name}</p>
              {inv.seller?.gstin && <p className="mono helper">GSTIN {inv.seller.gstin}</p>}
              {inv.seller?.address && <p className="helper">{inv.seller.address}</p>}
            </div>
            <div>
              <span className="label">To</span>
              <p>{inv.buyer?.name || '—'}</p>
              {inv.buyer?.gstin && <p className="mono helper">GSTIN {inv.buyer.gstin}</p>}
              {inv.buyer?.address && <p className="helper">{inv.buyer.address}</p>}
              {inv.place_of_supply && <p className="helper">Place of supply: {inv.place_of_supply}</p>}
            </div>
          </div>
        </details>
      ))}
      <p className="helper">
        Details come from <b>Billing address</b> below, as they were when the invoice was
        issued — changing them now does not alter an invoice already raised.
      </p>
    </section>
  );
}

function BillingForm({ data, state }) {
  const [form, setForm]   = useState({ ...data.billing });
  const [busy, setBusy]   = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr]     = useState(null);
  const [fieldErrors, setFieldErrors] = useState({});

  function field(k, v) {
    setForm((f) => ({ ...f, [k]: v }));
    setFieldErrors((e) => (e[k] ? { ...e, [k]: undefined } : e));
    setSaved(false);
  }

  async function save(e) {
    e.preventDefault();
    setBusy(true); setErr(null); setFieldErrors({}); setSaved(false);
    try {
      const out = await put('/profile', form);
      state.mutate(out);
      setForm({ ...out.billing });
      setSaved(true);
    } catch (e2) {
      if (e2?.needsSignIn) { state.fail(e2); return; }
      if (e2?.body?.fields) setFieldErrors(e2.body.fields);
      else setErr(errorText(e2, 'Could not save.'));
    } finally { setBusy(false); }
  }

  const isIndia = (form.billing_country || 'IN').toUpperCase() === 'IN';

  return (
    <form onSubmit={save}>
      <section className="card prof-card">
        <div className="label">Invoice details</div>

        <label className="field">
          <span className="field-label">Billed to</span>
          <input id="billing_name" value={form.billing_name} onChange={(e) => field('billing_name', e.target.value)}
                 placeholder={data.account.name || 'Company or individual name'} />
          <span className="helper">Often a company rather than a person.</span>
        </label>

        <label className="field">
          <span className="field-label">GSTIN</span>
          <input
            value={form.gstin} onChange={(e) => field('gstin', e.target.value.toUpperCase())}
            placeholder="27AAPFU0939F1ZV" className="mono" maxLength={15} spellCheck={false}
            aria-invalid={fieldErrors.gstin ? true : undefined}
          />
          {fieldErrors.gstin
            ? <span className="prof-err">{fieldErrors.gstin}</span>
            : <span className="helper">Optional. Needed only to claim input credit.</span>}
        </label>
      </section>

      <section className="card prof-card" id="billing-address">
        <div className="label">Billing address</div>

        <label className="field">
          <span className="field-label">Address</span>
          <input id="billing_line1"
                 value={form.billing_line1} onChange={(e) => field('billing_line1', e.target.value)}
                 placeholder="Street address" />
        </label>
        <label className="field">
          <span className="field-label">Address line 2</span>
          <input value={form.billing_line2} onChange={(e) => field('billing_line2', e.target.value)}
                 placeholder="Apartment, floor, landmark" />
        </label>

        <div className="prof-row">
          <label className="field">
            <span className="field-label">City</span>
            <input id="billing_city" value={form.billing_city} onChange={(e) => field('billing_city', e.target.value)} />
          </label>

          <label className="field">
            <span className="field-label">State</span>
            {/* A list, not a text box. This field decides whether GST is
                CGST+SGST or IGST, and three spellings of one state is a
                reconciliation problem nobody finds until quarter end. */}
            {isIndia ? (
              <select id="billing_state"
                      value={form.billing_state} onChange={(e) => field('billing_state', e.target.value)}
                      aria-invalid={fieldErrors.billing_state ? true : undefined}>
                <option value="">Choose…</option>
                {data.states.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            ) : (
              <input id="billing_state" value={form.billing_state} onChange={(e) => field('billing_state', e.target.value)} />
            )}
            {fieldErrors.billing_state && <span className="prof-err">{fieldErrors.billing_state}</span>}
          </label>

          <label className="field">
            <span className="field-label">PIN</span>
            <input id="billing_pin" value={form.billing_pin} onChange={(e) => field('billing_pin', e.target.value)}
                   className="mono" inputMode="numeric" maxLength={6}
                   aria-invalid={fieldErrors.billing_pin ? true : undefined} />
            {fieldErrors.billing_pin && <span className="prof-err">{fieldErrors.billing_pin}</span>}
          </label>
        </div>

        <label className="field prof-country">
          <span className="field-label">Country</span>
          <input id="billing_country" value={form.billing_country}
                 onChange={(e) => field('billing_country', e.target.value.toUpperCase())}
                 maxLength={2} className="mono" />
          <span className="helper">Two-letter code. IN for India.</span>
        </label>
      </section>

      <div className="prof-actions">
        <button className="btn" type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save details'}
        </button>
        {saved && <span className="prof-saved">Saved.</span>}
        {err && <span className="prof-err">{err}</span>}
      </div>
    </form>
  );
}
