'use client';

import { useEffect, useState } from 'react';
import { post } from '../../../lib/api';
import { AdminPage } from '../../../components/Admin';

/**
 * The SQL prompt.
 *
 * ── It cannot write, and it is not this page that stops it ──────────────────
 * The statement runs inside a read-only Postgres transaction that is always
 * rolled back, on a database role that is not a superuser and cannot reach the
 * server's filesystem. Both of those are server-side; nothing on this page is
 * load-bearing for safety, which is the only sane way to build a text box that
 * takes SQL.
 *
 * So this page can be generous. It offers the schema, keeps a history, and
 * shows Postgres' own error text including the character position — because
 * the thing that makes a SQL prompt usable is a good error, and the thing that
 * makes it safe is somewhere else entirely.
 */

const HISTORY_KEY = 'rstudio.admin.sql.history';

const EXAMPLES = [
  { label: 'Signups by week',
    sql: `SELECT date_trunc('week', created_at)::date AS week, count(*)\nFROM users\nWHERE tenant_id IS NOT NULL\nGROUP BY 1 ORDER BY 1 DESC` },
  { label: 'Where the fal money goes',
    sql: `SELECT stage, count(*) AS jobs, round(sum(cost_cents)/100.0, 2) AS usd\nFROM render_jobs\nWHERE finished_at > now() - interval '30 days'\nGROUP BY 1 ORDER BY usd DESC NULLS LAST` },
  { label: 'Accounts with credits but no activity',
    sql: `SELECT t.name, sum(cl.credits) AS credits,\n       (SELECT max(created_at) FROM render_jobs j WHERE j.tenant_id = t.id) AS last_job\nFROM tenants t JOIN credit_ledger cl ON cl.tenant_id = t.id\nGROUP BY t.id, t.name HAVING sum(cl.credits) > 0\nORDER BY last_job NULLS FIRST` },
  { label: 'Failures by error',
    sql: `SELECT result->>'code' AS code, result->>'error' AS error, count(*)\nFROM render_jobs WHERE status = 'failed'\nGROUP BY 1, 2 ORDER BY 3 DESC` },
  { label: 'Tables in this database',
    sql: `SELECT table_name, (SELECT count(*) FROM information_schema.columns c\n         WHERE c.table_name = t.table_name) AS columns\nFROM information_schema.tables t\nWHERE table_schema = 'public' ORDER BY table_name` },
];

export default function AdminQuery() {
  const [sql, setSql] = useState(EXAMPLES[0].sql);
  const [out, setOut] = useState(null);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState(null);
  const [history, setHistory] = useState([]);

  // Per-browser convenience only — never round-trips anywhere.
  useEffect(() => {
    try { setHistory(JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]')); } catch { /* fine */ }
  }, []);

  function remember(text) {
    try {
      const next = [text, ...history.filter((h) => h !== text)].slice(0, 20);
      setHistory(next);
      localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
    } catch { /* private mode — the history is just gone */ }
  }

  async function run() {
    setBusy(true); setRefused(null);
    try {
      const r = await post('/admin/query', { sql });
      setOut(r);
      if (r.ok) remember(sql.trim());
    } catch (e) {
      // A refusal from the endpoint itself rather than from Postgres: the
      // connection is too privileged, or the statement is one we never send.
      setOut(null);
      setRefused({ message: e?.body?.message || e.message, code: e?.body?.code || e.code });
    } finally { setBusy(false); }
  }

  function onKey(e) {
    // Ctrl/Cmd+Enter runs it. A prompt where the only way to run is to reach
    // for the mouse is a prompt nobody iterates in.
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); run(); }
  }

  return (
    <AdminPage
      title="Query"
      deck="Read-only, always. The statement runs in a Postgres transaction that is rolled back whatever it does, on a role that can only SELECT."
    >
      <section className="card prof-card">
        <div className="adm-sql-tabs">
          {EXAMPLES.map((e) => (
            <button key={e.label} className="btn ghost sm" onClick={() => setSql(e.sql)}>{e.label}</button>
          ))}
        </div>

        <textarea
          className="mono adm-sql"
          value={sql}
          spellCheck={false}
          rows={10}
          onChange={(e) => setSql(e.target.value)}
          onKeyDown={onKey}
        />

        <div className="adm-sql-actions">
          <button className="btn" disabled={busy} onClick={run}>{busy ? 'Running…' : 'Run'}</button>
          <span className="helper">⌘↵ to run · one statement at a time · every query is logged to the audit trail</span>
        </div>
      </section>

      {refused && (
        <div className="lp-msg warn" role="alert">
          <b>{refused.code === 'CONSOLE_CONNECTION_TOO_PRIVILEGED' ? 'The console is disabled' : 'Refused'}</b>
          <span className="adm-pre">{refused.message}</span>
        </div>
      )}

      {out && !out.ok && (
        <div className="lp-msg warn" role="alert">
          <b>Postgres says no</b>
          <span className="mono">{out.error}</span>
          {out.hint && <span className="helper">Hint: {out.hint}</span>}
          {out.position != null && (
            <span className="helper">
              At character {out.position}: <code className="mono">{context(sql, out.position)}</code>
            </span>
          )}
          {out.read_only && (
            <span className="helper">
              That was a write. This prompt runs in a read-only transaction on purpose —
              changes go through the Accounts and Jobs screens, which record who made them.
            </span>
          )}
        </div>
      )}

      {out?.ok && <Grid out={out} />}

      {history.length > 0 && (
        <section className="adm-sec">
          <div className="label">Recent</div>
          <ul className="adm-history">
            {history.map((h, i) => (
              <li key={i}>
                <button className="lnk mono" onClick={() => setSql(h)}>{h.replace(/\s+/g, ' ').slice(0, 110)}</button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </AdminPage>
  );
}

function Grid({ out }) {
  return (
    <section className="adm-sec">
      <div className="plan-head">
        <span className="label">{out.row_count} row{out.row_count === 1 ? '' : 's'}</span>
        <span className="hint">{out.ms}ms</span>
      </div>

      {out.truncated && (
        <p className="helper adm-bad">
          Showing the first {out.max_rows}. Add a LIMIT, or an aggregate — the rest were
          fetched and thrown away, which is slower than not asking for them.
        </p>
      )}

      {out.rows.length === 0
        ? <p className="hint adm-empty">The query ran and matched nothing.</p>
        : (
          <div className="adm-scroll">
            <table className="adm-table mono">
              <thead><tr>{out.fields.map((f, i) => <th key={i}>{f}</th>)}</tr></thead>
              <tbody>
                {out.rows.map((row, i) => (
                  <tr key={i}>{row.map((v, j) => (
                    <td key={j} className={v === null ? 'adm-nil' : ''}>
                      {v === null ? 'NULL' : typeof v === 'object' ? JSON.stringify(v) : String(v)}
                    </td>
                  ))}</tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </section>
  );
}

/** The characters around a syntax error, so the position means something. */
function context(sql, pos) {
  const at = Math.max(0, pos - 1);
  return `${sql.slice(Math.max(0, at - 20), at)}▸${sql.slice(at, at + 24)}`.replace(/\s+/g, ' ');
}
