"use strict";

const pool = require("../../config/db");

/**
 * The `copy` stage — write the caption in the persona's own voice.
 *
 * Runs on the server runner. It PULLS the shoot's context (the persona bible's
 * voice section, the project brief) and asks an LLM for a caption plus a few
 * hashtags, in that persona's register — not a generic "AI influencer" tone.
 * The persona's AI-disclosure line is returned alongside so the publish step
 * can attach it (IT-Rules labelling is not optional).
 *
 * The LLM client is injectable so the assembly is testable without a network
 * call; parseCaption is pure and tested directly.
 */

const DEFAULT_MODEL = process.env.STUDIO_COPY_MODEL || "claude-3-5-haiku-latest";
const MAX_TOKENS = 400;

class CopyError extends Error {
  constructor(message, { permanent = false } = {}) {
    super(message);
    this.name = "CopyError";
    this.permanent = permanent;
  }
}

/** Lazily construct the Anthropic client, or null when no key is configured. */
function getAnthropic() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const Anthropic = require("@anthropic-ai/sdk");
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

/** Build the system prompt from the persona's voice. Pure. */
function buildSystem(ctx, voice) {
  const lines = [
    `You write short social captions AS the creator "${ctx.name}", in her own voice.`,
    ctx.identity_block ? `She is: ${ctx.identity_block.replace(/\s+/g, " ").trim()}.` : null,
    voice.register ? `Voice register: ${voice.register}.` : null,
    Array.isArray(voice.words) && voice.words.length ? `Words she uses: ${voice.words.join(", ")}.` : null,
    Array.isArray(voice.never) && voice.never.length ? `She never posts about: ${voice.never.join(", ")}.` : null,
    "Keep it to 1-3 short sentences. At most one emoji, often none. Sound like a real person, not an ad.",
    "Then a new line, then 3-6 lowercase hashtags relevant to the post.",
    "Output only the caption and the hashtags — no preamble, no quotes.",
  ].filter(Boolean);
  return lines.join("\n");
}

/** Build the user turn from the project brief. Pure. */
function buildUser(ctx) {
  const brief = ctx.brief || {};
  const parts = [
    ctx.kind ? `Post type: ${ctx.kind}.` : null,
    ctx.slot_type ? `Theme: ${ctx.slot_type}.` : null,
    brief.concept ? `Concept: ${brief.concept}.` : null,
    brief.hook ? `Hook: ${brief.hook}.` : null,
    brief.caption_angle ? `Caption angle: ${brief.caption_angle}.` : null,
    ctx.title ? `Working title: ${ctx.title}.` : null,
  ].filter(Boolean);
  return parts.length ? parts.join("\n") : "Write a caption that fits her usual content.";
}

/** Split the model's text into a caption and hashtags. Pure. */
function parseCaption(text) {
  const raw = String(text || "").trim();
  const tags = [];
  const re = /#[\p{L}0-9_]+/gu;
  let m;
  while ((m = re.exec(raw)) !== null) tags.push(m[0].toLowerCase());
  // The caption is everything with the trailing hashtag block removed.
  const caption = raw.replace(/(\n|\s)*(#[\p{L}0-9_]+(\s+|$))+\s*$/u, "").trim();
  return { caption: caption || raw, hashtags: Array.from(new Set(tags)) };
}

async function callLLM(llm, { system, user, model }) {
  const resp = await llm.messages.create({
    model,
    max_tokens: MAX_TOKENS,
    system,
    messages: [{ role: "user", content: user }],
  });
  const block = (resp.content || []).find((b) => b.type === "text") || resp.content?.[0];
  return block?.text || "";
}

const CopyStage = {
  CopyError,
  buildSystem,
  buildUser,
  parseCaption,

  async execute(job, deps = {}) {
    if (job.stage !== "copy") {
      throw new CopyError(`Not a copy job: stage is "${job.stage}"`, { permanent: true });
    }

    const client = await pool.connect();
    let ctx;
    try {
      const { rows } = await client.query(
        `SELECT p.kind, p.title, p.slot_type, p.brief,
                a.name, a.identity_block, a.disclosure_line, a.bible
           FROM studio_projects p
           JOIN avatars a ON a.id = p.avatar_id
          WHERE p.id = $1 AND p.tenant_id = $2`,
        [job.project_id, job.tenant_id]
      );
      ctx = rows[0];
    } finally {
      client.release();
    }
    if (!ctx) throw new CopyError("Project not found", { permanent: true });

    const llm = deps.llm || getAnthropic();
    if (!llm) throw new CopyError("No LLM configured — set ANTHROPIC_API_KEY to write captions", { permanent: true });

    const model = deps.model || DEFAULT_MODEL;
    const voice = (ctx.bible && ctx.bible.voice) || {};
    const text = await callLLM(llm, { system: buildSystem(ctx, voice), user: buildUser(ctx), model });
    const { caption, hashtags } = parseCaption(text);

    return { caption, hashtags, disclosure: ctx.disclosure_line || "AI-generated virtual creator", model };
  },
};

module.exports = CopyStage;
