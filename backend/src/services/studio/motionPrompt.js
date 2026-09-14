"use strict";

/**
 * The motion prompt for the image-to-video (motion) stage.
 *
 * A still's prompt describes how the frame LOOKS — full scene, wardrobe,
 * lighting, the whole identity block. Handing that to an image-to-video model
 * (Seedance) is the bug the build log flagged: an i2v model reads the prompt as
 * "what should change", so a scene description makes it re-invent the scene and
 * drift the face. What it needs instead is a description of MOTION only — a
 * small camera move and a little life — plus an explicit hold on identity.
 *
 * So the motion prompt is derived from the shot's FRAMING (how much of her is in
 * frame decides which camera move reads well) and kept short and
 * appearance-free. It never repeats the still's look prompt.
 */

const BASE =
  "subtle, natural motion; gentle and lifelike; keep the same face and identity; " +
  "no warping, no morphing, no extra limbs, no text";

const BY_FRAMING = {
  close:  "a slow push-in on her face, soft blinking, a faint shift of expression, a few strands of hair moving",
  medium: "a slow dolly-in, natural breathing, small head and shoulder movement, hair catching the air",
  full:   "a slow parallax drift, a relaxed weight-shift, clothing and hair moving naturally",
  wide:   "a slow, steady camera drift with gentle ambient movement in the scene",
};

/**
 * Derive a short motion instruction for one shot.
 *
 * When the planner supplied a MOTION hint for the scene (what the subject
 * actually DOES on camera — "she pulls the lat bar down to her chest and lets it
 * rise" — for a demo or an action reel), animate that, so the video shows the
 * action rather than a static pose under a camera glide. The face-hold BASE
 * still rides along to keep identity stable. Without a hint (a lifestyle or
 * portrait scene) it falls back to the framing-based camera move.
 */
function deriveMotionPrompt(shot = {}) {
  const hint = shot && shot.scene_continuity && String(shot.scene_continuity.motion_text || '').trim();
  const move = hint || BY_FRAMING[shot.framing] || BY_FRAMING.medium;
  return `${move}. ${BASE}`;
}

module.exports = { deriveMotionPrompt, BASE, BY_FRAMING };
