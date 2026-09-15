import fs from 'node:fs';
import path from 'node:path';
import CloneLanding from '../../components/CloneLanding';

export const metadata = { title: 'ZoQ · Clone yourself — an AI twin that posts and talks back', description: 'Clone your likeness from a consented video: a twin that posts as you, and (on Ultra) talks back in real time.' };

export default function Page() {
  let assets = null;
  try { assets = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'public', 'hero', 'manifest.json'), 'utf8')); } catch {}
  return <CloneLanding assets={assets} />;
}
