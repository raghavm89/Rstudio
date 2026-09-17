"use strict";

const { execFile } = require("child_process");
const { promisify } = require("util");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const execFileP = promisify(execFile);

// The ffmpeg binary. Defaults to the one on PATH; FFMPEG_PATH points at an
// explicit binary (e.g. Homebrew's, or an ffmpeg-static path) when it is not.
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";

/**
 * Stitch motion clips (and an optional voiceover) into one MP4 with ffmpeg.
 *
 * Isolated behind one function so the assemble stage can be tested with a fake
 * stitcher — the media work is the one part that cannot run without ffmpeg and
 * real bytes. Downloads each input to a temp dir, concatenates with the concat
 * demuxer (re-encoding, because clips may differ in codec/params), muxes audio
 * when present, and returns the output as a Buffer.
 *
 * @param {{clipUrls: string[], voiceUrl?: string|null, fetchImpl?: Function}} args
 * @returns {Promise<Buffer>} the assembled mp4
 */
async function runFfmpeg({ clipUrls, voiceUrl = null, fetchImpl = globalThis.fetch } = {}) {
  if (!Array.isArray(clipUrls) || !clipUrls.length) {
    const e = new Error("runFfmpeg: no clips to stitch"); e.permanent = true; throw e;
  }
  await assertFfmpeg();

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rstudio-assemble-"));
  try {
    const clipPaths = [];
    for (let i = 0; i < clipUrls.length; i += 1) {
      const p = path.join(dir, `clip-${i}.mp4`);
      await download(clipUrls[i], p, fetchImpl);
      clipPaths.push(p);
    }

    const listFile = path.join(dir, "list.txt");
    await fs.writeFile(listFile, clipPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"));

    const out = path.join(dir, "out.mp4");
    const args = ["-y", "-f", "concat", "-safe", "0", "-i", listFile];

    if (voiceUrl) {
      const audioPath = path.join(dir, "voice.audio");
      await download(voiceUrl, audioPath, fetchImpl);
      args.push("-i", audioPath,
        "-map", "0:v:0", "-map", "1:a:0",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", out);
    } else {
      args.push("-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", out);
    }

    await execFileP(FFMPEG, args, { maxBuffer: 1 << 26 });
    return await fs.readFile(out);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function assertFfmpeg() {
  try {
    await execFileP(FFMPEG, ["-version"], { maxBuffer: 1 << 20 });
  } catch {
    const e = new Error("ffmpeg is not installed on the server (the API host) — the assemble stage needs it to stitch clips. Install it (macOS: `brew install ffmpeg`) or set FFMPEG_PATH to a binary.");
    e.permanent = true;
    throw e;
  }
}

async function download(url, dest, fetchImpl) {
  const res = await fetchImpl(url);
  if (!res.ok) {
    const e = new Error(`assemble: could not fetch input (${res.status})`);
    e.permanent = res.status >= 400 && res.status < 500;
    throw e;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(dest, buf);
}

/**
 * Stitch per-shot SEGMENTS, each an optional voice muxed onto its own clip, into
 * one MP4 (multi-character dialogue, Phase 2a).
 *
 * Unlike runFfmpeg (one voiceover over the whole reel), here each shot carries
 * its OWN line in its OWN speaker's voice. Every segment is first normalised to
 * a uniform stream — video re-encoded, and an audio track that is either the
 * shot's voice or generated silence — so the concat demuxer joins clips with and
 * without dialogue without a stream-count mismatch. Then the normalised segments
 * are concatenated.
 *
 * @param {{segments: Array<{clipUrl:string, voiceUrl?:string|null}>, fetchImpl?:Function}} args
 * @returns {Promise<Buffer>} the assembled mp4
 */
async function stitchSegments({ segments, fetchImpl = globalThis.fetch } = {}) {
  const list = (segments || []).filter((s) => s && s.clipUrl);
  if (!list.length) { const e = new Error("stitchSegments: no segments to stitch"); e.permanent = true; throw e; }
  await assertFfmpeg();

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rstudio-assemble-seg-"));
  try {
    const segPaths = [];
    for (let i = 0; i < list.length; i += 1) {
      const seg = list[i];
      const clipPath = path.join(dir, `in-${i}.mp4`);
      await download(seg.clipUrl, clipPath, fetchImpl);

      const outSeg = path.join(dir, `seg-${i}.mp4`);
      let args;
      if (seg.voiceUrl) {
        const audioPath = path.join(dir, `voice-${i}.audio`);
        await download(seg.voiceUrl, audioPath, fetchImpl);
        args = ["-y", "-i", clipPath, "-i", audioPath,
          "-map", "0:v:0", "-map", "1:a:0",
          "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", outSeg];
      } else {
        // A lineless shot still needs a uniform audio track, or concat drops the
        // audio stream for every clip after it. Generate matched silence.
        args = ["-y", "-i", clipPath, "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
          "-map", "0:v:0", "-map", "1:a:0",
          "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", outSeg];
      }
      await execFileP(FFMPEG, args, { maxBuffer: 1 << 26 });
      segPaths.push(outSeg);
    }

    const listFile = path.join(dir, "list.txt");
    await fs.writeFile(listFile, segPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"));
    const out = path.join(dir, "out.mp4");
    await execFileP(FFMPEG, ["-y", "-f", "concat", "-safe", "0", "-i", listFile,
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", out], { maxBuffer: 1 << 26 });
    return await fs.readFile(out);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { runFfmpeg, stitchSegments };
