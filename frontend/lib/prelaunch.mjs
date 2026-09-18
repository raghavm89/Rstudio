/**
 * Pure helpers for the pre-launch page and its waitlist route. No React, no
 * Next, no network — so `node --test` covers them directly.
 */

/**
 * Classify a pasted social link.
 *
 * Returns { kind: 'instagram', permalink } | { kind: 'youtube', id } | null.
 * Instagram is embedded by permalink (its embed.js wants the canonical URL with
 * a trailing slash and no query string); YouTube by video id (iframe).
 */
export function parseSocialUrl(input) {
  if (typeof input !== 'string') return null;
  let u;
  try { u = new URL(input.trim()); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.replace(/^www\./, '').replace(/^m\./, '');

  if (host === 'instagram.com') {
    const m = u.pathname.match(/^\/(?:[\w.]+\/)?(p|reel|reels|tv)\/([\w-]+)\/?/);
    if (!m) return null;
    const type = m[1] === 'reels' ? 'reel' : m[1];
    return { kind: 'instagram', permalink: `https://www.instagram.com/${type}/${m[2]}/` };
  }

  if (host === 'youtu.be') {
    const id = u.pathname.slice(1).split('/')[0];
    return isYtId(id) ? { kind: 'youtube', id } : null;
  }
  if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (u.pathname === '/watch') {
      const id = u.searchParams.get('v');
      return isYtId(id) ? { kind: 'youtube', id } : null;
    }
    const m = u.pathname.match(/^\/(shorts|embed|live|v)\/([\w-]{11})/);
    if (m) return { kind: 'youtube', id: m[2] };
  }
  return null;
}

const isYtId = (id) => typeof id === 'string' && /^[\w-]{11}$/.test(id);

/** Parse a list, dropping what does not embed. `onSkip` receives each rejected input. */
export function parsePosts(list, onSkip) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const p = parseSocialUrl(raw);
    if (p) out.push({ ...p, url: raw });
    else if (onSkip) onSkip(raw);
  }
  return out;
}

/**
 * Good-enough email check for a waitlist: one @, something either side, a dot
 * in the domain, no whitespace. Brevo does the real validation.
 */
export function validEmail(s) {
  if (typeof s !== 'string') return false;
  const e = s.trim();
  return e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);
}

export const ROLES = ['creator', 'brand', 'agency', 'curious'];

/**
 * Normalise a waitlist submission. Returns { ok: true, email, role } or
 * { ok: false, error }. A filled honeypot is reported as ok:true with bot:true so
 * the route can answer 200 without doing anything.
 */
export function normaliseSignup(body) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Bad request' };
  if (typeof body.website === 'string' && body.website.trim() !== '') return { ok: true, bot: true };
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!validEmail(email)) return { ok: false, error: 'That email does not look right.' };
  const role = ROLES.includes(body.role) ? body.role : 'curious';
  return { ok: true, email, role };
}
