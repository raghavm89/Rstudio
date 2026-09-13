import Link from 'next/link';

/**
 * A screen that does not exist yet.
 *
 * Deliberately not a 404, and deliberately not "coming soon". A half-built
 * product is more usable when it tells you what a screen will do and what it is
 * waiting on, because most of the waiting here is on things outside the code —
 * Meta's app review, a trained model, a first post. A dead link teaches nothing;
 * this turns the gaps into a visible roadmap and stops anyone wondering whether
 * they broke something.
 */
export default function Soon({ title, what, blocked, next }) {
  return (
    <div className="empty soon">
      <h2>{title}</h2>
      <p className="soon-what">{what}</p>

      {blocked && (
        <p className="soon-blocked">
          <span className="pill warn">Waiting on</span> {blocked}
        </p>
      )}

      {next && (
        <p className="soon-next">
          Next: <Link href={next.href}>{next.label}</Link>
        </p>
      )}
    </div>
  );
}
