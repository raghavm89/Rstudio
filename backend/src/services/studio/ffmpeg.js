"use strict";

const { execFile } = require("child_process");
const { promisify } = require("util");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const execFileP = promisify(execFile);

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

    await execFileP("ffmpeg", args, { maxBuffer: 1 << 26 });
    return await fs.readFile(out);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function assertFfmpeg() {
  try {
    await execFileP("ffmpeg", ["-version"], { maxBuffer: 1 << 20 });
  } catch {
    const e = new Error("ffmpeg is not installed on the server — the assemble stage needs it to stitch clips");
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

module.exports = { runFfmpeg };
