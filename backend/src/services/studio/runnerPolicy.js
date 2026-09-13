'use strict';

/**
 * Where does a stage run?
 *
 * This used to be hardcoded in the orchestrator — stills on `mac`, motion on
 * `cloud`. That is now wrong, and wrong in a way that matters legally rather
 * than technically.
 *
 * FLUX.1-dev weights are licensed for non-commercial use. A monetised avatar
 * channel — brand deal, affiliate link, ad revenue — is commercial use of the
 * images, on a personal account as much as a customer's. Every shoot created
 * through the API is intended to be published, so **stills default to `cloud`**,
 * where fal's hosted endpoint carries commercial rights through their agreement
 * with Black Forest Labs.
 *
 * The local Mac path is still supported and still useful — it is free, unmetered
 * iteration for persona development, seed-set culling, expression-baseline
 * calibration and prompt sweeps. But it has to be asked for explicitly, by
 * something that knows the output will not be published, rather than being the
 * silent default that a licence violation rides in on.
 *
 * Making this a named module rather than a literal in the orchestrator is the
 * point: the reason lives next to the decision, and a test can assert it.
 */

/** Stages that touch image weights and therefore carry the licence question. */
const LICENCE_BEARING = new Set(['still', 'qc']);

const CLOUD_ONLY = new Set(['motion', 'lipsync']);
const SERVER_ONLY = new Set(['prompt', 'voice', 'assemble', 'copy', 'publish', 'insights', 'brief']);

class RunnerPolicyError extends Error {}

/**
 * @param {string} stage
 * @param {object} opts
 * @param {'cloud'|'local'} opts.intent
 *   'cloud'  — the default. Output may be published, so licensed weights only.
 *   'local'  — R&D that will never be published. Caller must mean it.
 * @returns {'mac'|'cloud'|'server'}
 */
function runnerFor(stage, { intent = 'cloud' } = {}) {
  if (SERVER_ONLY.has(stage)) return 'server';
  if (CLOUD_ONLY.has(stage)) return 'cloud';

  if (LICENCE_BEARING.has(stage)) {
    // QC follows its still. Running the check on a different machine from the
    // image it is checking would mean shipping the image back and forth for no
    // gain, so the two move together.
    return intent === 'local' ? 'mac' : 'cloud';
  }

  if (stage === 'lora_train') return 'cloud';

  throw new RunnerPolicyError(`No runner policy for stage "${stage}"`);
}

/**
 * Guard the explicit opt-out.
 *
 * `intent: 'local'` is a claim that the output will not be published. A shoot
 * that is already attached to a publishing slot contradicts that claim, and the
 * refusal is deliberately not overridable — an override would be used, once, at
 * the exact moment it mattered.
 */
function assertIntentAllowed(intent, { willPublish = false } = {}) {
  if (intent !== 'local' && intent !== 'cloud') {
    throw new RunnerPolicyError(`intent must be 'cloud' or 'local', got "${intent}"`);
  }
  if (intent === 'local' && willPublish) {
    throw Object.assign(
      new RunnerPolicyError(
        'Local generation uses non-commercially-licensed weights and cannot be used for a shoot that will be published'
      ),
      { status: 409, code: 'LICENCE_INTENT_CONFLICT' }
    );
  }
  return intent;
}

module.exports = {
  runnerFor,
  assertIntentAllowed,
  RunnerPolicyError,
  LICENCE_BEARING,
  CLOUD_ONLY,
  SERVER_ONLY,
};
