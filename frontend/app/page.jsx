import fs from 'node:fs';
import path from 'node:path';
import Landing from '../components/Landing';

/**
 * The landing route — a server component, so the hero's assets are known before
 * anything renders.
 *
 * Reading the manifest here rather than fetching it in the browser matters for
 * one visible reason: a client-side fetch would paint the drawn plate first and
 * swap in the video a beat later, and a hero that changes shape after you have
 * started reading it is worse than either version alone.
 *
 * `studio/hero-assets.js` writes the manifest. Until it is run there is no file,
 * and the page renders its drawn plate — so the site is complete at every point,
 * not broken until the images arrive.
 */
export default function Page() {
  let assets = null;
  try {
    const file = path.join(process.cwd(), 'public', 'hero', 'manifest.json');
    assets = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // No manifest yet, or it is unreadable. Both mean the same thing to the page.
  }
  return <Landing assets={assets} />;
}
