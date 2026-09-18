import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSocialUrl, parsePosts, validEmail, normaliseSignup } from '../lib/prelaunch.mjs';

test('instagram posts and reels embed by canonical permalink', () => {
  assert.deepEqual(parseSocialUrl('https://www.instagram.com/p/Cxyz_12-ab/?igsh=abc'),
    { kind: 'instagram', permalink: 'https://www.instagram.com/p/Cxyz_12-ab/' });
  assert.deepEqual(parseSocialUrl('https://instagram.com/reel/DEF456'),
    { kind: 'instagram', permalink: 'https://www.instagram.com/reel/DEF456/' });
  assert.deepEqual(parseSocialUrl('https://www.instagram.com/aanya.kapoor/reels/GHI789/'),
    { kind: 'instagram', permalink: 'https://www.instagram.com/reel/GHI789/' });
  assert.equal(parseSocialUrl('https://www.instagram.com/aanya.kapoor/'), null, 'a profile is not a post');
});

test('youtube in every shape people paste', () => {
  const id = 'dQw4w9WgXcQ';
  for (const u of [
    `https://www.youtube.com/watch?v=${id}&t=12s`,
    `https://youtu.be/${id}?si=xyz`,
    `https://youtube.com/shorts/${id}`,
    `https://m.youtube.com/watch?v=${id}`,
    `https://www.youtube-nocookie.com/embed/${id}`,
  ]) assert.deepEqual(parseSocialUrl(u), { kind: 'youtube', id }, u);
  assert.equal(parseSocialUrl('https://www.youtube.com/@aanyakapoor'), null, 'a channel is not a video');
  assert.equal(parseSocialUrl('https://www.youtube.com/watch?v=short'), null);
});

test('junk never reaches the page', () => {
  for (const u of ['', 'not a url', 'javascript:alert(1)', 'https://example.com/p/abc/', 42, null, undefined])
    assert.equal(parseSocialUrl(u), null, String(u));
});

test('parsePosts keeps order, drops junk, reports skips', () => {
  const skipped = [];
  const posts = parsePosts(['https://youtu.be/dQw4w9WgXcQ', 'nope', 'https://www.instagram.com/p/AAA/'], (s) => skipped.push(s));
  assert.equal(posts.length, 2);
  assert.equal(posts[0].kind, 'youtube');
  assert.equal(posts[1].kind, 'instagram');
  assert.equal(posts[1].url, 'https://www.instagram.com/p/AAA/');
  assert.deepEqual(skipped, ['nope']);
  assert.deepEqual(parsePosts(undefined), []);
});

test('email validation', () => {
  assert.ok(validEmail('raghav@example.in'));
  assert.ok(validEmail('  a.b+c@sub.example.co.uk '));
  for (const bad of ['', 'a@b', 'a b@c.com', '@x.com', 'x@.com', 'x@y.c', 'a'.repeat(250) + '@x.com', null])
    assert.equal(validEmail(bad), false, String(bad));
});

test('signup normalisation', () => {
  assert.deepEqual(normaliseSignup({ email: ' Raghav@Example.IN ', role: 'brand' }), { ok: true, email: 'raghav@example.in', role: 'brand' });
  assert.deepEqual(normaliseSignup({ email: 'x@y.com', role: 'hacker' }), { ok: true, email: 'x@y.com', role: 'curious' });
  assert.equal(normaliseSignup({ email: 'nope' }).ok, false);
  assert.equal(normaliseSignup(null).ok, false);
  assert.deepEqual(normaliseSignup({ email: 'x@y.com', website: 'http://spam' }), { ok: true, bot: true });
});
