'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * /signup exists because people type it and link to it, not because it is a
 * separate screen. Sign-in and sign-up are two tabs of one card — the paths
 * cross too often for them to be separate destinations — so this route just
 * opens that card on the right tab.
 *
 * `replace`, not `push`: Back from the auth screen should return to wherever
 * they came from, not bounce through this redirect again.
 */
export default function SignupRedirect() {
  const router = useRouter();
  useEffect(() => { router.replace('/login?tab=signup'); }, [router]);
  return <div className="page"><p className="hint">Taking you to sign-up…</p></div>;
}
