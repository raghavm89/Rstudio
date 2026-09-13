'use client';

import { useState } from 'react';
import { useResource, Resource } from '../../../components/Guard';
import { post } from '../../../lib/api';
import { AdminPage, Table, Stats, Pill, Action, ago, num, nullish } from '../../../components/Admin';

/**
 * Jobs — the view that should tell you something is broken before a customer does.
 *
 * `stranded` is the number worth watching. A job whose lease expired while it
 * still says it is running means the worker died holding it: nobody is coming
 * back for it, and it will sit there looking busy forever. The reaper picks
 * these up, so a number that stays above zero means the reaper is not running.
 */
export default function AdminJobs() {
  const [status, setStatus] = useState('');
  const state = useResource(`/admin/jobs?status=${encodeURIComponent(status)}&limit=100`);

  return (
    <AdminPage
      title="Jobs"
      deck="Every render across every account. A failed job cost the same as a successful one — the meter counts generated seconds."
      actions={
        <div className="adm-filters">
          {['', 'queued', 'running', 'failed', 'done'].map((s) => (
            <button key={s || 'all'} className={`btn ghost sm${status === s ? ' on' : ''}`}
                    onClick={() => setStatus(s)}>{s || 'all'}</button>
          ))}
        </div>
      }
    >
      <Resource state={state}>
        {(d) => (
          <>
            <Stats items={[
              { label: 'Queued',  value: num(d.health.queued) },
              { label: 'Running', value: num(d.health.running) },
              { label: 'Failed 24h', value: num(d.health.failed_24h) },
              { label: 'Stranded', value: num(d.health.stranded),
                note: d.health.stranded > 0 ? 'lease expired — is the reaper running?' : 'leases all live' },
            ]} />

            <Table rows={d.jobs} empty="No jobs match." cols={[
              { key: 'id', label: '#', align: 'right', width: 60 },
              { key: 'tenant_name', label: 'Account', render: (r) => nullish(r.tenant_name) },
              { key: 'stage', label: 'Stage' },
              { key: 'status', label: 'Status', render: (r) => (
                <Pill kind={r.status === 'done' ? 'ok' : r.status === 'failed' ? 'bad' : ''}>{r.status}</Pill>
              ) },
              { key: 'runner', label: 'Runner', render: (r) => (
                <>{r.runner}{r.provider ? <span className="helper adm-sub">{r.provider}</span> : null}</>
              ) },
              { key: 'attempts', label: 'Tries', align: 'right',
                render: (r) => `${r.attempts}/${r.max_attempts}` },
              { key: 'error', label: 'Error', render: (r) => r.error
                ? <span className="adm-bad adm-err-cell" title={r.error}>{r.error}</span>
                : nullish(null) },
              { key: 'created_at', label: 'Created', render: (r) => ago(r.created_at) },
              { key: 'act', label: '', render: (r) => (
                ['failed', 'cancelled'].includes(r.status)
                  ? <Action label="Requeue"
                            run={() => post(`/admin/jobs/${r.id}/requeue`)}
                            onDone={state.reload}
                            confirm={`Run job #${r.id} again? It will be billed again.`} />
                  : null
              ) },
            ]} />
          </>
        )}
      </Resource>
    </AdminPage>
  );
}
