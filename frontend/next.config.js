/** @type {import('next').NextConfig} */
module.exports = {
  reactStrictMode: true,

  // Next inlines Google Fonts at build time by default. That turns a cosmetic
  // dependency into a hard build failure on any network that blocks or
  // intercepts fonts.googleapis.com — which is not hypothetical here. The
  // <link> stays, so the font still loads at runtime when the network allows
  // and falls back to the system stack when it does not.
  optimizeFonts: false,
  // The Studio frontend is a separate app from rstudio.app and talks to the
  // shared backend over HTTP. Proxying in development keeps the browser
  // same-origin, so cookies and the Origin-derived `aud` claim behave the way
  // they will in production behind one domain.
  /**
   * /studio was briefly this section's route, and is not any more.
   *
   * "Studio" is the whole dashboard — the wordmark in the sidebar — so the
   * section inside it cannot also be Studio. It is Avatar, and it lives back at
   * /avatars, which is what the API has called the resource all along.
   *
   * The redirect exists because that rename shipped, however briefly: anyone
   * holding a /studio link should land somewhere rather than on a 404. The tail
   * is kept, so /studio/7/look reaches /avatars/7/look rather than the index.
   */
  async redirects() {
    return [
      { source: '/studio', destination: '/avatars', permanent: false },
      { source: '/studio/:path*', destination: '/avatars/:path*', permanent: false },
    ];
  },

  async rewrites() {
    return [
      {
        source: '/api/studio/:path*',
        destination: `${process.env.STUDIO_API || 'http://127.0.0.1:3000'}/api/studio/:path*`,
      },
      // Sign-in. Studio has no user table of its own — it shares the backend's,
      // which is the whole point of one account across rstudio.app and Studio.
      // Proxying rather than calling :5000 directly is load-bearing twice over:
      // the refresh token arrives as an HttpOnly cookie that must be same-origin
      // to come back, and the backend reads Origin to decide the token audience.
      {
        source: '/api/auth/:path*',
        destination: `${process.env.STUDIO_API || 'http://127.0.0.1:3000'}/api/auth/:path*`,
      },
      // The culling service. It owns the candidate files on disk and the
      // coverage rules; proxying keeps ONE implementation of those rules rather
      // than a second copy in the frontend that drifts from the first.
      {
        source: '/cull/:path*',
        destination: `${process.env.CULL_API || 'http://127.0.0.1:5055'}/:path*`,
      },
    ];
  },
};
