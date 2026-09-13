const Razorpay = require('razorpay');

/**
 * The Razorpay client, and the guard that decides whether it may exist.
 *
 * ── Why a development machine must not hold live keys ────────────────────────
 *
 * There is no sandbox flag on a Razorpay call. The key decides everything: an
 * order created with an `rzp_live_` key is a real order, the checkout it opens
 * takes real money from whoever is sitting there, and a plan created with one
 * is visible to real customers and can never be deleted afterwards — only
 * deactivated.
 *
 * Nothing about a localhost request looks different to Razorpay. So the only
 * place this can be caught is here, before the first call, by noticing that a
 * live key is loaded somewhere that is not production.
 *
 * The check is at first USE rather than at require time on purpose: the test
 * suite loads this module constantly and must not need keys at all, and a
 * throw on import would take the whole app down at boot over a facility most
 * requests never touch.
 */

const LIVE_PREFIX = 'rzp_live_';

/** An explicit, ugly opt-out. Ugly because you should have to mean it. */
const OVERRIDDEN = process.env.RAZORPAY_ALLOW_LIVE === 'yes-really';

function refuseLiveOutsideProduction(keyId) {
  if (!keyId.startsWith(LIVE_PREFIX)) return;
  if (process.env.NODE_ENV === 'production' || OVERRIDDEN) return;

  const err = new Error('Refusing to use live Razorpay keys outside production');
  err.status = 503;
  err.code = 'RAZORPAY_LIVE_KEYS_IN_DEV';
  err.publicMessage =
    'RAZORPAY_KEY_ID is a live key and NODE_ENV is not production, so this would '
    + 'have taken real money. Put the rzp_test_ pair in .env — Razorpay Dashboard, '
    + 'switch to Test mode, Account & Settings → API Keys → Generate Key.';
  throw err;
}

let client;

function getClient() {
  if (!client) {
    const { RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET } = process.env;
    if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
      throw new Error('RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET must be set');
    }
    refuseLiveOutsideProduction(RAZORPAY_KEY_ID);
    client = new Razorpay({ key_id: RAZORPAY_KEY_ID, key_secret: RAZORPAY_KEY_SECRET });
  }
  return client;
}

/**
 * Things you can ask this module without needing a client.
 *
 * They sit on the proxy TARGET rather than beside it, because the trap below
 * would otherwise send `razorpay.isLiveKey` off to build a client — and asking
 * "are these live keys?" is precisely what you do when you are not sure it is
 * safe to build one.
 */
const statics = {
  isLiveKey: (keyId = process.env.RAZORPAY_KEY_ID || '') => String(keyId).startsWith(LIVE_PREFIX),
  LIVE_PREFIX,
};

// Proxy so existing call sites (`razorpay.subscriptions.create(...)`) keep working
// without each lookup re-instantiating the SDK.
module.exports = new Proxy(statics, {
  get: (target, prop) => (prop in target ? target[prop] : getClient()[prop]),
});
