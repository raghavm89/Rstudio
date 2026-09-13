"use strict";

const pool = require("./../../config/db");
const JobUpload = require("./jobUpload");

/**
 * The `voice` stage — record the voiceover for a video shoot.
 *
 * Runs on the server runner (it needs the database and tenant content). It reads
 * the spoken line from the brief and the avatar's LOCKED voice, calls TTS
 * (ElevenLabs), stores the audio, and returns it in the same `result.assets`
 * shape the render stages use — which is exactly what the assemble stage pulls
 * to mux the voiceover onto the reel.
 *
 * The TTS call, the DB client and the uploader are injectable so the handler is
 * testable without a network call, a database or object storage.
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
    // 4xx (except rate limit) is a bad request that will not improve on retry.
    const permanent = res.status >= 400 && res.status < 500 && res.status !== 429;
    throw new VoiceError(`ElevenLabs TTS ${res.status}: ${body.slice(0, 200)}`, { permanent });
  }
  return Buffer.from(await res.arrayBuffer());
}

const VoiceStage = {
  VoiceError,
  pickScript,
  elevenLabsTts,

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
    if (provider !== "elevenlabs") throw new VoiceError(`Voice provider "${provider}" is not wired yet`, { permanent: true });
    if (!ctx.voice_id) throw new VoiceError("This avatar has no locked voice — choose one before a voiceover shoot", { permanent: true });

    const tts = deps.tts || elevenLabsTts;
    const store = deps.store || ((j, a, o) => JobUpload.store(j, a, o));

    const audio = await tts({ text: script, voiceId: ctx.voice_id });
    if (!audio || !audio.length) throw new VoiceError("TTS produced no audio", { permanent: false });

    const asset = await store(
      job,
      { filename: "voice.mp3", contentType: "audio/mpeg", fetch: async () => audio },
      { kind: "voice" }
    );

    return { assets: [asset], provider, voice_id: ctx.voice_id, chars: script.length };
  },
};

module.exports = VoiceStage;
