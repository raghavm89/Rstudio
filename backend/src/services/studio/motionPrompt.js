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

/** Derive a short, appearance-free motion instruction for one shot. */
function deriveMotionPrompt(shot = {}) {
  const framing = BY_FRAMING[shot.framing] || BY_FRAMING.medium;
  return `${framing}. ${BASE}`;
}

module.exports = { deriveMotionPrompt, BASE, BY_FRAMING };
