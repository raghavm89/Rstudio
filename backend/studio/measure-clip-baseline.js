#!/usr/bin/env node
'use strict';

/**
 * CA5 — measure a character's CLIP similarity distribution, so the QC floor for
 * `subject_type='character'` can be a number somebody chose rather than the
 * ArcFace floor inherited by accident.
 *
 * faceQc's thresholds (UNCALIBRATED_FLOOR 0.60, IDENTITY_FLOOR 0.68) are ArcFace
 * numbers: same-PERSON faces land above ~0.6, different people below ~0.3. CLIP
 * whole-image cosines live in a DIFFERENT distribution — two frames of the same
 * mascot in different scenes routinely sit at 0.7-0.9, and two unrelated images
 * can still share 0.5 just for both being photographs. Reusing 0.60 would pass
 * almost anything. This tool measures where the real numbers fall so the floor
 * can be set between "same character" and "someone else".
 *
 *     node studio/measure-clip-baseline.js --dir ./frames/zoqmascot
 *     node studio/measure-clip-baseline.js --dir ./frames/zoqmascot --neg ./frames/other
 *
 * --dir   a folder of frames that ARE the character (its seed set / renders).
 * --neg   (optional) a folder of frames that are NOT — a different character, or
 *         off-model junk. The floor wants to sit ABOVE the highest negative and
 *         BELOW the lowest positive; if those overlap, the set is too varied or
 *         CLIP cannot separate them and the floor is a trade-off, printed as such.
 * --sigma how many σ below the positive mean to suggest as a floor (default 2).
 *
 * ── What it does NOT do ─────────────────────────────────────────────────────
 * It does not write the floor anywhere. Like calibrate.js it measures and
 * prints; a person reads the numbers and sets STUDIO_QC_IDENTITY_FLOOR (or, once
 * a character-specific env split exists, its CLIP equivalent). No DB, no queue,
 * no spend — just torch and a folder of images.
 *
 * Positive self-scores are LEAVE-ONE-OUT: each frame is compared to the mean of
 * the OTHER frames, never to a mean it helped build, or every score would be
 * flattered by its own contribution and the floor set too high.
 */

const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const { ClipEmbedder } = require(path.join(ROOT, 'worker/clipEmbed'));

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = args[i + 1];
  return next && !next.startsWith('--') ? next : true;
};

const IMAGE_RE = /\.(png|jpe?g|webp|bmp|gif)$/i;

function listImages(dir) {
  if (!dir) return [];
  const abs = path.resolve(dir);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    throw new Error(`not a directory: ${dir}`);
  }
  return fs.readdirSync(abs)
    .filter((f) => IMAGE_RE.test(f))
    .sort()
    .map((f) => path.join(abs, f));
}

/** Cosine between two equal-length vectors. Inlined to keep this DB-free. */
function cosine(a, b) {
  let dot = 0; let ma = 0; let mb = 0;
  for (let i = 0; i < a.length; i += 1) { dot += a[i] * b[i]; ma += a[i] * a[i]; mb += b[i] * b[i]; }
  if (!ma || !mb) return 0;
  return dot / (Math.sqrt(ma) * Math.sqrt(mb));
}

function mean(vectors) {
  const dim = vectors[0].length;
  const out = new Array(dim).fill(0);
  for (const v of vectors) for (let i = 0; i < dim; i += 1) out[i] += v[i];
  return out.map((x) => x / vectors.length);
}

function stats(xs) {
  const n = xs.length;
  const m = xs.reduce((s, x) => s + x, 0) / n;
  const variance = xs.reduce((s, x) => s + (x - m) ** 2, 0) / n;
  const sd = Math.sqrt(variance);
  const sorted = [...xs].sort((a, b) => a - b);
  return { n, mean: m, sd, min: sorted[0], max: sorted[n - 1],
           p10: sorted[Math.floor(0.10 * (n - 1))], p50: sorted[Math.floor(0.50 * (n - 1))] };
}

const f3 = (x) => (x == null ? 'n/a' : x.toFixed(3));

async function embedAll(embedder, files, label) {
  const vecs = [];
  for (let i = 0; i < files.length; i += 1) {
    process.stderr.write(`\r[${label}] embedding ${i + 1}/${files.length}   `);
    const out = await embedder.embed(files[i]);
    vecs.push(out.embedding);
  }
  process.stderr.write('\n');
  return vecs;
}

async function main() {
  const dir = flag('dir');
  if (!dir) {
    console.error('usage: node studio/measure-clip-baseline.js --dir <folder> [--neg <folder>] [--sigma 2]');
    process.exit(2);
  }
  const negDir = flag('neg');
  const sigma = Number(flag('sigma', 2)) || 2;

  const posFiles = listImages(dir);
  if (posFiles.length < 3) throw new Error(`need at least 3 frames in --dir, found ${posFiles.length}`);
  const negFiles = listImages(negDir);

  const embedder = new ClipEmbedder({});
  try {
    await embedder.start();

    const pos = await embedAll(embedder, posFiles, 'character');

    // Leave-one-out self-similarity: frame i vs the mean of all the others.
    const selfScores = pos.map((v, i) => {
      const others = pos.filter((_, j) => j !== i);
      return cosine(v, mean(others));
    });
    const ps = stats(selfScores);

    // The reference the product would actually store and compare against.
    const fullMean = mean(pos);

    console.log('\n=== CLIP character baseline ===');
    console.log(`frames:                 ${ps.n}  (${path.resolve(dir)})`);
    console.log(`self-similarity (LOO):  mean ${f3(ps.mean)}  sd ${f3(ps.sd)}`);
    console.log(`                        min ${f3(ps.min)}  p10 ${f3(ps.p10)}  median ${f3(ps.p50)}  max ${f3(ps.max)}`);

    let negS = null;
    if (negFiles.length) {
      const neg = await embedAll(embedder, negFiles, 'negatives');
      const negScores = neg.map((v) => cosine(v, fullMean));
      negS = stats(negScores);
      console.log('');
      console.log(`negatives:              ${negS.n}  (${path.resolve(negDir)})`);
      console.log(`neg-vs-character mean:  mean ${f3(negS.mean)}  sd ${f3(negS.sd)}`);
      console.log(`                        min ${f3(negS.min)}  median ${f3(negS.p50)}  max ${f3(negS.max)}`);
    }

    console.log('\n=== suggested floor ===');
    const sigmaFloor = ps.mean - sigma * ps.sd;
    console.log(`mean - ${sigma}σ:              ${f3(sigmaFloor)}`);
    console.log(`observed positive min:  ${f3(ps.min)}  (leave-one-out)`);

    if (negS) {
      const gap = ps.min - negS.max;
      if (gap > 0) {
        const mid = (ps.min + negS.max) / 2;
        console.log(`positive/negative gap:  ${f3(gap)}  → CLEAN separation`);
        console.log(`midpoint floor:         ${f3(mid)}  (admits every positive, rejects every negative)`);
        console.log(`\nRecommend STUDIO_QC (CLIP) floor ≈ ${f3(mid)}.`);
      } else {
        console.log(`positive/negative gap:  ${f3(gap)}  → OVERLAP (no floor separates them cleanly)`);
        console.log(`\nOverlap means CLIP cannot cleanly tell this character from the negatives on`);
        console.log(`whole-image cosine alone. A floor near ${f3(sigmaFloor)} keeps most positives; expect`);
        console.log(`some negatives through. Consider tighter/less varied seed frames or a per-scene`);
        console.log(`baseline (framing, like the person path) before trusting a single number.`);
      }
    } else {
      console.log(`\nNo --neg given, so this is only the positive side. Start the CLIP floor near`);
      console.log(`${f3(sigmaFloor)} (mean - ${sigma}σ) and re-run with a --neg folder to confirm it rejects`);
      console.log(`off-model frames. This is a starting point, not a calibrated threshold.`);
    }
    console.log('');
  } finally {
    embedder.stop();
  }
}

main().catch((err) => {
  console.error(`\n[measure-clip-baseline] ${err.message}`);
  process.exit(1);
});
