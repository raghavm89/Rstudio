'use strict';

/**
 * Where each app lives, as an absolute URL you can put in an email.
 *
 * `APP_URL` in this project is routinely set without a scheme ("rstudio.app").
 * `res.redirect` treats that as a RELATIVE path, so the browser lands on
 * `<api-host>/rstudio.app/…`; a mail client mostly refuses to linkify it at all.
 * routes/oauth.js already worked around this with a local helper — this is that
 * helper, moved somewhere the password-reset path can reach it, because two
 * copies of a normaliser is how one of them stays wrong.
 */

function siteUrl(raw, fallback) {
  let v = String(raw || fallback || '').trim().replace(/\/+$/, '');
  if (!v) return '';
  if (!/^https?:\/\//i.test(v)) v = `https://${v}`;
  return v;
}

/**
 * The app an email should point back at, chosen by audience.
 *
 * Audience — never the request's own Origin or Host. Those are attacker
 * controlled: a forged header would put a link to someone else's domain inside a
 * password-reset email sent to a real user, which is a phishing message we send
 * ourselves, signed with our own sending reputation. `audienceForRequest`
 * resolves an Origin against a configured allowlist first, so by the time a
 * value reaches here it is one of three known words, and every URL below comes
 * from configuration.
 */
function appUrlForAudience(audience) {
  if (audience === 'studio') return siteUrl(process.env.STUDIO_APP_URL, 'http://localhost:3100');
  if (audience === 'admin')  return siteUrl(process.env.ADMIN_APP_URL,  process.env.APP_URL || 'http://localhost:3001');
  return siteUrl(process.env.APP_URL, 'http://localhost:3001');
}

module.exports = { siteUrl, appUrlForAudience };
