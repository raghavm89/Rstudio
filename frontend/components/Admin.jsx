'use client';

import { useState } from 'react';
import { useAuth } from './AuthProvider';

/**
 * Shared furniture for the back office.
 *
 * ── Why this section looks different from the rest of the app ───────────────
 * Every other screen shows you your own workspace. These show everybody's, and
 * a page that can display another person's email and payment history should not
 * be visually indistinguishable from the one that shows your own. The band at
 * the top is there so that a screenshot of this section is recognisable as this
 * section.
 */

/** Refuses to render for anyone but an admin. */
export function AdminOnly({ children }) {
  const { user } = useAuth();
  if (!user) return <div className="page"><p className="hint">Loading…</p></div>;
  if (user.role !== 'admin') {
    return (
      <div className="page">
        <div className="load-err">
          <b>Not your section</b>
          <span>The back office is for platform staff. Nothing here is scoped to your workspace.</span>
        </div>
      </div>
    );
  }
  return children;
}

export function AdminPage({ title, deck, children, actions }) {
  return (
    <AdminOnly>
      <div className="page adm">
        <div className="adm-band">Back office · every account, not just yours</div>
        <div className="adm-head">
          <h1>{title}</h1>
          {actions}
        </div>
        {deck && <p className="hint prof-deck">{deck}</p>}
        {children}
      </div>
    </AdminOnly>
  );
}

/** A row of headline numbers. */
export function Stats({ items }) {
  return (
    <section className="adm-stats">
      {items.map((s) => (
        <div className="adm-stat" key={s.label}>
          <span className="adm-stat-n">{s.value}</span>
          <span className="label">{s.label}</span>
          {s.note && <span className="helper">{s.note}</span>}
        </div>
      ))}
    </section>
  );
}

/**
 * A table.
 *
 * `cols` is a list of `{ key, label, render?, align?, width? }`. The render
 * function gets the whole row, because a cell that needs two fields is common
 * enough that passing only its own value would push formatting back into the
 * page.
 */
export function Table({ cols, rows, empty = 'Nothing here yet.', onRow }) {
  if (!rows?.length) return <p className="hint adm-empty">{empty}</p>;
  return (
    <div className="adm-scroll">
      <table className="adm-table">
        <thead>
          <tr>{cols.map((c) => (
            <th key={c.key} style={{ textAlign: c.align || 'left', width: c.width }}>{c.label}</th>
          ))}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.id ?? i} onClick={onRow ? () => onRow(r) : undefined}
                className={onRow ? 'clickable' : ''}>
              {cols.map((c) => (
                <td key={c.key} style={{ textAlign: c.align || 'left' }}>
                  {c.render ? c.render(r) : nullish(r[c.key])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * An empty cell should look empty.
 *
 * A table that prints "null" is showing you the transport, and a blank one is
 * ambiguous between "no value" and "I forgot to render this". An em dash says
 * the query ran and there was nothing there.
 */
export function nullish(v) {
  if (v === null || v === undefined || v === '') return <span className="adm-nil">—</span>;
  if (typeof v === 'object') return <span className="mono adm-json">{JSON.stringify(v)}</span>;
  return String(v);
}

/** Paise, as rupees. Money is stored in the smallest unit; only display divides. */
export const rs = (paise) =>
  `₹${(Number(paise || 0) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

export const num = (n) => Number(n || 0).toLocaleString('en-IN');

/** "3 minutes ago" for recent things, a date for old ones. */
export function ago(ts) {
  if (!ts) return '—';
  const then = new Date(ts).getTime();
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`;
  if (mins < 60 * 24 * 30) return `${Math.round(mins / 1440)}d ago`;
  return new Date(ts).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function Pill({ kind, children }) {
  return <span className={`pill ${kind || ''}`}>{children}</span>;
}

/**
 * A button that does something and reports what happened.
 *
 * Every write in this section is one an admin performs on somebody else's
 * account, so "did that work" has to be answered on the spot rather than left
 * to a page refresh.
 */
export function Action({ label, busyLabel = 'Working…', run, onDone, confirm }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  async function go() {
    if (confirm && !window.confirm(confirm)) return;
    setBusy(true); setErr(null);
    try {
      const out = await run();
      onDone?.(out);
    } catch (e) {
      setErr(e?.body?.message ? `${e.message} — ${e.body.message}` : e.message);
    } finally { setBusy(false); }
  }

  return (
    <>
      <button className="btn ghost sm" disabled={busy} onClick={go}>{busy ? busyLabel : label}</button>
      {err && <span className="prof-err adm-inline-err">{err}</span>}
    </>
  );
}
