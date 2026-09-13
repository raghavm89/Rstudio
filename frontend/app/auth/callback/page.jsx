'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '../../../components/AuthProvider';

/**
 * Where Google and GitHub send you back.
 *
 * The URL carries a single-use handoff code, never a token. This page trades it
 * for a session with a same-origin POST — which is what lets the refresh cookie
 * land on the origin you are actually on, and what keeps a live bearer token out
 * of your browser history and out of the Referer header of the next request this
 * page makes.
 *
 * The code is spent exactly once, server-side. React's development StrictMode
 * deliberately runs effects twice, which would spend it and then report the
 * second attempt as expired — hence the ref, which is not defensive padding but
 * the difference between this working and not.
 */
export default function OAuthCallback() {
  return (
    <Suspense fallback={<Waiting />}>
      <Exchange />
    </Suspense>
  );
}

function Exchange() {
  const params = useSearchParams();
  const router = useRouter();
  const { completeOAuth } = useAuth();
  const [error, setError] = useState(params.get('error'));
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    const code = params.get('code');
    if (!code) { if (!error) setError('That sign-in did not complete. Please try again.'); return; }

    completeOAuth(code)
      .then(() => router.replace('/avatars'))
      .catch((e) => setError(e.message || 'Could not complete sign-in.'));
  }, [params, completeOAuth, router, error]);

  if (error) {
    return (
      <div className="page">
        <div className="load-err">
          <b>Could not finish signing in</b>
          <span>{error}</span>
          <Link className="ghost" href="/login">Back to sign in</Link>
        </div>
      </div>
    );
  }
  return <Waiting />;
}

function Waiting() {
  return <div className="page boot"><p className="hint">Signing you in…</p></div>;
}
