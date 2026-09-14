require('dotenv').config();
require('./src/config/env')();

const app          = require('./src/app');
const pool         = require('./src/config/db');

const PORT = process.env.PORT || 3000;

/**
 * Say which Razorpay account this process is pointed at, once, at boot.
 *
 * src/services/razorpay.js refuses live keys outside production, but it does so
 * at the first payment — which in production means the first CUSTOMER finds out.
 * Printing it here puts it in the deploy log instead, where it is read before
 * anyone has tried to pay.
 *
 * Note `dotenv.config()` does not override a variable the platform already set,
 * so a host exporting NODE_ENV=production beats the line in .env — which is the
 * safe direction for this to fail in.
 */
function reportPaymentMode() {
  const key = process.env.RAZORPAY_KEY_ID || '';
  if (!key) return console.warn('Razorpay: no key configured — payments are off.');

  const live = require('./src/services/razorpay').isLiveKey(key);
  const prod = process.env.NODE_ENV === 'production';

  if (live && prod) return console.log('Razorpay: LIVE keys, production. Payments are real.');
  if (live) {
    return console.error(
      `Razorpay: LIVE keys but NODE_ENV=${process.env.NODE_ENV || 'unset'} — every payment will be `
      + 'REFUSED. Set NODE_ENV=production to take money, or use the rzp_test_ keys.'
    );
  }
  if (prod) return console.warn('Razorpay: TEST keys in production — no payment will actually be taken.');
  console.log('Razorpay: test keys. Nothing here moves real money.');
}

const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  reportPaymentMode();
});

// ── Inline render worker ──────────────────────────────────────────────────
// On a single machine one process runs the whole studio: this API and the
// worker that drains its render queue. The worker is unchanged — still a
// poll-out loop that talks to this same API over localhost — it is just hosted
// here instead of in a second terminal. Set RUN_INLINE_WORKER=off to go back to
// a separate `node worker/index.js`, which is the split you want once renders
// move onto their own box (and can hold the fal key without the API's secrets).
let stopInlineWorker = null;
if (process.env.RUN_INLINE_WORKER !== 'off') {
  if (!process.env.STUDIO_WORKER_TOKEN) {
    console.warn('Inline worker: STUDIO_WORKER_TOKEN not set — running API only.');
  } else {
    // Default to the full stage set so a single-box operator never has to know
    // which stages exist. Narrow it with WORKER_STAGES if you split later.
    process.env.WORKER_STAGES = process.env.WORKER_STAGES
      || 'still,seed_still,calib_still,lora_train,motion';
    const worker = require('./worker');
    stopInlineWorker = worker.stopWorker;
    // A tick after the socket is up, so the first claim doesn't race the listener.
    setTimeout(() => {
      worker.runWorkerLoop().catch((err) => console.error('Inline worker crashed:', err));
    }, 500);
    console.log('Inline render worker started (set RUN_INLINE_WORKER=off to run it separately).');
  }
}

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} received, shutting down...`);

  // Wind the inline worker down first so it claims nothing new while we drain.
  if (stopInlineWorker) stopInlineWorker();

  // Stop accepting new connections; finish in-flight requests.
  server.close((err) => {
    if (err) console.error('Error closing HTTP server:', err);
  });

  // Hard cap so we don't hang forever if a request is wedged.
  const force = setTimeout(() => {
    console.error('Forcing shutdown after 10s grace period.');
    process.exit(1);
  }, 10_000).unref();

  try {
    await pool.end();
    clearTimeout(force);
    process.exit(0);
  } catch (err) {
    console.error('Error closing DB pool:', err);
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// Last-resort safety nets. We log and shut down — the process should be
// restarted by the supervisor (systemd, k8s, pm2) rather than continue in an
// undefined state.
process.on('uncaughtException', (err) => {
  console.error('uncaughtException:', err);
  shutdown('uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection:', reason);
  shutdown('unhandledRejection');
});
