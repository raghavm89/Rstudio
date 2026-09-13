'use strict';
require('dotenv').config();   // same as server.js line 1 — the worker reads the same .env

/**
 * Studio render worker.
 *
 * Polls Rstudio for queued jobs, runs them through a provider, uploads the
 * results to object storage, and reports back. It is a queue consumer, not an
 * application — keep it small.
 *
 * Four properties worth stating, because each is a decision rather than an
 * accident:
 *
 * 1. IT POLLS OUT, IT IS NEVER CALLED IN. No public IP, no tunnel, no port
 *    forwarding, and the laptop can be closed without breaking anything: the
 *    lease expires server-side and the work returns to the queue.
 *
 * 2. IT RUNS EXACTLY ONE JOB AT A TIME. An M5 Max with 36 GB cannot hold Flux,
 *    a video model and a lipsync model resident together. Concurrency here would
 *    not double throughput, it would swap.
 *
 * 3. IT CHECKS THE PROVIDER BEFORE IT CLAIMS. Claiming work you cannot start
 *    burns an attempt and strands the job for a lease period.
 *
 * 4. IT DOES NOT KNOW WHICH PROVIDER IT HOLDS. `fal` and `local` present the
 *    same interface, so the licence decision — published work on fal's licensed
 *    endpoint, R&D on local weights — is expressed by which runner the server
 *    assigns a job, not by a branch in here.
 *
 * Run against fal (the normal case):
 *   STUDIO_API=https://api.rstudio.app STUDIO_WORKER_TOKEN=... \
 *   WORKER_RUNNER=cloud WORKER_PROVIDER=fal FAL_KEY=... node worker/index.js
 *
 * Run against local ComfyUI (R&D only — non-commercial weights):
 *   WORKER_RUNNER=mac WORKER_PROVIDER=local node worker/index.js
 */

const path = require('path');
const { FalProvider }   = require('./providers/fal');
const { LocalProvider } = require('./providers/local');
const { createUploader } = require('./uploader');
const { runEmbed } = require('./embedSeedSet');

const CONFIG = {
  api:          process.env.STUDIO_API          || 'http://127.0.0.1:3000',
  token:        process.env.STUDIO_WORKER_TOKEN || '',
  workerId:     process.env.WORKER_ID           || `worker-${require('os').hostname()}`,
  providerName: process.env.WORKER_PROVIDER     || 'fal',
  runner:       process.env.WORKER_RUNNER       || 'cloud',
  comfyUrl:     process.env.COMFY_URL           || 'http://127.0.0.1:8188',
  // seed_still and calib_still by default: a worker that only asks for `still`
  // will never pick up candidate generation or calibration, and those jobs sit
  // queued looking like nobody started. Both are the same render to this
  // worker — the separation is about which meter they draw on, which is the
  // API's business and not a renderer's.
  stages:      (process.env.WORKER_STAGES       || 'still,seed_still,calib_still').split(',').map((s) => s.trim()).filter(Boolean),
  leaseSeconds: parseInt(process.env.WORKER_LEASE_SECONDS, 10) || 300,
  idlePollMs:   parseInt(process.env.WORKER_IDLE_POLL_MS, 10)  || 3000,
  downPollMs:   parseInt(process.env.WORKER_DOWN_POLL_MS, 10)  || 15000,
  // Seed-set checks, on by default. Set WORKER_EMBED=off on a worker whose
  // machine has no insightface, so the jobs wait for one that does rather than
  // failing permanently on the one that cannot.
  embed:        process.env.WORKER_EMBED !== 'off',
};

// Which storage folder each stage's output belongs in. Shared with the
// in-process runner: a stage filed under one kind here and another there is a
// frame the culling screen cannot find.
const { KIND_BY_STAGE } = require('../src/services/studio/stageKinds');

let shuttingDown = false;

// ── API ───────────────────────────────────────────────────────────────────────

async function api(pathname, options = {}) {
  const res = await fetch(`${CONFIG.api}${pathname}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${CONFIG.token}`,
      'X-Worker-Id': CONFIG.workerId,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (res.status === 204) return null;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || `${options.method || 'GET'} ${pathname} → ${res.status}`);
    err.status = res.status;
    err.code = body.code;
    throw err;
  }
  return body;
}

const claimNext = () =>
  api(`/api/studio/jobs/next?runner=${CONFIG.runner}&stages=${CONFIG.stages.join(',')}&lease=${CONFIG.leaseSeconds}`);

/** The seed-set check. Always `mac`, because it runs on this machine's hardware. */
const claimEmbed = () =>
  api(`/api/studio/jobs/next?runner=mac&stages=embed&lease=${CONFIG.leaseSeconds}`);

const heartbeat = (id) =>
  api(`/api/studio/jobs/${id}/heartbeat`, {
    method: 'POST',
    body: JSON.stringify({ lease_seconds: CONFIG.leaseSeconds }),
  });

const report = (id, payload) =>
  api(`/api/studio/jobs/${id}/result`, { method: 'POST', body: JSON.stringify(payload) });

const requestUploadTarget = (jobId, { filename, contentType, kind }) =>
  api(`/api/studio/jobs/${jobId}/upload-target`, {
    method: 'POST',
    body: JSON.stringify({ filename, contentType, kind }),
  });

// ── Job ───────────────────────────────────────────────────────────────────────

/**
 * Run one job.
 *
 * The heartbeat runs on a timer at a third of the lease, so two consecutive
 * misses still leave room before the reaper takes the job. If the server says
 * LEASE_LOST the work is abandoned immediately — finishing a render nobody is
 * waiting for costs the same as one they are.
 */
async function runJob(provider, uploader, job) {
  const started = Date.now();
  let lost = false;

  const beat = setInterval(async () => {
    try {
      await heartbeat(job.id);
    } catch (err) {
      if (err.code === 'LEASE_LOST') {
        lost = true;
        clearInterval(beat);
        console.warn(`[${job.id}] lease lost — abandoning`);
      }
    }
  }, Math.max(10_000, (CONFIG.leaseSeconds * 1000) / 3));

  try {
    // Not a render, so it neither asks a provider nor uploads anything.
    if (job.stage === 'embed') {
      const measured = await runEmbed(job);
      clearInterval(beat);
      if (lost) return;
      await report(job.id, { ...measured, result: { ...measured.result, elapsed_ms: Date.now() - started } });
      console.log(`[${job.id}] measured ${measured.result.count} faces in ${Math.round((Date.now() - started) / 1000)}s`);
      return;
    }

    const { artifacts, meta } = await provider.run(job, {
      onProgress: async () => {
        if (lost) throw Object.assign(new Error('Lease lost'), { permanent: true });
      },
    });

    // Upload only after the lease is known good. Pushing bytes for a job that
    // was reaped ten minutes ago spends bandwidth on an object nothing will
    // reference — the row that would have pointed at it is already requeued.
    if (lost) return;

    const uploaded = await uploader.uploadAll(job.id, artifacts, {
      kind: KIND_BY_STAGE[job.stage] || 'asset',
    });

    if (lost) return;

    await report(job.id, {
      ok: true,
      result: {
        ...meta,
        assets: uploaded,
        elapsed_ms: Date.now() - started,
      },
      megapixels: Number(meta.megapixels || 0),
      seconds_generated: Number(meta.seconds_generated || 0),
      cost_cents: Number(meta.cost_cents || 0),
    });

    console.log(
      `[${job.id}] done — ${uploaded.length} asset(s), ` +
      `${Math.round((Date.now() - started) / 1000)}s, ${Number(meta.cost_cents || 0).toFixed(2)}c`
    );
  } catch (err) {
    clearInterval(beat);
    if (lost) return;
    // Every provider marks its own errors. An unmarked error is something we did
    // not anticipate, and the safe reading of "unanticipated" is that a retry
    // might work — a wrong `permanent` strands a job that would have succeeded.
    const permanent = err.permanent === true;
    console.error(`[${job.id}] failed (${permanent ? 'permanent' : 'will retry'}): ${err.message}`);
    try {
      await report(job.id, { ok: false, error: err.message, permanent });
    } catch (reportErr) {
      // Nothing more to do — the lease will expire and the server will requeue.
      console.error(`[${job.id}] could not report failure: ${reportErr.message}`);
    }
  } finally {
    clearInterval(beat);
  }
}

// ── Embedding ─────────────────────────────────────────────────────────────────

// Embedding is shared with the API's in-process runner — see
// worker/embedSeedSet.js for why there is only one copy of it.

// ── Providers ─────────────────────────────────────────────────────────────────

function buildProvider(name) {
  switch (name) {
    case 'fal':
      return new FalProvider();
    case 'local':
      return new LocalProvider({ baseUrl: CONFIG.comfyUrl, clientId: CONFIG.workerId });
    default:
      throw new Error(`Unknown WORKER_PROVIDER "${name}" — expected fal or local`);
  }
}

// ── Loop ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!CONFIG.token) {
    console.error('STUDIO_WORKER_TOKEN is not set. Refusing to start.');
    process.exit(1);
  }

  const provider = buildProvider(CONFIG.providerName);
  const uploader = createUploader({ requestTarget: requestUploadTarget });

  // A local worker running licence-bearing stages is legitimate (it is how the
  // persona gets developed) but it should never be a surprise, so say it out
  // loud at startup rather than discovering it in a bill or a takedown.
  if (CONFIG.providerName === 'local') {
    console.warn('⚠️  Local provider: FLUX.1-dev weights are non-commercial. R&D only — do not publish this output.');
  }

  console.log(`Studio worker ${CONFIG.workerId}`);
  console.log(`  api      ${CONFIG.api}`);
  console.log(`  provider ${CONFIG.providerName}`);
  console.log(`  runner   ${CONFIG.runner}`);
  console.log(`  stages   ${CONFIG.stages.join(', ')}`);
  console.log(`  embed    ${CONFIG.embed ? 'yes — also claims seed-set checks' : 'no (WORKER_EMBED=off)'}`);

  let wasDown = false;

  while (!shuttingDown) {
    // Check the provider BEFORE claiming. Claiming work we cannot start burns an
    // attempt and strands the job until its lease expires.
    if (!(await provider.isReady())) {
      if (!wasDown) console.warn(`Provider ${provider.name} is not ready — waiting`);
      wasDown = true;
      await sleep(CONFIG.downPollMs);
      continue;
    }
    if (wasDown) {
      console.log(`Provider ${provider.name} is ready`);
      wasDown = false;
    }

    let claimed;
    try {
      claimed = await claimNext();
      /**
       * Also take embedding work, whichever render runner this worker holds.
       *
       * `embed` is `runner: 'mac'` because it runs insightface on real hardware.
       * A worker pointed at fal holds `runner: 'cloud'`, so without this the
       * embed jobs would sit unclaimed and the Train screen would count at
       * somebody — the exact silence the in-process cloud runner was built to
       * remove. Embedding does not compete with a render for a GPU; it is a few
       * seconds of CPU. So one `node worker/index.js` does both.
       *
       * Asked second, and only when there is no render waiting: a person
       * watching a batch land outranks a person waiting on a check.
       */
      if (!claimed && CONFIG.embed) claimed = await claimEmbed();
    } catch (err) {
      console.error(`claim failed: ${err.message}`);
      await sleep(CONFIG.downPollMs);
      continue;
    }

    if (!claimed) {
      await sleep(CONFIG.idlePollMs);
      continue;
    }

    console.log(`[${claimed.job.id}] claimed — stage ${claimed.job.stage}`);
    await runJob(provider, uploader, claimed.job);

    if (provider.afterJob) await provider.afterJob();
  }

  console.log('Worker stopped.');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (shuttingDown) process.exit(1);
    shuttingDown = true;
    console.log('\nFinishing current job, then stopping. Press again to force.');
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Worker crashed:', err);
    process.exit(1);
  });
}

module.exports = { runJob, buildProvider, CONFIG, KIND_BY_STAGE };
