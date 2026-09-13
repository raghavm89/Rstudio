'use client';

import { useState } from 'react';
import { useResource, Resource } from '../../../components/Guard';
import { AdminPage, Table, ago, nullish } from '../../../components/Admin';

/**
 * The audit trail.
 *
 * Admin actions and tenant actions share one table on purpose. "What happened
 * to this account" should be one query, not a reconciliation between two logs
 * that disagree about ordering.
 */
const FILTERS = [
  ['', 'everything'],
  ['admin.', 'back office'],
  ['admin.credits', 'credit grants'],
  ['admin.query', 'SQL run'],
  ['admin.job', 'job actions'],
];

export default function AdminAudit() {
  const [action, setAction] = useState('admin.');
  const state = useResource(`/admin/audit?action=${encodeURIComponent(action)}&limit=200`);

  return (
    <AdminPage
      title="Audit"
      deck="Who did what, to whose account. Written in the same transaction as the change, so a record cannot exist without its action or the other way round."
      actions={
        <div className="adm-filters">
          {FILTERS.map(([v, label]) => (
            <button key={label} className={`btn ghost sm${action === v ? ' on' : ''}`}
                    onClick={() => setAction(v)}>{label}</button>
          ))}
        </div>
      }
    >
      <Resource state={state}>
        {(d) => (
          <Table rows={d.entries} empty="Nothing recorded yet." cols={[
            { key: 'created_at', label: 'When', render: (r) => ago(r.created_at) },
            { key: 'actor_email', label: 'Who', render: (r) => (
              <><b>{nullish(r.actor_email)}</b>{r.ip && <span className="helper adm-sub mono">{r.ip}</span>}</>
            ) },
            { key: 'action', label: 'Did', render: (r) => <span className="mono">{r.action}</span> },
            { key: 'tenant_name', label: 'To', render: (r) => nullish(r.tenant_name) },
            { key: 'meta', label: 'Detail', render: (r) => <Detail action={r.action} meta={r.meta} /> },
          ]} />
        )}
      </Resource>
    </AdminPage>
  );
}

/**
 * The meta blob, read rather than dumped.
 *
 * A JSON object in a table cell is technically complete and practically
 * unreadable, and this is the log someone scans when something has gone wrong.
 */
function Detail({ action, meta }) {
  if (!meta || typeof meta !== 'object') return nullish(meta);

  if (action === 'admin.credits.grant') {
    return (
      <>
        <b>{meta.credits > 0 ? `+${meta.credits}` : meta.credits} credits</b>
        {' '}({meta.balance_before} → {meta.balance_after})
        <span className="helper adm-sub">{meta.note}</span>
      </>
    );
  }
  if (action === 'admin.query.run') {
    return (
      <>
        <span className="mono adm-err-cell" title={meta.sql}>{String(meta.sql || '').replace(/\s+/g, ' ').slice(0, 80)}</span>
        <span className="helper adm-sub">
          {meta.ok ? `${meta.rows} rows · ${meta.ms}ms` : `failed: ${meta.error}`}
        </span>
      </>
    );
  }
  if (action === 'admin.job.requeue') {
    return <>from <b>{meta.from_status}</b> after {meta.attempts} tr{meta.attempts === 1 ? 'y' : 'ies'} · {meta.stage}</>;
  }
  return <span className="mono adm-json">{JSON.stringify(meta)}</span>;
}
