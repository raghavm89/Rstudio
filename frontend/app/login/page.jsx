import fs from 'node:fs';
import path from 'node:path';
import { Suspense } from 'react';
import AuthScreen from '../../components/AuthScreen';

/**
 * /login — a server component, for the same reason the landing route is one.
 *
 * The plate beside the form is the same COMPONENT as the front door's, and it
 * has to be right on the first paint. Fetching the manifest in the browser would
 * show a drawn frame and swap in the video a beat later — and a picture that
 * changes while someone is deciding whether they are still on the right site is
 * exactly the wrong moment for it.
 *
 * It no longer carries the same FOOTAGE. The landing page shows her on the
 * balcony; this shows her running at first light — the fitness half of the
 * persona against the fashion half. Two pages playing one video read as a page
 * that failed to load something, and sign-in is where that guess is most costly.
 *
 * The fallback is deliberate and one line: if the sign-in clip has not been
 * generated yet, this shows the hero clip rather than an empty plate. Every
 * state of this page is shippable — real sign-in footage, the hero's footage, or
 * the drawn frame — which is the same rule the landing route follows.
 */
export default function LoginRoute() {
  let assets = null;
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'public', 'hero', 'manifest.json'), 'utf8'));
    assets = manifest.auth?.video ? { ...manifest, ...manifest.auth } : manifest;
  } catch { /* no footage yet — the plate draws itself */ }

  return (
    <Suspense fallback={<div className="page boot"><p className="hint">Loading…</p></div>}>
      <AuthScreen assets={assets} />
    </Suspense>
  );
}
