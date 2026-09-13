'use client';

import { useState } from 'react';
import { useResource, Resource } from '../../../components/Guard';
import { AdminPage, Table, Pill, ago, rs, nullish } from '../../../components/Admin';

/**
 * Money — what arrived, and the paperwork that has to match it.
 *
 * Two tables rather than one joined view, because they answer different
 * questions and can legitimately disagree. A payment with no invoice is a
 * customer who cannot claim the tax; an invoice with no payment would be worse.
 * Showing them side by side is what makes the gap visible.
 */
export default function AdminMoney() {
  const [status, setStatus] = useState('');
  const state = useResource(`/admin/money?status=${encodeURIComponent(status)}&limit=100`);

  return (
    <AdminPage
      title="Money"
      deck="Payments as Razorpay reported them, and the GST invoices raised against them. All amounts include tax."
      actions={
        <div className="adm-filters">
          {['', 'captured', 'failed', 'created'].map((s) => (
            <button key={s || 'all'}
                    className={`btn ghost sm${status === s ? ' on' : ''}`}
                    onClick={() => setStatus(s)}>
              {s || 'all'}
            </button>
          ))}
        </div>
      }
    >
      <Resource state={state}>
        {(d) => {
          const captured = d.payments.filter((p) => p.status === 'captured');
          const invoiced = new Set(d.invoices.map((i) => i.payment_ref).filter(Boolean));
          const missing = captured.filter((p) => p.razorpay_payment_id && !invoiced.has(p.razorpay_payment_id));

          return (
            <>
              {missing.length > 0 && (
                <div className="lp-msg warn" role="status">
                  <b>{missing.length} captured payment{missing.length === 1 ? ' has' : 's have'} no invoice</b>
                  <span>
                    On this page of results. A customer cannot claim input credit against a
                    payment with no invoice, and the invoice cannot be backdated to the month
                    the money arrived once that month has been filed.
                  </span>
                </div>
              )}

              <section className="adm-sec">
                <div className="label">Payments</div>
                <Table rows={d.payments} empty="No payments yet." cols={[
                  { key: 'created_at', label: 'When', render: (r) => ago(r.created_at) },
                  { key: 'tenant_name', label: 'Account', render: (r) => (
                    <><b>{nullish(r.tenant_name)}</b><span className="helper adm-sub">{r.email}</span></>
                  ) },
                  { key: 'description', label: 'For' },
                  { key: 'amount', label: 'Charged', align: 'right', render: (r) => rs(r.amount) },
                  { key: 'status', label: 'Status', render: (r) =>
                    <Pill kind={r.status === 'captured' ? 'ok' : r.status === 'failed' ? 'bad' : ''}>{r.status}</Pill> },
                  { key: 'method', label: 'Method' },
                  { key: 'razorpay_payment_id', label: 'Reference',
                    render: (r) => <span className="mono">{nullish(r.razorpay_payment_id)}</span> },
                ]} />
              </section>

              <section className="adm-sec">
                <div className="label">Invoices</div>
                <Table rows={d.invoices} empty="No invoices raised yet." cols={[
                  { key: 'number', label: 'Number', render: (r) => <span className="mono">{r.number}</span> },
                  { key: 'issued_at', label: 'Issued', render: (r) => ago(r.issued_at) },
                  { key: 'buyer_name', label: 'Billed to', render: (r) => (
                    <><b>{nullish(r.buyer_name)}</b><span className="helper adm-sub">{nullish(r.tenant_name)}</span></>
                  ) },
                  { key: 'subtotal', label: 'Net', align: 'right', render: (r) => rs(r.subtotal) },
                  // Which head the tax was filed under is the thing most likely
                  // to be wrong, so it gets its own column rather than a total.
                  { key: 'tax', label: 'Tax', align: 'right', render: (r) =>
                    r.igst ? `${rs(r.igst)} IGST`
                    : (r.cgst || r.sgst) ? `${rs(r.cgst + r.sgst)} C+S`
                    : nullish(null) },
                  { key: 'total', label: 'Gross', align: 'right', render: (r) => <b>{rs(r.total)}</b> },
                  { key: 'place_of_supply', label: 'Place of supply' },
                ]} />
              </section>
            </>
          );
        }}
      </Resource>
    </AdminPage>
  );
}
