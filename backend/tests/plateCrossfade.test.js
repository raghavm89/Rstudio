'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const path   = require('node:path');

/**
 * The loop dissolve is split across two files, and nothing connects them.
 *
 * `FADE_MS` in Plate.jsx decides WHEN the swap happens; the `transition` on
 * .lp-plate-video decides HOW LONG the fade takes. If they disagree the effect
 * degrades silently — the JS swaps the layers before the CSS has finished, and
 * the hard cut this exists to hide comes back with no error anywhere and no
 * failing test. Someone tuning "make the fade a bit slower" in the stylesheet
 * would reintroduce it and have no way to know.
 *
 * A source scan rather than a shared constant because the two languages cannot
 * share one, and rather than a written-down number because a number in a test
 * has to be updated by the same person who just forgot to update the other file.
 * This reads both and insists they agree.
 *
 * It lives in the backend suite because that is the only test runner in the
 * repo; the frontend has none.
 */

const FE    = path.join(__dirname, '..', '..', 'frontend');
const PLATE = path.join(FE, 'components', 'Plate.jsx');
const CSS   = path.join(FE, 'app', 'landing.css');

const read = (p) => fs.readFileSync(p, 'utf8');

test('the JS fade timer and the CSS transition agree', () => {
  const jsx = read(PLATE);
  const css = read(CSS);

  const jsMatch = jsx.match(/const\s+FADE_MS\s*=\s*(\d+)/);
  assert.ok(jsMatch, 'FADE_MS is gone from Plate.jsx — has the crossfade been removed?');
  const fadeMs = Number(jsMatch[1]);

  // The .lp-plate-video rule, up to its closing brace.
  const rule = css.match(/\.lp-plate-video\s*\{[^}]*\}/);
  assert.ok(rule, '.lp-plate-video rule not found in landing.css');

  const cssMatch = rule[0].match(/transition:\s*opacity\s+(\d+)(ms|s)/);
  assert.ok(cssMatch, 'no opacity transition on .lp-plate-video — the fade would be an instant cut');

  const cssMs = cssMatch[2] === 's' ? Number(cssMatch[1]) * 1000 : Number(cssMatch[1]);
  assert.strictEqual(
    cssMs, fadeMs,
    `FADE_MS is ${fadeMs}ms but the CSS transition is ${cssMs}ms. `
    + 'The layers swap before the dissolve finishes, so the loop cut returns.'
  );
});

test('native looping remains the fallback', () => {
  const jsx = read(PLATE);
  // If `loop` is ever hard-coded off, a browser that refuses the second play()
  // leaves the plate frozen on a still frame instead of looping as it does now.
  assert.match(
    jsx, /loop=\{!xfade\}/,
    'the video must fall back to native loop when the crossfade is off'
  );
  // And the crossfade must stay opt-in rather than assumed.
  assert.match(
    jsx, /useState\(false\)/,
    'xfade should start false so the shipped behaviour is the current one'
  );
});

test('the reduced-motion path shows the poster, not a video', () => {
  const jsx = read(PLATE);
  assert.match(jsx, /prefers-reduced-motion/, 'reduced motion is not consulted');
  assert.match(
    jsx, /stillOnly\s*\?/,
    'reduced motion must render the still, not merely disable the transition'
  );
  // The slate must describe real footage in both the video and still cases, or
  // the reduced-motion viewer gets a real photograph captioned with the drawn
  // plate's invented framing and a fake timecode.
  assert.ok(
    !/\$\{live \? 'has-footage'/.test(jsx) && /hasFootage \? 'has-footage'/.test(jsx),
    'the has-footage class must key off hasFootage, not live'
  );
});
