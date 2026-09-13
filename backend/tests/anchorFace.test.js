'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const path   = require('node:path');

const ROOT = path.join(__dirname, '..');
const FE   = path.join(ROOT, '..', 'frontend');
const read = (p) => fs.readFileSync(p, 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

process.env.STUDIO_STORAGE_SECRET = process.env.STUDIO_STORAGE_SECRET || 'test-secret';
const Prompt = require('../src/services/studio/seedPrompt');
const { FalProvider } = require('../worker/providers/fal');

/**
 * One face, chosen once, that every later frame is generated from.
 *
 * Base Flux draws a TYPE of person from text, so twenty-four frames from one
 * description are twenty-four people who match it. Measured on the one persona
 * culled by hand — `personas/aanya-kapoor/` — 209 candidates yielded 16
 * keepers, 7.7%. The export gate needs twelve, so the twenty-four-frame batch
 * the product shipped could not arithmetically produce a usable set.
 */

// ── The anchors ──────────────────────────────────────────────────────────────

test('anchors are faces on a plain ground, differing only by seed', () => {
  const avatar = { identity_block: '45 year old North Indian man, warm brown skin, thick moustache' };
  const frames = Prompt.planAnchors({ avatar, look: {}, vocab: {}, count: 6 });

  assert.strictEqual(frames.length, 6);
  assert.strictEqual(new Set(frames.map((f) => f.seed)).size, 6,
    'six frames on one seed would be six copies of one face, not a choice');

  // All one cell: the frame is about to be handed to a model as "this is the
  // person", and six faces are being compared to each other.
  const cells = new Set(frames.map((f) => `${f.cell.framing}/${f.cell.angle}/${f.cell.quality}`));
  assert.deepStrictEqual([...cells], ['close/front/soft']);

  for (const f of frames) {
    assert.match(f.prompt, /plain neutral background/);
    assert.doesNotMatch(f.prompt, /balcony|gym|cafe|promenade|desk|monitors/,
      'a busy room is exactly what must not be carried into three hundred later frames');
    assert.match(f.prompt, /^45 year old North Indian man/,
      'the identity block still leads, verbatim');
  }
});

test('the number of faces to choose between is bounded at both ends', () => {
  assert.strictEqual(Prompt.clampAnchors(1), Prompt.ANCHOR_MIN, 'one face is not a choice');
  assert.strictEqual(Prompt.clampAnchors(9999), Prompt.ANCHOR_MAX, 'nor is a hundred');
  assert.strictEqual(Prompt.clampAnchors(undefined), Prompt.ANCHOR_DEFAULT);
  assert.strictEqual(Prompt.clampAnchors('nonsense'), Prompt.ANCHOR_DEFAULT);
  assert.strictEqual(Prompt.clampAnchors(6), 6);
  assert.ok(Prompt.ANCHOR_MAX < 24, 'choosing a face must cost far less than a pool');
});

// ── Rendering from one ───────────────────────────────────────────────────────

test('a reference on the job is what switches the endpoint, not a second stage', () => {
  const p = new FalProvider({ apiKey: 'k' });

  // A `seed_anchored` key in ENDPOINTS would invent a stage the API has never
  // heard of, and the in-process runner reads that map to decide what it may
  // claim — so it would claim jobs that cannot exist.
  assert.strictEqual(p.supports('seed_anchored'), false);
  assert.ok(p.anchoredModel, 'the anchored model must still be configurable');
  assert.notStrictEqual(p.anchoredModel, p.endpoints.seed_still);

  const src = strip(read(path.join(ROOT, 'worker', 'providers', 'fal.js')));
  assert.match(src, /if \(gen\.reference_image_url\) return this\._runAnchored/,
    'the payload decides, so an unanchored avatar renders exactly as before');

  const fn = src.slice(src.indexOf('async _runAnchored'), src.indexOf('_imagesToResult({ gen, input, out, model, requestId })'));
  assert.match(fn, /reference_image_url: referenceUrl/);
  assert.match(fn, /id_weight/);
  assert.match(fn, /max_sequence_length: '512'/,
    'the default 128 truncates a prompt whose tail is the axes the gate checks');
  assert.match(fn, /ensureFetchable/,
    'fal FETCHES the reference — local disk has to be pushed through fal storage first');
  assert.match(fn, /model: this\.anchoredModel/);
});

test('the stored name follows the bytes, because storage serves by extension', () => {
  // The identity-preserving endpoint takes no `output_format` and answers JPEG.
  // A JPEG written as `.png` is then served as `image/png`.
  const p = new FalProvider({ apiKey: 'k' });
  const one = (contentType) => p._imagesToResult({
    gen: { filenamePrefix: '0007-close-front-soft' },
    input: { image_size: { width: 880, height: 1104 }, seed: 5 },
    out: { images: [{ url: 'u', ...(contentType ? { content_type: contentType } : {}) }], seed: 9 },
    model: 'm', requestId: 'r',
  }).artifacts[0];

  assert.strictEqual(one('image/jpeg').filename, '0007-close-front-soft-1.jpg');
  assert.strictEqual(one('image/webp').filename, '0007-close-front-soft-1.webp');
  assert.strictEqual(one('image/png').filename, '0007-close-front-soft-1.png');
  assert.strictEqual(one(undefined).filename, '0007-close-front-soft-1.png', 'and PNG is still the default');
  assert.strictEqual(one('image/jpeg').contentType, 'image/jpeg');
});

test('the anchored endpoint bills on its own rate, and says the default is a guess', () => {
  const p = new FalProvider({ apiKey: 'k', pricing: { anchoredPerMegapixelCents: 9 } });
  const cost = (model) => p._imagesToResult({
    gen: {}, input: { image_size: { width: 880, height: 1104 }, seed: 1 },
    out: { images: [{ url: 'u' }], seed: 1 }, model, requestId: 'r',
  }).meta.cost_cents;

  assert.strictEqual(cost(p.endpoints.seed_still), p.pricing.stillPerMegapixelCents);
  assert.strictEqual(cost(p.anchoredModel), 9, 'a different endpoint bills at its own rate');

  const src = read(path.join(ROOT, 'worker', 'providers', 'fal.js'));
  assert.match(src, /PLACEHOLDER/,
    'a made-up rate poisons the self-hosting query in the direction nobody notices');
  assert.match(src, /FAL_PRICE_ANCHORED_MP_CENTS/);
});

// ── Keeping the two kinds apart ──────────────────────────────────────────────

test('anchors are a choice, not part of the pool being culled', () => {
  const svc = strip(read(path.join(ROOT, 'src', 'services', 'studio', 'seedCandidates.js')));

  const list = svc.slice(svc.indexOf('async function list'), svc.indexOf('async function mark'));
  assert.match(list, /kind = 'pool'/,
    'six frames of one cell would tell the coverage strip that cell is six times better covered');

  // And the same filter on the counts that steer the next batch. Without it the
  // walk sees close/front/soft as well covered by the anchors, skips it, and
  // the gate can never be satisfied — measured at 17 of 18 cells.
  const counts = svc.slice(svc.indexOf('async function cellCounts'), svc.indexOf('async function nextIndex'));
  assert.match(counts, /kind = 'pool'/);

  // `c.id = NULL` is NULL, not false, and an avatar with no anchor is the
  // ordinary case — every anchor came back `chosen: null`.
  const anchors = svc.slice(svc.indexOf('async function anchors'), svc.indexOf('async function chooseAnchor'));
  assert.match(anchors, /COALESCE\(c\.id = a\.anchor_candidate_id, false\)/);
  assert.match(anchors, /kind = 'anchor'/);
});

test('choosing a face cannot reach outside this avatar', () => {
  const svc = strip(read(path.join(ROOT, 'src', 'services', 'studio', 'seedCandidates.js')));
  const fn = svc.slice(svc.indexOf('async function chooseAnchor'));

  // The id arrives from a request. An avatar whose face is another tenant's
  // frame is a cross-tenant read dressed as a preference.
  assert.match(fn, /WHERE id = \$1 AND avatar_id = \$2 AND tenant_id = \$3 AND kind = 'anchor'/);
  assert.match(fn, /NOT_AN_ANCHOR/);
  // fal fetches the reference rather than receiving it.
  assert.match(fn, /ANCHOR_NOT_STORED/);
  assert.match(fn, /UPDATE avatars SET anchor_candidate_id = \$1 WHERE id = \$2 AND tenant_id = \$3/);
});

test('one queue function serves both kinds, and only a pool is anchored', () => {
  const src = strip(read(path.join(ROOT, 'src', 'services', 'studio', 'seedBatch.js')));
  assert.match(src, /kind = 'pool' \}\) \{/, 'one function, defaulting to what it always did');
  assert.match(src, /anchoring \? SeedPrompt\.clampAnchors\(count\) : clampCount\(count\)/);
  assert.match(src, /const reference = anchoring \? null : await anchorReference\(client, avatar\)/,
    'an anchor generated from an anchor is circular');

  // A missing or unstored anchor falls back to the text-only path rather than
  // refusing: generating something beats generating nothing.
  const ref = src.slice(src.indexOf('async function anchorReference'), src.indexOf('async function queue'));
  assert.match(ref, /if \(!avatar\.anchor_candidate_id\) return null/);
  assert.match(ref, /if \(!anchor \|\| !anchor\.storage_key\) return null/);
  assert.match(ref, /publicly_fetchable: isPubliclyFetchable\(\)/,
    'decided where the storage driver is known, not guessed from the shape of a URL');
  assert.match(ref, /readUrl/, 'presigned; publicUrl would undo the signature');
});

test('the frame records what it was for, off the job rather than off its name', () => {
  const settle = strip(read(path.join(ROOT, 'src', 'services', 'studio', 'jobResult.js')));
  assert.match(settle, /kind: p\.kind === 'anchor' \? 'anchor' : 'pool'/);

  const rec = strip(read(path.join(ROOT, 'src', 'services', 'studio', 'seedCandidates.js')));
  const fn = rec.slice(rec.indexOf('async function recordGenerated'), rec.indexOf('async function anchors'));
  assert.match(fn, /kind = 'pool'/, 'defaulted, so every existing caller keeps meaning what it meant');
  assert.match(fn, /kind === 'anchor' \? 'anchor' : 'pool'/, 'and never trusts an arbitrary string');
});

// ── The migration ────────────────────────────────────────────────────────────

test('the anchor can only ever be a frame we generated', () => {
  const raw = read(path.join(ROOT, 'src', 'db', 'migrations', '050_anchor_face.sql'));
  // Comments stripped before matching the DDL. This file explains itself at
  // length, and "ON DELETE SET NULL rather than CASCADE" appears in prose
  // directly above the line that has to say it — so an assertion against the
  // whole file is satisfied by the explanation whether or not the column
  // agrees with it.
  const sql = raw.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');

  // Migration 033 removed generating from a photograph of a real person, by
  // CHECK constraint. Nothing here may weaken that: the column references
  // seed_candidates, and rows get there only from a render job this system
  // queued, so it cannot be a photograph somebody uploaded.
  assert.match(sql, /anchor_candidate_id BIGINT\s*\n?\s*REFERENCES seed_candidates\(id\)/);
  assert.match(sql, /ON DELETE SET NULL/,
    'deleting one frame must un-anchor the avatar, not delete it');
  assert.match(sql, /CHECK \(kind IN \('anchor', 'pool'\)\)/);
  assert.match(sql, /DEFAULT 'pool'/, 'every existing row keeps meaning what it meant');
  assert.match(raw, /not `reference` mode/i, 'the reasoning has to travel with the column');
});

// ── The screen ───────────────────────────────────────────────────────────────

test('the face is chosen before a pool is bought', () => {
  const page = read(path.join(FE, 'app', 'avatars', '[id]', 'face', 'page.jsx'));

  // The order of the branches is the flow. Choosing has to come before the
  // empty state that sells a pool, or somebody buys three hundred frames of a
  // face they never picked.
  const arriving = page.indexOf('data.generating) {');
  const choose   = page.indexOf('!data.anchor_chosen_id) {');
  const empty    = page.indexOf('if (!candidates.length) {');
  assert.ok(arriving > -1 && choose > -1 && empty > -1, 'all three states must exist');
  assert.ok(arriving < choose && choose < empty,
    'still generating, then choose, then offer a pool');

  assert.match(page, /function ChooseFace/);
  assert.match(page, /post\(`\/avatars\/\$\{avatarId\}\/anchor`, \{ candidate_id: picked \}\)/);
  assert.match(page, /disabled=\{!picked \|\| busy\}/, 'nothing is chosen by accident');

  // And the empty state asks for the right thing depending on where you are.
  assert.match(page, /anchored\s*\n?\s*\? <Generate avatarId=/);
  assert.match(page, /: <GenerateFaces avatarId=/);
  assert.match(page, /anchored=\{Boolean\(data\.anchor_chosen_id\)\}/);
});

test('the screen names what is arriving', () => {
  // "Generating Aanya's photos" over six headshots tells somebody their pool is
  // on the way when what is coming is a question.
  const page = read(path.join(FE, 'app', 'avatars', '[id]', 'face', 'page.jsx'));
  assert.match(page, /generating\.kind === 'anchor'/);

  const ctl = strip(read(path.join(ROOT, 'src', 'controllers', 'studioCandidateController.js')));
  assert.match(ctl, /MIN\(payload->>'kind'\)\s*\n?\s*AS kind/);
  assert.match(ctl, /kind: batchRow\.kind === 'anchor' \? 'anchor' : 'pool'/,
    'and never trusts the string straight out of the payload');

  // The anchors travel with the pool on one response: the screen is one screen
  // with several states, and two polls to decide one thing is two ways to be
  // half-updated.
  assert.match(ctl, /anchors: anchorRows\.map/);
  assert.match(ctl, /anchor_chosen_id: avatar\.anchor_candidate_id \|\| null/);
});

test('creating an avatar buys faces, not a pool', () => {
  const src = strip(read(path.join(ROOT, 'src', 'controllers', 'studioAvatarController.js')));
  const call = src.slice(src.indexOf('SeedBatch.queue(client, {'));
  assert.match(call.slice(0, 400), /kind: 'anchor'/,
    'describing a face and being charged for 24 frames of a stranger is the bug');
});
