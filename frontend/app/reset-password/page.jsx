import fs from 'node:fs';
import path from 'node:path';
import { Suspense } from 'react';
import ResetPassword from '../../components/ResetPassword';

/**
 * /reset-password — a server component that reads the manifest, wrapping a
 * client component that reads the query string.
 *
 * The Suspense boundary is required, not decorative: `useSearchParams` opts the
 * subtree into client-side rendering, and without a boundary Next fails the
 * build with "useSearchParams() should be wrapped in a suspense boundary". The
 * fallback is deliberately quiet — this page is on screen for a moment before
 * the token is read, and a flash of a password form that then disappears reads
 * as a broken link.
 */
export default function ResetPasswordRoute() {
  let assets = null;
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'public', 'hero', 'manifest.json'), 'utf8'));
    assets = manifest.auth?.video ? { ...manifest, ...manifest.auth } : manifest;
  } catch { /* no footage yet — the plate draws itself */ }

  return (
    <Suspense fallback={<div className="page boot"><p className="hint">Loading…</p></div>}>
      <ResetPassword assets={assets} />
    </Suspense>
  );
}
