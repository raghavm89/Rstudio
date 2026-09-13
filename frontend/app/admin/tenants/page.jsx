'use client';

import { useState } from 'react';
import { useResource, Resource } from '../../../components/Guard';
import { post } from '../../../lib/api';
import { AdminPage, Table, Pill, ago, num, rs, nullish, Action } from '../../../components/Admin';

/**
 * Accounts — who signed up and what they actually do.
 *
 * The columns are chosen to answer one question per column: is this account
 * real (people, avatars), is it alive (last job, jobs in 30 days), and is it
 * paying (plan, credits). A list that showed only names and dates would look
 * like growth and tell you nothing.
 */
export default function AdminTenants() {
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');
  const state = useResource(`/admin/tenants?q=${encodeURIComponent(term)}&limit=100`);
  const [open, setOpen] = useState(null);

  return (
    <AdminPage
      title="Accounts"
      deck="Every workspace on the platform. Search by workspace name or any member's email."
      actions={
        <form className="adm-search" onSubmit={(e) => { e.preventDefault(); setTerm(q.trim()); }}>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="name or email" />
          <button className="btn ghost sm" type="submit">Search</button>
        </form>
      }
    >
      <Resource state={state}>
        {(d) => (
          <>
            <Table
              rows={d.tenants}
              onRow={(r) => setOpen(r.id)}
              empty={term ? `Nothing matches “${term}”.` : 'No accounts yet.'}
              cols={[
                { key: 'name', label: 'Workspace', render: (r) => (
                  <><b>{r.name}</b><span className="helper adm-sub">{nullish(r.owner_email)}</span></>
                ) },
                { key: 'plan', label: 'Plan', render: (r) =>
                  r.plan ? <Pill kind="ok">{r.plan}</Pill> : <Pill>free</Pill> },
                { key: 'credit_balance', label: 'Credits', align: 'right', render: (r) => num(r.credit_balance) },
                { key: 'avatars', label: 'Avatars', align: 'right' },
                { key: 'jobs_30d', label: 'Jobs 30d', align: 'right' },
                { key: 'last_job_at', label: 'Last active', render: (r) => ago(r.last_job_at) },
                { key: 'created_at', label: 'Joined', render: (r) => ago(r.created_at) },
              ]}
            />
            {open && <TenantDrawer id={open} onClose={() => setOpen(null)} onChanged={state.reload} />}
          </>
        )}
      </Resource>
    </AdminPage>
  );
}

function TenantDrawer({ id, onClose, onChanged }) {
  const state = useResource(`/admin/tenants/${id}`);

  return (
    <div className="adm-drawer-bg" onClick={onClose}>
      <aside className="adm-drawer" onClick={(e) => e.stopPropagation()}>
        <button className="adm-drawer-x" onClick={onClose} aria-label="Close">×</button>
        <Resource state={state}>
          {(d) => (
            <>
              <h2>{d.tenant.name}</h2>
              <p className="hint">Workspace #{d.tenant.id} · joined {ago(d.tenant.created_at)}</p>

              <Grant tenantId={id} balance={d.credit_balance} onDone={() => { state.reload(); onChanged?.(); }} />

              <Sec label="People">
                <Table rows={d.users} cols={[
                  { key: 'email', label: 'Email', render: (r) => (
                    <><b>{r.email}</b><span className="helper adm-sub">{r.name}</span></>
                  ) },
                  { key: 'role', label: 'Role' },
                  { key: 'verified', label: 'Verified', render: (r) => (
                    <>{r.email_verified ? 'email' : ''}{r.email_verified && r.phone_verified ? ' + ' : ''}{r.phone_verified ? 'phone' : ''}
                      {!r.email_verified && !r.phone_verified ? nullish(null) : ''}</>
                  ) },
                  { key: 'billing', label: 'Billing address', render: (r) =>
                    r.billing_state ? `${r.billing_city || ''}, ${r.billing_state}` : nullish(null) },
                  { key: 'gstin', label: 'GSTIN' },
                ]} />
              </Sec>

              <Sec label="Avatars">
                <Table rows={d.avatars} empty="No avatars." cols={[
                  { key: 'name', label: 'Name' },
                  { key: 'mode', label: 'Mode' },
                  { key: 'status', label: 'Status' },
                  { key: 'loras', label: 'LoRAs', align: 'right' },
                  { key: 'created_at', label: 'Created', render: (r) => ago(r.created_at) },
                ]} />
              </Sec>

              <Sec label="Usage, last three months">
                <Table rows={d.usage} empty="Nothing generated yet." cols={[
                  { key: 'metric', label: 'Meter' },
                  { key: 'period_start', label: 'Period', render: (r) =>
                    new Date(r.period_start).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' }) },
                  { key: 'used', label: 'Used', align: 'right' },
                  { key: 'limit_value', label: 'Allowance', align: 'right' },
                  // Our cost, not theirs. The one number on this screen that is
                  // about the business rather than the customer.
                  { key: 'cost_cents', label: 'Our cost', align: 'right',
                    render: (r) => `$${(Number(r.cost_cents) / 100).toFixed(2)}` },
                ]} />
              </Sec>

              <Sec label="Credit ledger">
                <Table rows={d.ledger} empty="No credits bought or spent." cols={[
                  { key: 'kind', label: 'Kind' },
                  { key: 'credits', label: 'Credits', align: 'right' },
                  { key: 'metric', label: 'Meter' },
                  { key: 'note', label: 'Note' },
                  { key: 'created_at', label: 'When', render: (r) => ago(r.created_at) },
                ]} />
              </Sec>

              <Sec label="Payments">
                <Table rows={d.payments} empty="No payments." cols={[
                  { key: 'created_at', label: 'When', render: (r) => ago(r.created_at) },
                  { key: 'amount', label: 'Amount', align: 'right', render: (r) => rs(r.amount) },
                  { key: 'status', label: 'Status', render: (r) =>
                    <Pill kind={r.status === 'captured' ? 'ok' : r.status === 'failed' ? 'bad' : ''}>{r.status}</Pill> },
                  { key: 'method', label: 'Method' },
                  { key: 'razorpay_payment_id', label: 'Reference', render: (r) =>
                    <span className="mono">{nullish(r.razorpay_payment_id)}</span> },
                ]} />
              </Sec>
            </>
          )}
        </Resource>
      </aside>
    </div>
  );
}

function Sec({ label, children }) {
  return (
    <section className="adm-sec">
      <div className="label">{label}</div>
      {children}
    </section>
  );
}

/**
 * Granting credits.
 *
 * The reason field is required by the API, not just asked for here. Six weeks
 * later "someone added 500 credits" answers nothing, and this is the only
 * record that will exist.
 */
function Grant({ tenantId, balance, onDone }) {
  const [credits, setCredits] = useState('');
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState(null);
  const n = Number(credits);

  return (
    <section className="card prof-card adm-grant">
      <div className="plan-head">
        <span className="label">Credits</span>
        <span className="hint"><b>{num(balance)}</b> in hand</span>
      </div>
      <div className="adm-grant-row">
        <input className="mono" inputMode="numeric" value={credits} placeholder="e.g. 100"
               onChange={(e) => setCredits(e.target.value)} />
        <input value={note} placeholder="Why — recorded with the grant"
               onChange={(e) => setNote(e.target.value)} />
        <Action
          label={n < 0 ? 'Take back' : 'Grant'}
          run={() => post(`/admin/tenants/${tenantId}/credits`, { credits: n, note })}
          onDone={(out) => { setMsg(`Balance is now ${num(out.balance)}.`); setCredits(''); setNote(''); onDone?.(); }}
          confirm={n < 0
            ? `Take ${Math.abs(n)} credits back from this account?`
            : `Give this account ${n} credits?`}
        />
      </div>
      <span className="helper">
        A negative number takes credits back, and cannot overdraw the account.
        {msg && <b className="adm-ok"> {msg}</b>}
      </span>
    </section>
  );
}
