import { NextResponse } from 'next/server';

/**
 * Pre-launch lock-down (branch `pre_launch_page`).
 *
 * zoqstudio.ai serves ONE page until launch. Every other route — the app, the
 * lane pages, pricing, sign-in — sends people back to `/`, so nothing half-built
 * is reachable from a link someone guesses or an old share card. Static files
 * (anything with an extension), Next's own assets and the waitlist API pass
 * through, because the page needs them.
 *
 * Escape hatch: PRELAUNCH=0 turns this (and the pre-launch `/`) off, which is
 * how the branch stops being special the day the real site goes up.
 */
export function middleware(req) {
  if (process.env.PRELAUNCH === '0') return NextResponse.next();
  const url = req.nextUrl.clone();
  if (url.pathname === '/') return NextResponse.next();
  url.pathname = '/';
  url.search = '';
  return NextResponse.redirect(url, 307);
}

export const config = {
  matcher: ['/((?!_next/|api/waitlist|.*\\..*).*)'],
};
