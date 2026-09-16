'use client';

import Link from 'next/link';
import { useResource, Resource } from '../../components/Guard';
import { AdminPage, Stats, rs, num } from '../../components/Admin';

/**
 * Overview — the four questions worth asking before opening anything else.
 *
 * Is anyone signing up, is anything running, is money arriving, and is anything
 * on fire. Deliberately not a chart: with a handful of accounts a sparkline of
 * three points is decoration, and the numbers themselves are still small enough
 * to read.
 */
export default function AdminOverview() {
  const state = useResource('/admin/overview');
  return (
    <AdminPage title="Overview" deck="Everything across every account. Numbers are live, not cached.">
      <Resource state={state}>{(d) => <Body d={d} />}</Resource>
    </AdminPage>
  );
}

function Body({ d }) {
  const j = d.jobs_24h;
  const busted = j.failed > 0;

  return (
    <>
      <Stats items={[
        { label: 'Accounts',    value: num(d.accounts.tenants), note: `${num(d.accounts.users)} people` },
        { label: 'New this week', value: num(d.accounts.users_7d) },
        { label: 'Avatars',     value: num(d.accounts.avatars), note: `${num(d.accounts.loras_active)} trained` },
        { label: 'This month',  value: rs(d.money.captured_this_month), note: `${rs(d.money.captured_all_time)} all time` },
      ]} />

      <section className="card prof-card">
        <div className="plan-head">
          <span className="label">Last 24 hours</span>
          <Link className="lnk" href="/admin/jobs">All jobs</Link>
        </div>
        <div className="adm-inline-stats">
          <span><b>{num(j.done)}</b> done</span>
          <span><b>{num(j.running)}</b> running</span>
          <span><b>{num(j.queued)}</b> queued</span>
          <span className={busted ? 'adm-bad' : ''}><b>{num(j.failed)}</b> failed</span>
        </div>
        {busted && (
          <p className="helper">
            A failure costs the same as a success — the meter counts generated seconds, not
            delivered ones. Worth looking at what they have in common.
          </p>
        )}
      </section>

      <section className="card prof-card">
        <div className="plan-head">
          <span className="label">Credits</span>
          <Link className="lnk" href="/admin/money">Payments and invoices</Link>
        </div>
        <div className="adm-inline-stats">
          <span><b>{num(d.credits.purchased)}</b> bought</span>
          <span><b>{num(d.credits.spent)}</b> spent past plan</span>
          <span><b>{num(d.credits.purchased - d.credits.spent)}</b> outstanding</span>
        </div>
        <p className="helper">
          Outstanding credits are a liability, not revenue — they are generation already
          paid for and not yet delivered.
        </p>
        {d.money.failed_7d > 0 && (
          <p className="helper adm-bad">
            {num(d.money.failed_7d)} payment{d.money.failed_7d === 1 ? '' : 's'} failed in the last
            7 days. A failed charge on an active subscription is a customer about to be cut off
            without knowing it.
          </p>
        )}
      </section>
      <section className="card prof-card">
        <div className="plan-head"><span className="label">Back office</span></div>
        <p className="helper" style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <Link className="lnk" href="/admin/consents">Clone consents</Link>
          <Link className="lnk" href="/admin/catalogue">Catalogue</Link>
          <Link className="lnk" href="/admin/audit">Audit log</Link>
          <Link className="lnk" href="/admin/query">Query</Link>
        </p>
      </section>
    </>
  );
}