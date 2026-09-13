'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useResource, Resource } from '../../components/Guard';

/**
 * The avatar list.
 *
 * Deliberately not a dashboard. A creator with one avatar — which is every
 * creator on the free tier, and most on paid — should see their avatar and a
 * way back into whatever step they are stuck on, not a wall of statistics that
 * has not posted yet.
 *
 * ── This used to read from the culling service ──────────────────────────────
 * `fetch('/cull/api/avatars')` — port 5055, no authentication, no tenant
 * scoping, answering with every avatar in the database. Survivable while the
 * only avatar was Aanya and the only user was Raghav; a data leak on the day a
 * second tenant existed. It now reads the authenticated Studio API, which also
 * means an avatar created here actually appears here.
 */
export default function Avatars() {
  const state = useResource('/avatars');
  const router = useRouter();

  return (
    <>
      <div className="topbar">
        <div className="crumb"><b>Avatars</b></div>
        <NewButton state={state} onClick={() => router.push('/avatars/new')} />
      </div>

      <div className="page">
        <Resource state={state}>{(d) => <List d={d} />}</Resource>
      </div>
    </>
  );
}

/**
 * The button knows what it would cost.
 *
 * Offering a button whose only outcome is a 402 is worse than saying so on the
 * button: the person has already decided to make something by the time they
 * find out they cannot.
 */
function NewButton({ state, onClick }) {
  const d = state.data;
  const full = d && d.limit > 0 && d.used >= d.limit;
  if (full) {
    return (
      <Link className="btn sm ghost" href="/billing" title={`Your plan includes ${d.limit}`}>
        {d.limit} of {d.limit} avatars — upgrade
      </Link>
    );
  }
  return <button className="btn sm ghost" onClick={onClick}>New avatar</button>;
}

function List({ d }) {
  if (!d.avatars.length) {
    return (
      <div className="empty">
        <h2>No avatars yet</h2>
        <p>
          Start by describing who they are — physically, in about thirty words. That
          description is frozen and goes into every image they ever appear in, so it is
          worth the ten minutes.
        </p>
        <Link className="btn" href="/avatars/new">Create the first one</Link>
      </div>
    );
  }

  return (
    <>
      <div className="av-grid">
        {d.avatars.map((a) => (
          <Link key={a.id} href={`/avatars/${a.id}/face`} className="card bordered av-card">
            <div className="av-top">
              <h2>{a.name}</h2>
              <span className={`pill ${a.status === 'active' ? 'ok' : 'warn'}`}>
                {a.status === 'active' ? 'Ready' : a.trained ? 'Trained' : 'Setting up'}
              </span>
            </div>
            <p className="mono av-id">{a.slug}</p>
            <p className="hint av-identity">{a.identity_block}</p>

            {a.consent_pending && (
              /* Said here rather than at the train button, which is where it was
                 going to be discovered otherwise — after the seed set was
                 generated and paid for. */
              <p className="helper av-consent">
                A twin depicts a real person. Training needs a verified consent
                record, which is not built yet.
              </p>
            )}

            <div className="av-foot">
              <span className="helper">{progress(a)}</span>
            </div>
          </Link>
        ))}
      </div>

      {d.limit > 0 && (
        <p className="hint av-count">
          {d.used} of {d.limit} {d.limit === 1 ? 'avatar' : 'avatars'} on your plan.
          {d.used >= d.limit && <> <Link className="lnk" href="/billing">More on Pro</Link>.</>}
        </p>
      )}
    </>
  );
}

/**
 * The one line on the card: where this avatar has got to.
 *
 * It used to read `assets ? \`${assets} images\` : 'No photos yet'`, and
 * `assets` counts SHOOT output — published stills and clips. So an avatar with
 * twenty-four candidate frames, eighteen of them kept and a face already
 * chosen, said "No photos yet". True of a different thing, and read as "nothing
 * has happened" to the person who had just spent an afternoon on it.
 *
 * Setting an avatar up is most of the work, so the states of that setup are
 * what this reports — newest fact first, because the latest thing that happened
 * is the thing worth knowing.
 */
function progress(a) {
  if (a.trained) return a.assets ? `Trained · ${a.assets} images` : 'Trained';
  if (a.kept) return `${a.kept} of ${a.candidates} photos kept`;
  if (a.candidates) return `${a.candidates} photos to choose from`;
  if (a.anchor_chosen) return 'Face chosen — no photos yet';
  if (a.anchors) return `${a.anchors} faces to choose between`;
  return 'Nothing generated yet';
}
