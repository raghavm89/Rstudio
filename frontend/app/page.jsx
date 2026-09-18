import fs from 'node:fs';
import path from 'node:path';
import Landing from '../components/Landing';
import Prelaunch from '../components/Prelaunch';
import { parsePosts } from '../lib/prelaunch.mjs';
import { SITE, POSTS } from '../content/prelaunch';

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
 *
 * Pre-launch (branch `pre_launch_page`): `/` is the single zoqstudio.ai page
 * unless PRELAUNCH=0. Post links from `content/prelaunch.js` are parsed here so
 * a typo is logged at build and skipped, never rendered as a broken embed.
 */

const PRELAUNCH = process.env.PRELAUNCH !== '0';

export const metadata = PRELAUNCH ? {
  metadataBase: new URL(SITE.url),
  title: `ZoQ — Your own AI influencer · Coming ${SITE.launch}`,
  description: 'One brief, a week of posts, the same face every time. A persona that posts, made for Indian feeds. Launching November 2026.',
  openGraph: {
    title: 'ZoQ — Your own AI influencer',
    description: 'One brief, a week of posts, the same face every time. Coming November 2026.',
    url: SITE.url,
    siteName: 'ZoQ',
    images: [{ url: '/hero/poster.jpg', width: 880, height: 1104 }],
    type: 'website',
  },
  twitter: { card: 'summary_large_image' },
} : {};

export default function Page() {
  let assets = null;
  try {
    const file = path.join(process.cwd(), 'public', 'hero', 'manifest.json');
    assets = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // No manifest yet, or it is unreadable. Both mean the same thing to the page.
  }
  if (!PRELAUNCH) return <Landing assets={assets} />;

  const posts = parsePosts(POSTS, (bad) => console.warn(`[prelaunch] skipped unrecognised post link: ${bad}`));
  return <Prelaunch assets={assets} posts={posts} />;
}
