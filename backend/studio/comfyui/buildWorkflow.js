'use strict';

/**
 * This file used to be a BYTE-IDENTICAL COPY of
 * `src/services/studio/comfyui/buildWorkflow.js`.
 *
 * Nothing required it. The live module is the one under `src/services/`, which
 * is what `promptStage`, `lookProfile`, `calibration` and `calibrationRun` all
 * load and what `studio/seed-set.js` reaches across the tree to get. The only
 * consumer of this path was its own test file beside it — and that test was not
 * in the `npm test` glob either, so a duplicate of the most correctness-
 * critical module in the product sat here being neither used nor checked.
 *
 * It stayed accurate purely by luck. The moment the live module changed
 * (migration 053 moved expression language out of a hardcoded object and into
 * the vocabulary) this copy still had the old hint map in it, and the test
 * beside it would have gone on asserting — had anyone run it — that a crying
 * frame is deliberately generated neutral. Which is exactly the bug 053 fixes.
 *
 * So it is a re-export now. There is one prompt assembler, the test next door
 * exercises it against the real seeded vocabulary, and that test is in the glob.
 */

module.exports = require('../../src/services/studio/comfyui/buildWorkflow');
