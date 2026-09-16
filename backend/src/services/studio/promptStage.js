'use strict';

const pool = require('../../config/db');
const { isPubliclyFetchable, createStorage } = require('./storageFactory');
const { buildWorkflow, WorkflowError } = require('./comfyui/buildWorkflow');
const { deriveMotionPrompt } = require('./motionPrompt');

/**
 * The `prompt` stage — the last gap in the DAG.
 *
 * Every still job in a shoot depends on this one, and it does exactly one thing:
 * assemble the generation block each of them needs and write it onto their
 * payloads. Nothing is rendered here, nothing is charged, and no model is called.
 *
 * Why it is a stage rather than work done inline at `createShoot`:
 *
 *   • `createShoot` is one transaction that must stay fast — it is the click.
 *     Reading the vocabulary, look profile and every shot row inside it would put
 *     a dozen more queries on the path between the button and the response.
 *   • A prompt assembled at enqueue time would go stale. A shoot can sit in the
 *     queue while the operator edits a shot or the vocabulary is upgraded; the
 *     prompt should reflect the moment the render starts, not the moment it was
 *     requested.
 *   • It makes the assembly retryable and inspectable. When a face comes out
 *     wrong the first question is "what did we actually ask for", and the answer
 *     is a row in `render_jobs.result`, not a reconstruction.
 *
 * Runs on the `server` runner, in the API process, because it needs the database
 * and nothing else. A render worker never sees tenant content.
 */

const VOCABULARY_VERSION = 1;

/** Both templates are 4:5. QC checks the delivered aspect against this. */
const EXPECTED_ASPECT = 0.8;

class PromptStageError extends Error {
  constructor(message, { status = 400, code = null, permanent = true } = {}) {
    super(message);
    this.name = 'PromptStageError';
    this.status = status;
    this.code = code;
    this.permanent = permanent;
  }
}

/**
 * Seeds must differ across the frames of one post.
 *
 * A shared seed with only the pose text changed produces four near-identical
 * images, which reads as a broken carousel rather than a shoot. Derived from the
 * job and shot ids rather than random so a retry of the same job reproduces the
 * same frames — otherwise "regenerate frame 3" would silently change frames
 * 1, 2 and 4 too.
 */
function seedFor(jobId, shotId, candidateIndex) {
  const h = (jobId * 2654435761 + shotId * 40503 + candidateIndex * 2246822519) >>> 0;
  return h % 2 ** 31;
}

const PromptStage = {
  seedFor,
  PromptStageError,
  EXPECTED_ASPECT,

  /**
   * Execute one `prompt` job.
   *
   * Returns what goes on the job's `result` — the assembled prompts, kept so the
   * question "what did we ask the model for" is answerable from a row.
   */
  async execute(job) {
    if (job.stage !== 'prompt') {
      throw new PromptStageError(`Not a prompt job: stage is "${job.stage}"`, { code: 'WRONG_STAGE' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const avatarId = job.payload?.avatar_id;
      const { rows: avatarRows } = await client.query(
        `SELECT a.id, a.slug, a.identity_block, a.avoid_block, a.subject_type, a.mode,
                l.id AS lora_id, l.file_path, l.trigger_token, l.base_checkpoint,
                lp.base_look, lp.lens, lp.colour, lp.grain, lp.skin,
                lp.natural_asymmetry, lp.hair_detail, lp.vocabulary_version,
                sp.render_style, sp.palette, sp.line_weight, sp.shading, sp.background,
                sp.vocabulary_version AS style_vocabulary_version
           FROM avatars a
           LEFT JOIN avatar_loras   l  ON l.avatar_id = a.id AND l.active
           LEFT JOIN look_profiles  lp ON lp.avatar_id = a.id
           LEFT JOIN style_profiles sp ON sp.avatar_id = a.id
          WHERE a.id = $1 AND a.tenant_id = $2`,
        [avatarId, job.tenant_id]
      );
      const row = avatarRows[0];
      if (!row) throw new PromptStageError('Avatar not found', { status: 404, code: 'NO_AVATAR' });

      // createShoot already refused these, but a LoRA can be deactivated between
      // enqueue and execution. Failing here is correct and permanent: retrying
      // will not conjure a model.
      if (!row.lora_id) {
        throw new PromptStageError('This avatar has no active model', { status: 409, code: 'NO_LORA' });
      }
      const isCharacter = row.subject_type === 'character';
      if (isCharacter) {
        if (!row.render_style) {
          throw new PromptStageError('This avatar has no style profile', { status: 409, code: 'NO_STYLE_PROFILE' });
        }
      } else if (!row.base_look) {
        throw new PromptStageError('This avatar has no look profile', { status: 409, code: 'NO_LOOK_PROFILE' });
      }

      const vocabVersion =
        (isCharacter ? row.style_vocabulary_version : row.vocabulary_version) || VOCABULARY_VERSION;
      const { rows: vocabulary } = await client.query(
        `SELECT facet, option_key, fragment FROM prompt_vocabulary
          WHERE version = $1 AND active`,
        [vocabVersion]
      );
      if (!vocabulary.length) {
        throw new PromptStageError(
          `Prompt vocabulary version ${row.vocabulary_version} has no active rows`,
          { status: 500, code: 'NO_VOCABULARY' }
        );
      }

      // The preset table used to be read here, for `blend_with` and
      // `follow_on_pass` — which decided whether the expression was prompted at
      // all. It is not read any more, and that is the point of migration 053:
      // those two columns were suppressing six of eleven expressions in favour
      // of an edit pass that was never built, so the frames came out neutral
      // under an emotional label. The expression is a vocabulary fragment now,
      // like every other part of the prompt, and a preset the vocabulary cannot
      // express fails loudly below rather than rendering a calm face.
      //
      // One fewer query on the path between a claimed job and a submitted
      // render, as a side effect.

      // Every shot carries its OWN scene. A multi-location reel has several
      // scenes, each with its own location/wardrobe/time — so a shot's prompt
      // must use its scene's continuity, not one shared scene. Ordered by the
      // global shot seq so shot N lines up with still N (enqueue order).
      const { rows: shots } = await client.query(
        `SELECT sh.*, sc.location_key AS scene_location_key,
                sc.time_of_day AS scene_time_of_day, sc.continuity AS scene_continuity
           FROM studio_shots sh JOIN studio_scenes sc ON sc.id = sh.scene_id
          WHERE sc.project_id = $1
          ORDER BY sh.seq`,
        [job.project_id]
      );

      // The still jobs waiting on this one. Ordered by id so shot N lines up with
      // still N — they were enqueued in that order by the orchestrator.
      const { rows: stillJobs } = await client.query(
        `SELECT id, shot_id, payload FROM render_jobs
          WHERE project_id = $1 AND stage = 'still' AND $2 = ANY(depends_on)
          ORDER BY id`,
        [job.project_id, job.id]
      );

      const quality    = job.payload?.quality || '1mp';
      const candidates = Number(job.payload?.candidates || 1);
      const backend    = job.runner === 'mac' ? 'mps' : 'cuda';

      const assembled = [];
      for (const stillJob of stillJobs) {
        const shot = shots.find((s) => s.id === stillJob.shot_id) || shots[0];
        if (!shot) {
          throw new PromptStageError('No shot row for a queued still job', { status: 500, code: 'NO_SHOT' });
        }

        let built;
        try {
          built = buildWorkflow({
            avatar: { slug: row.slug, identity_block: row.identity_block, avoid_block: row.avoid_block, mode: row.mode },
            lora: {
              file_path: row.file_path,
              trigger_token: row.trigger_token,
              base_checkpoint: row.base_checkpoint,
            },
            ...(isCharacter
              ? { styleProfile: {
                    render_style: row.render_style, palette: row.palette,
                    line_weight: row.line_weight, shading: row.shading, background: row.background,
                  } }
              : { lookProfile: {
                    base_look: row.base_look, lens: row.lens, colour: row.colour,
                    grain: row.grain, skin: row.skin,
                    natural_asymmetry: row.natural_asymmetry, hair_detail: row.hair_detail,
                  } }),
            shot: {
              framing: shot.framing,
              light_direction: shot.light_direction,
              light_quality: shot.light_quality,
              expression_key: shot.expression_key,
              pose_key: shot.pose_key,
              advanced_append: shot.advanced_append,
            },
            scene: { location_key: shot.scene_location_key, time_of_day: shot.scene_time_of_day },
            vocabulary,
            locationText: (shot.scene_continuity && shot.scene_continuity.location_text) || '',
            wardrobeText: (shot.scene_continuity && shot.scene_continuity.wardrobe_text) || '',
            quality,
            backend,
            seed: seedFor(job.id, shot.id, 0),
            filenamePrefix: `studio/${row.slug}/${job.project_id}/shot${shot.seq}`,
          });
        } catch (err) {
          // A vocabulary gap is a configuration error, not a transient one — the
          // picker offered an option nobody seeded.
          if (err instanceof WorkflowError) {
            throw new PromptStageError(err.message, { status: 409, code: 'PROMPT_ASSEMBLY_FAILED' });
          }
          throw err;
        }

        /**
         * The generation block. Both providers read this and only this:
         * fal takes the prompt and dimensions, ComfyUI takes the graph. Shipping
         * both means a job can move between runners without being rebuilt — which
         * is what makes the licence policy a routing decision rather than a
         * regeneration.
         */
        const generation = {
          prompt: built.prompt,
          width: built.width,
          height: built.height,
          megapixels: built.megapixels,
          seed: built.seed,
          candidates,
          steps: 24,
          guidance: 3.5,
          expected_aspect: EXPECTED_ASPECT,
          publicly_fetchable: isPubliclyFetchable(),
          lora: { path: createStorage().readUrl(row.file_path), scale: 0.95, id: row.lora_id },
          expression_key: shot.expression_key,
          framing: shot.framing,
          filenamePrefix: `shot${shot.seq}`,
        };

        await client.query(
          `UPDATE render_jobs
              SET payload = payload || $2::jsonb, updated_at = NOW()
            WHERE id = $1`,
          [stillJob.id, JSON.stringify({ generation, workflow: built.workflow, megapixels: built.megapixels })]
        );

        // QC needs to know which baseline to judge against, and it must be the
        // one for the expression that was actually asked for. Passing it forward
        // here rather than re-deriving it in the QC stage keeps one source of
        // truth for what this frame was supposed to be.
        await client.query(
          `UPDATE render_jobs
              SET payload = payload || $2::jsonb, updated_at = NOW()
            WHERE project_id = $3 AND stage = 'qc' AND shot_id = $1`,
          [stillJob.shot_id,
           JSON.stringify({
             avatar_id: avatarId,
             lora_id: row.lora_id,
             preset_key: shot.expression_key,
             framing: shot.framing,
             expected_aspect: EXPECTED_ASPECT,
           }),
           job.project_id]
        );

        assembled.push({ shot_id: shot.id, seq: shot.seq, job_id: stillJob.id, prompt: built.prompt, seed: built.seed });
      }

      // Motion jobs (video kinds) get a MOTION prompt — a short, appearance-free
      // camera/subject-motion instruction — rather than falling back to the
      // still's look prompt, which makes an image-to-video model re-invent the
      // scene and drift the face. Ordered by id lines each motion job up with
      // its shot, the same convention the still jobs use above.
      const { rows: motionJobs } = await client.query(
        `SELECT id, payload FROM render_jobs
          WHERE project_id = $1 AND stage = 'motion'
          ORDER BY id`,
        [job.project_id]
      );
      for (let i = 0; i < motionJobs.length; i += 1) {
        const mshot = shots[i] || shots[shots.length - 1];
        if (!mshot) break;
        const mj = motionJobs[i];
        const generation = { ...(mj.payload?.generation || {}), motion_prompt: deriveMotionPrompt(mshot) };
        await client.query(
          `UPDATE render_jobs
              SET payload = jsonb_set(payload, '{generation}', $2::jsonb, true), updated_at = NOW()
            WHERE id = $1`,
          [mj.id, JSON.stringify(generation)]
        );
      }

      await client.query('COMMIT');
      return { assembled: assembled.length, shots: assembled, vocabulary_version: row.vocabulary_version };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },
};

module.exports = PromptStage;
