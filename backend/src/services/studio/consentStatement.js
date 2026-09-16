'use strict';

/**
 * The canonical spoken-consent statement.
 *
 * The hosted capture page shows this exact text for the subject to read aloud on
 * camera. Because they read it, the consent video is ALSO a clean reference
 * recording of the person's voice whose transcript we know — which is precisely
 * what the owned IndicF5 zero-shot voice clone needs (reference audio + its
 * transcript). So this string is the single source of truth for both the words
 * on the consent page and the `ref_text` of the cloned voice.
 *
 * PLACEHOLDER pending the Indian-lawyer sign-off (T13). Keep it byte-for-byte in
 * sync with CONSENT_STATEMENT in frontend/app/avatars/[id]/clone/page.jsx — if
 * they drift, the voice clone's transcript stops matching what was actually
 * spoken and the likeness degrades.
 */
const CONSENT_STATEMENT =
  'I consent to ZoQ creating an AI clone of my likeness and voice from footage I ' +
  'provide, and to that clone posting content as me. I confirm I am the person in ' +
  'this video and in the material I am providing, and that I can withdraw this ' +
  'consent at any time.';

module.exports = { CONSENT_STATEMENT };
