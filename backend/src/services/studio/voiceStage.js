"use strict";

const pool = require("./../../config/db");
const JobUpload = require("./jobUpload");

/**
 * The `voice` stage — record the voiceover for a video shoot.
 *
 * Runs on the server runner (it needs the database and tenant content). It reads
 * the spoken line from the brief and the avatar's LOCKED voice, synthesises the
 * audio, stores it, and returns it in the same `result.assets` shape the render
 * stages use — which is exactly what the assemble stage pulls to mux the
 * voiceover onto the reel.
 *
 * Two providers are wired:
 *   - "elevenlabs" — the hosted vendor (voice_id is the ElevenLabs voice id).
 *   - "indicf5"    — the OWNED, local, zero-shot clone. voice_id is a JSON blob
 *                    { ref_key, ref_text, lang }: the reference audio's storage
 *                    key, its transcript, and the language hint. Nothing leaves
 *                    the machine — this is a real person's biometric voice, so
 *                    it stays India-resident and owned (decision-voice-tts.md).
 *
 * The synth call, the DB client and the uploader are injectable so the handler
 * is testable without a network call, a subprocess, a database or object storage.
 */

const DEFAULT_MODEL = process.env.STUDIO_TTS_MODEL || "eleven_multilingual_v2";

class VoiceError extends Error {
  constructor(message, { permanent = false } = {}) {
    super(message);
    this.name = "VoiceError";
    this.permanent = permanent;
  }
}

/** The words the voiceover speaks. Pure. */
function pickScript(brief = {}) {
  const s = (brief && (brief.script || brief.voiceover || brief.hook || brief.concept)) || "";
  return String(s).trim() || null;
}

/** ElevenLabs TTS → mp3 Buffer. Injectable; guarded on the key. */
async function elevenLabsTts({
  text, voiceId,
  apiKey = process.env.ELEVENLABS_API_KEY,
  model = DEFAULT_MODEL,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!apiKey) throw new VoiceError("No ELEVENLABS_API_KEY configured for voiceover", { permanent: true });
  const res = await fetchImpl(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`,
    {
      method: "POST",
      headers: { "xi-api-key": apiKey, "Content-Type": "application/json", accept: "audio/mpeg" },
      body: JSON.stringify({
        text,
        model_id: model,
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    }
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const permanent = res.status >= 400 && res.status < 500 && res.status !== 429;
    throw new VoiceError(`ElevenLabs TTS ${res.status}: ${body.slice(0, 200)}`, { permanent });
  }
  return Buffer.from(await res.arrayBuffer());
}

/** Run a subprocess, resolving { out, err } or rejecting with a VoiceError. */
function runProc(cmd, args, { timeoutMs = 600000, permanentExit = [] } = {}) {
  const { spawn } = require("child_process");
  const path = require("path");
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      return reject(new VoiceError(`Could not start ${cmd}: ${e.message}`, { permanent: true }));
    }
    let out = "", err = "";
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } reject(new VoiceError(`${path.basename(cmd)} timed out`, { permanent: false })); }, timeoutMs);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => { clearTimeout(timer); reject(new VoiceError(`Could not start ${cmd}: ${e.message}`, { permanent: true })); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve({ out, err });
      // The Python engine exits 2 (bad args) / 3 (deps missing) for permanent faults.
      const permanent = permanentExit.includes(code);
      reject(new VoiceError(`${path.basename(cmd)} exit ${code}: ${(err || out).trim().slice(0, 300)}`, { permanent }));
    });
  });
}

/**
 * Resolve a stored reference-audio key to a local file path.
 *
 * Local storage already holds the bytes on disk, so we point straight at them.
 * Any other driver (S3) is fetched to a temp file. Returns { path, cleanup }.
 */
async function resolveRefAudio(refKey, { fetchImpl = globalThis.fetch } = {}) {
  const fs = require("fs"), os = require("os"), path = require("path");
  const { createStorage } = require("./storageFactory");
  const storage = createStorage();
  if (typeof storage.pathFor === "function") {
    const p = storage.pathFor(refKey);
    if (fs.existsSync(p)) return { path: p, cleanup: null };
  }
  const url = typeof storage.readUrl === "function" ? storage.readUrl(refKey) : null;
  if (!url) throw new VoiceError("Voice reference is not readable", { permanent: true });
  const res = await fetchImpl(url);
  if (!res.ok) throw new VoiceError(`Could not fetch the voice reference (${res.status})`, { permanent: false });
  const tmp = path.join(os.tmpdir(), `voiceref-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);
  fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
  return { path: tmp, cleanup: () => { try { fs.unlinkSync(tmp); } catch { /* leave it */ } } };
}

/**
 * IndicF5 zero-shot TTS → mp3 Buffer.
 *
 * voice_id carries the reference (its storage key + the transcript that was
 * spoken). We resolve the reference to a wav, hand it plus the target text to
 * the local Python engine, then transcode the engine's wav to mp3 so the asset
 * matches every other voiceover in `result.assets`.
 */
async function indicF5Tts({
  text, voiceId,
  python = process.env.INDICF5_PYTHON || "python3",
  scriptPath = require("path").resolve(__dirname, "../../../worker/indicf5_tts.py"),
  ffmpeg = process.env.FFMPEG_PATH || "ffmpeg",
  fetchImpl = globalThis.fetch,
} = {}) {
  const fs = require("fs"), os = require("os"), path = require("path");
  let cfg;
  try { cfg = JSON.parse(voiceId); } catch { throw new VoiceError("This twin has no cloned voice yet — clone the voice first", { permanent: true }); }
  if (!cfg || !cfg.ref_key || !cfg.ref_text) throw new VoiceError("The cloned voice reference is incomplete — re-clone the voice", { permanent: true });

  const ref = await resolveRefAudio(cfg.ref_key, { fetchImpl });
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const outWav = path.join(os.tmpdir(), `voice-${stamp}.wav`);
  const outMp3 = path.join(os.tmpdir(), `voice-${stamp}.mp3`);
  try {
    const args = [scriptPath, "--ref", ref.path, "--ref-text", cfg.ref_text, "--text", text, "--out", outWav];
    if (cfg.lang) args.push("--lang", String(cfg.lang));
    await runProc(python, args, {
      timeoutMs: Number(process.env.INDICF5_TIMEOUT_MS || 600000),
      permanentExit: [2, 3, 4], // bad args / deps missing / model load failed
    });
    if (!fs.existsSync(outWav) || !fs.statSync(outWav).size) throw new VoiceError("IndicF5 produced no audio", { permanent: false });
    await runProc(ffmpeg, ["-y", "-i", outWav, "-codec:a", "libmp3lame", "-q:a", "3", outMp3], { timeoutMs: 120000 });
    const buf = fs.readFileSync(outMp3);
    if (!buf.length) throw new VoiceError("Voice mp3 was empty after transcode", { permanent: false });
    return buf;
  } finally {
    if (ref.cleanup) ref.cleanup();
    try { fs.unlinkSync(outWav); } catch { /* may not exist */ }
    try { fs.unlinkSync(outMp3); } catch { /* may not exist */ }
  }
}

const VoiceStage = {
  VoiceError,
  pickScript,
  elevenLabsTts,
  indicF5Tts,
  resolveRefAudio,

  async execute(job, deps = {}) {
    if (job.stage !== "voice") throw new VoiceError(`Not a voice job: stage is "${job.stage}"`, { permanent: true });

    const ownClient = !deps.db;
    const client = deps.db || (await pool.connect());
    let ctx;
    try {
      const { rows } = await client.query(
        `SELECT p.brief, a.name, a.voice_provider, a.voice_id
           FROM studio_projects p
           JOIN avatars a ON a.id = p.avatar_id
          WHERE p.id = $1 AND p.tenant_id = $2`,
        [job.project_id, job.tenant_id]
      );
      ctx = rows[0];
    } finally {
      if (ownClient) client.release();
    }
    if (!ctx) throw new VoiceError("Project not found", { permanent: true });

    const script = pickScript(ctx.brief);
    if (!script) throw new VoiceError("No script for the voiceover — the brief has no script, hook or concept", { permanent: true });

    const provider = ctx.voice_provider || "elevenlabs";
    if (!ctx.voice_id) throw new VoiceError("This avatar has no locked voice — choose or clone one before a voiceover shoot", { permanent: true });

    let audio;
    if (provider === "elevenlabs") {
      const tts = deps.tts || elevenLabsTts;
      audio = await tts({ text: script, voiceId: ctx.voice_id });
    } else if (provider === "indicf5") {
      const synth = deps.indicf5 || indicF5Tts;
      audio = await synth({ text: script, voiceId: ctx.voice_id });
    } else {
      throw new VoiceError(`Voice provider "${provider}" is not wired yet`, { permanent: true });
    }
    if (!audio || !audio.length) throw new VoiceError("TTS produced no audio", { permanent: false });

    const store = deps.store || ((j, a, o) => JobUpload.store(j, a, o));
    const asset = await store(
      job,
      { filename: "voice.mp3", contentType: "audio/mpeg", fetch: async () => audio },
      { kind: "voice" }
    );

    return { assets: [asset], provider, voice_id: ctx.voice_id, chars: script.length };
  },
};

module.exports = VoiceStage;
