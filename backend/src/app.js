const express = require('express');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const app = express();

// If behind a reverse proxy (nginx, Cloudflare, ELB), set TRUST_PROXY to the
// number of hops so req.ip and rate-limit keys reflect the real client IP.
if (process.env.TRUST_PROXY) {
  const v = process.env.TRUST_PROXY;
  app.set('trust proxy', /^\d+$/.test(v) ? parseInt(v, 10) : v);
}

// CORS — set headers manually before anything else so preflight always works.
app.use((req, res, next) => {
  const allowedOrigins = (process.env.CORS_ORIGINS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const origin = req.headers.origin || '';
  const allowAll = allowedOrigins.includes('*');
  const allow = allowAll
    ? origin || '*'
    : allowedOrigins.includes(origin) ? origin : false;

  if (allow) {
    res.setHeader('Access-Control-Allow-Origin', allow);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  }

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

app.use(helmet({ crossOriginResourcePolicy: false }));

// Skip access logs in tests; use 'dev' format locally and 'combined' in prod.
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
}

app.use(cookieParser());

// Razorpay webhook needs the raw body for signature verification.
// Keep the original bytes on req.rawBody and expose parsed JSON on req.body
// (handler decides what to do if parse fails).
app.use('/api/payments/webhook', express.raw({ type: 'application/json', limit: '1mb' }), (req, res, next) => {
  req.rawBody = req.body;
  try {
    req.body = req.rawBody.length ? JSON.parse(req.rawBody.toString('utf8')) : {};
  } catch {
    req.body = null;
  }
  next();
});

// ── Studio ────────────────────────────────────────────────────────────────────
// Studio needs a larger JSON body than the rest of the API. A seed set of 16
// face embeddings is 16 x 512 floats — roughly 160 KB — so the global 100 KB
// limit would reject a training request with an opaque 413. Scoped to
// /api/studio so the limit everywhere else stays where it was.
//
// The file-upload route is excluded entirely: it streams a raw body (an image,
// a video, a .safetensors) and enforces its own size cap while streaming.
app.use('/api/studio', (req, res, next) => {
  if (req.path === '/files/upload') return next();
  return express.json({ limit: process.env.STUDIO_JSON_LIMIT || '8mb' })(req, res, next);
});

app.use(express.json({ limit: '100kb' }));

const authRoutes       = require('./routes/auth');
const userRoutes       = require('./routes/users');
const tenantRoutes     = require('./routes/tenants');
const planRoutes       = require('./routes/plans');
const paymentRoutes    = require('./routes/payments');
const contactRoutes    = require('./routes/contact');
const oauthRoutes      = require('./routes/oauth');

// Liveness — process is up.
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Readiness — DB is reachable. Use this for load-balancer probes.
const pool = require('./config/db');
app.get('/ready', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(503).json({ status: 'unavailable', error: err.message });
  }
});
app.use('/api/auth',       authRoutes);
app.use('/api/users',      userRoutes);
app.use('/api/tenants',    tenantRoutes);
app.use('/api/plans',      planRoutes);
app.use('/api/payments',   paymentRoutes);
app.use('/api/contact',   contactRoutes);
app.use('/api/auth',       oauthRoutes);      // Google + GitHub OAuth callbacks
app.use('/api/studio',     require('./routes/studio'));

// The `prompt` stage runs in this process: it needs the database and nothing
// else, and handing it to a render worker would give a secret that lives on a
// laptop the ability to read tenant content. Set STUDIO_SERVER_RUNNER=off to
// disable (e.g. on a web dyno that should not claim work).
if (process.env.NODE_ENV !== 'test' && process.env.STUDIO_SERVER_RUNNER !== 'off') {
  require('./services/studio/serverRunner').ServerRunner.start();
}

/**
 * fal renders run here too.
 *
 * They used to need `npm run studio:worker` in a second terminal, which is a
 * reasonable thing to ask of a GPU box and an unreasonable thing to ask of a
 * product: forget it and jobs queue, the screen counts zero of twenty-four, and
 * nothing says the reason. A fal render is an HTTPS request and a wait — there
 * is no model resident here to justify a process of its own.
 *
 * It claims nothing without a key, so a deployment with no FAL_KEY behaves
 * exactly as it did before. STUDIO_CLOUD_RUNNER=off turns it off outright, for
 * splitting web and render instances later.
 *
 * worker/index.js is still how you run stages on hardware you own.
 */
if (process.env.NODE_ENV !== 'test' && process.env.STUDIO_CLOUD_RUNNER !== 'off') {
  const { CloudRunner } = require('./services/studio/cloudRunner');
  CloudRunner.ready().then((ready) => {
    if (!ready) {
      console.warn('[studio] no FAL_KEY — cloud renders will queue until a worker with one is running');
      return;
    }
    CloudRunner.start();
    console.log(`[studio] rendering fal jobs in this process (${CloudRunner.DEFAULTS.concurrency} at a time)`);
  });
}

/**
 * Abandoned work goes back on the queue.
 *
 * `reapExpiredLeases` was written with the queue and never called by anything —
 * the endpoint that exposes it is commented "safe to call on a timer" and no
 * timer existed. So a job whose worker died stayed `claimed` forever, and the
 * screen watching it counted upward past the time it had promised because a job
 * nobody is working on looks exactly like one that is.
 *
 * Runs in every API process: one idempotent UPDATE whose own WHERE clause is
 * the guard against two of them doing it twice.
 */
if (process.env.NODE_ENV !== 'test' && process.env.STUDIO_REAPER !== 'off') {
  require('./services/studio/reaper').Reaper.start();
}

/**
 * And the seed-set check, when this machine can do it.
 *
 * Same question as FAL_KEY, different capability: embedding faces needs Python
 * and insightface, which a laptop running the whole Studio has and a deployed
 * API host does not. So it is ASKED rather than assumed — if the answer is yes
 * there is nothing to start, and if it is no this claims nothing and the job
 * waits for a worker on a machine that can.
 *
 * The probe imports the dependencies and exits without loading the model, so
 * this costs a fraction of a second at boot.
 */
if (process.env.NODE_ENV !== 'test' && process.env.STUDIO_EMBED_RUNNER !== 'off') {
  const { EmbedRunner } = require('./services/studio/embedRunner');
  EmbedRunner.ready().then((ready) => {
    if (!ready) {
      EmbedRunner.reason().then((why) => console.warn(
        `[studio] this machine cannot measure faces (${why}) — seed-set checks will `
        + 'queue until a worker with insightface is running'));
      return;
    }
    EmbedRunner.start();
    console.log('[studio] checking seed sets in this process');
  });
}

app.use((req, res) => res.status(404).json({ error: 'Route not found' }));

app.use((err, req, res, next) => {
  console.error(`[${req.method} ${req.originalUrl}]`, err);
  const status = err.status || err.statusCode || 500;
  const body = { error: status === 500 ? 'Internal server error' : err.message };
  // A refusal that knows what to do about itself says so. `error` is the terse
  // half a log line wants; `publicMessage` is the sentence written for a person,
  // and dropping it here is how a screen ends up showing a phrase with no hint
  // of the fix. Never on a 500 — an unhandled exception's message is ours, not
  // theirs, and may name internals.
  if (err.code) body.code = err.code;
  if (err.publicMessage && status !== 500) body.message = err.publicMessage;
  if (process.env.NODE_ENV !== 'production' && status === 500) {
    body.detail = err.message;
  }
  res.status(status).json(body);
});

module.exports = app;
