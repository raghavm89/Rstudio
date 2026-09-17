'use strict';

const { FaceEmbedder } = require('./faceEmbed');
const { ClipEmbedder } = require('./clipEmbed');

/**
 * Which extractor measures identity, by avatar subject_type.
 *
 *   person    → a FACE embedding (insightface / ArcFace)
 *   character → a WHOLE-IMAGE embedding (CLIP), because a personified fruit has
 *               no face to detect
 *
 * ── Why the mapping is a literal here and not imported from faceQc ──────────
 * faceQc owns the canonical `EMBEDDER_BY_SUBJECT` and requires `config/db` at
 * its top. This factory runs inside the render worker, which must not be able
 * to reach the database (a worker that can query is a worker that can be handed
 * a job it should have left for the API). Importing faceQc here would pull the
 * pool in behind it, so the one line of mapping is duplicated on purpose. The
 * two must agree: person→insightface (face), character→clip (whole image). If a
 * third subject_type is ever added, both sides change together.
 *
 * The value is a THUNK, not an instance: constructing an embedder spawns a
 * Python process and loads a model, and a caller that only ever measures people
 * should never pay to start CLIP. `makeEmbedder` builds exactly the one asked
 * for, when asked.
 */
const BY_SUBJECT = {
  person:    () => new FaceEmbedder({}),
  character: () => new ClipEmbedder({}),
};

/** The normalised subject key — anything unknown is treated as a person. */
function subjectKey(subjectType) {
  return subjectType === 'character' ? 'character' : 'person';
}

/**
 * A fresh embedder for this subject_type.
 *
 * Callers that serve a mix of subjects (qcRunner) cache one per key so neither
 * model is loaded twice; callers that run a single subject (embedSeedSet, one
 * job at a time) just build, use and stop.
 */
function makeEmbedder(subjectType) {
  return BY_SUBJECT[subjectKey(subjectType)]();
}

module.exports = { makeEmbedder, subjectKey };
