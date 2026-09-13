'use client';

import Link from 'next/link';
import { useResource, Resource } from '../../components/Guard';

/**
 * Usage — credits spent, and what actually constrains you.
 *
 * ── Why both a total and a breakdown ────────────────────────────────────────
 * The headline is one number because that is what people ask. The breakdown is
 * underneath because the headline alone would be a lie: allowances are enforced
 * PER METER, not out of a shared pot. Someone can have 200 credits "remaining"
 * and still be refused a video, because the video meter specifically is spent.
 *
 * So the total answers "how much have I used" and the rows answer "what will
 * stop me". Showing only the first would produce exactly the kind of confident
 * wrong number that costs a support conversation.
 */

const PERIOD = { month: 'this month', lifetime: 'all time' };

/** Metrics that do not cost credits — they are caps on what you may HAVE. */
const HOLDINGS = ['publishes', 'avatars', 'faces_claimed'];
const HOLDING_LABEL = {
  publishes:     'Posts published',
  avatars:       'Avatars',
  faces_claimed: 'Faces claimed',
};

export default function UsagePage() {
  const state = useResource('/usage');
  return (
    <Resource state={state}>
      {(data) => <Usage credits={data.credits} usage={data.usage || {}} />}
    </Resource>
  );
}

function Usage({ credits, usage }) {
  const c = credits || { included: 0, used: 0, remaining: 0, breakdown: [] };
  const pct = c.included > 0 ? Math.min(100, (c.used / c.included) * 100) : 0;

  return (
    <div className="page prof">
      <h1>Usage</h1>
      <p className="hint prof-deck">
        One credit is one photo; a video is about six. You're charged when a piece
        is generated, not when you post it — a reshoot you don't use still spends
        its credits.
      </p>

      <section className="card prof-card">
        <div className="label">Credits this month</div>
        <div className="use-total">
          <span className="use-total-n">{fmt(c.remaining)}</span>
          <span className="hint">left of {fmt(c.included)}</span>
        </div>
        <div className="track cred-track">
          <div className={`fill${pct >= 100 ? ' over' : pct >= 80 ? ' near' : ''}`} style={{ width: `${pct}%` }} />
        </div>
        <p className="helper">
          {fmt(c.used)} spent. <Link className="lnk" href="/billing">Change plan</Link> to raise the ceiling.
        </p>
      </section>

      <section className="card prof-card">
        <div className="label">Where they went</div>
        <div className="use-list">
          {c.breakdown.length === 0 && <p className="hint">Nothing spent yet.</p>}
          {c.breakdown.map((row) => {
            const pctRow = row.credits_limit > 0
              ? Math.min(100, (row.credits / row.credits_limit) * 100)
              : 0;
            const over = row.credits_limit > 0 && row.credits >= row.credits_limit;
            const near = !over && pctRow >= 80;

            return (
              <div className="use-row" key={row.metric}>
                <div className="use-head">
                  <span className="use-name">
                    {row.label}
                    {/* The real units, kept beside the credits. A credit figure
                        alone cannot be checked against anything; seconds and
                        megapixels are what the person actually asked for. */}
                    <span className="use-period">
                      {fmt(row.units_used)}{row.unit} of {fmt(row.units_limit)}{row.unit}
                      {row.rate !== 1 && ` · ${row.rate} credits per ${row.unit}`}
                    </span>
                  </span>
                  <span className="use-n">
                    <b>{fmt(row.credits)}</b> / {fmt(row.credits_limit)}
                  </span>
                </div>
                {row.credits_limit > 0 && (
                  <div className="track">
                    <div className={`fill${over ? ' over' : near ? ' near' : ''}`} style={{ width: `${pctRow}%` }} />
                  </div>
                )}
                {over && (
                  <div className="use-foot">
                    <span className="helper">
                      This meter is spent — more {row.label.toLowerCase()} will be refused even if
                      credits remain elsewhere.
                    </span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <section className="card prof-card">
        <div className="label">Allowances</div>
        <dl className="prof-read">
          {HOLDINGS.map((metric) => {
            const row = usage[metric];
            // A metric the backend did not report is not a zero.
            if (!row) return null;
            const limit = Number(row.limit ?? 0);
            return (
              <div key={metric}>
                <dt>{HOLDING_LABEL[metric]}</dt>
                <dd>
                  <span className="mono">{fmt(row.used)} / {fmt(limit)}</span>
                  <span className="helper">{PERIOD[row.period] || row.period}</span>
                </dd>
              </div>
            );
          })}
        </dl>
        <p className="helper">These are caps on what you may have, so they cost no credits.</p>
      </section>
    </div>
  );
}

// Whole numbers where they are whole. "240" reads as an allowance; "240.00"
// reads as an accounting artefact.
function fmt(n) {
  const v = Number(n || 0);
  return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/\.00$/, '');
}
