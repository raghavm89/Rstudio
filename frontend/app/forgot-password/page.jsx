import fs from 'node:fs';
import path from 'node:path';
import ForgotPassword from '../../components/ForgotPassword';

/**
 * /forgot-password — a server component, like the other auth routes.
 *
 * The manifest is read here rather than fetched in the browser so the plate is
 * right on the first paint. A picture that changes shape a beat after the page
 * appears is worst on the screens where someone is deciding whether to trust the
 * site with a password.
 */
export default function ForgotPasswordRoute() {
  let assets = null;
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'public', 'hero', 'manifest.json'), 'utf8'));
    assets = manifest.auth?.video ? { ...manifest, ...manifest.auth } : manifest;
  } catch { /* no footage yet — the plate draws itself */ }

  return <ForgotPassword assets={assets} />;
}
