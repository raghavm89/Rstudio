'use strict';

const test = require('node:test');
const assert = require('node:assert');
const Seed = require('../src/services/studio/seedCandidates');
const { angleFromYaw, framingFromFraction, qualityFromContrast } = require('../src/services/studio/twinIngest');

/**
 * The AI-clone (twin) coverage fix.
 *
 * Twin frames are uploaded footage with no per-cell labels — before the fix they
 * were stored angle/framing/quality = NULL, so the synthetic coverage gate saw
 * every bucket empty and refused EVERY clone with a "coverage hole". The fix:
 *   • label each twin frame from insightface head pose at ingest, and
 *   • gate a twin set on the ANGLE axis only (the one that decides identity),
 *     while a synthetic pool stays gated on all three axes.
 */

test('twin frontal-only set is short only the missing angles', () => {
  const kept = [{ angle: 'front', framing: 'close', quality: 'soft', batch: 'twin-abc' }];
  const gaps = Seed.coverageGaps(kept);
  assert.deepStrictEqual(gaps.map((g) => g.key), ['angle']);
  assert.deepStrictEqual(gaps[0].missing, ['three-quarter', 'profile']);
});

test('twin set with all three angles passes — even with one framing and one light', () => {
  const kept = [
    { angle: 'front',         framing: 'medium', quality: 'soft', batch: 'twin-x' },
    { angle: 'three-quarter', framing: 'medium', quality: 'soft', batch: 'twin-x' },
    { angle: 'profile',       framing: 'medium', quality: 'soft', batch: 'twin-x' },
  ];
  assert.deepStrictEqual(Seed.coverageGaps(kept), []);
});

test('a synthetic pool is unchanged — still gated on all three axes', () => {
  const kept = [{ angle: 'front', framing: 'close', quality: 'soft', batch: 'pool1' }];
  const gaps = Seed.coverageGaps(kept).map((g) => g.key);
  assert.deepStrictEqual(gaps, ['angle', 'framing', 'quality']);
});

test('a set with no batch (older callers) keeps the full grid', () => {
  const kept = [{ angle: 'front', framing: 'close', quality: 'soft' }];
  assert.deepStrictEqual(Seed.coverageGaps(kept).map((g) => g.key), ['angle', 'framing', 'quality']);
});

test('yaw maps onto the angle axis at the right boundaries', () => {
  assert.strictEqual(angleFromYaw(0), 'front');
  assert.strictEqual(angleFromYaw(-18), 'front');
  assert.strictEqual(angleFromYaw(20), 'front');
  assert.strictEqual(angleFromYaw(21), 'three-quarter');
  assert.strictEqual(angleFromYaw(-45), 'three-quarter');
  assert.strictEqual(angleFromYaw(50), 'three-quarter');
  assert.strictEqual(angleFromYaw(51), 'profile');
  assert.strictEqual(angleFromYaw(-80), 'profile');
  assert.strictEqual(angleFromYaw(null), null);
  assert.strictEqual(angleFromYaw(undefined), null);
});

test('face fraction maps onto framing, luminance spread onto light', () => {
  assert.strictEqual(framingFromFraction(0.20), 'close');
  assert.strictEqual(framingFromFraction(0.05), 'medium');
  assert.strictEqual(framingFromFraction(0.01), 'full');
  assert.strictEqual(framingFromFraction(null), null);
  assert.strictEqual(qualityFromContrast(0.30), 'hard');
  assert.strictEqual(qualityFromContrast(0.10), 'soft');
  assert.strictEqual(qualityFromContrast(null), null);
});
