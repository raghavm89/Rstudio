import fs from 'node:fs';
import path from 'node:path';
import PersonaLanding from '../../components/PersonaLanding';

export const metadata = { title: 'ZoQ · Create your AI creator', description: 'A human-looking AI avatar that posts for you — synthetic or your own clone.' };

export default function Page() {
  let assets = null;
  try {
    assets = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'public', 'hero', 'manifest.json'), 'utf8'));
  } catch {}
  return <PersonaLanding assets={assets} />;
}
