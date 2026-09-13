# Avatar Studio — first drop

Staged here rather than dropped straight into `src/`, so nothing runs until you
move it. Everything has been executed and tested against a real Postgres 16 with
your existing migrations 001–025 applied first.

## What's in the box

```
migrations/    026–030. Verified: apply clean on top of 001–025, and are
               idempotent on re-run. 23 tables, seed data loaded.
comfyui/       Flux + character-LoRA workflow, the deterministic prompt
               builder, and 13 passing tests.
personas/      The persona bible template, plus a fully worked example.
```

## Where it goes

```bash
# 1. Migrations — into the existing runner's directory
cp studio/migrations/*.sql src/db/migrations/

# 2. Prompt builder — it has no dependencies beyond node core
mkdir -p src/services/studio
cp studio/comfyui/buildWorkflow.js           src/services/studio/
cp studio/comfyui/flux-lora-portrait.api.json src/services/studio/

# 3. Tests — your runner is `node --test "tests/**/*.test.js"`
cp studio/comfyui/buildWorkflow.test.js tests/studio/

# 4. Apply
npm run db:migrate
npm test
```

`vocabulary.v1.json` is a **test fixture only** — production reads
`prompt_vocabulary` from the database. Regenerate it after changing the seed:

```bash
psql -qAtc "select json_agg(row_to_json(v)) from (select facet, option_key, fragment \
  from prompt_vocabulary where version=1 and active order by facet, sort_order) v;" \
  > tests/studio/vocabulary.v1.json
```

## The migrations

| File | Contents |
|---|---|
| `026_studio_personas.sql` | `consent_records`, `catalogue_faces`, `avatars`, `avatar_loras`, `look_profiles`, `expression_presets`, `expression_baselines`, `prompt_vocabulary` |
| `027_studio_content.sql` | `studio_projects` → `studio_scenes` → `studio_shots` → `studio_shot_characters`, plus `studio_assets` and `studio_posts` |
| `028_studio_jobs.sql` | `render_jobs`, `studio_entitlements`, `studio_usage_counters`, `studio_audit_log` |
| `029_studio_channels.sql` | `channel_accounts`, `publish_attempts`, `dm_rules`, `dm_events`, `studio_contacts` |
| `030_studio_seed.sql` | 41 vocabulary rows, 11 expression presets, 5 free-tier entitlements |

They follow the conventions in 001–025: `SERIAL` primary keys, `IF NOT EXISTS`
everywhere, `tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE`,
`TIMESTAMPTZ DEFAULT NOW()`, `JSONB NOT NULL DEFAULT '{}'::jsonb`, and
`DO $$ ... EXCEPTION WHEN duplicate_object THEN NULL; END $$` around anything
that cannot take an `IF NOT EXISTS`.

## Five decisions baked into the schema

**Tenant-scoped from row one.** Every table carries `tenant_id`. v1 runs as
tenant one. Opening it up later is a config change rather than rewriting every
query and migrating live data.

**project → scene → shot, even though v1 only makes one of each.** Long-form
multi-character is v2, but the schema for it is nearly free today and a resented
migration later. Google Flow caps a single generation at 8 seconds; long video is
assembled, never generated, which makes the shot the natural unit.

**`render_jobs` is one row per stage.** A failure resumes from the last good
stage instead of restarting the shoot, the Mac worker can go offline without
losing work, and — because every generation passes through it — it is the one
correct place to enforce free-tier limits. Not the UI, which can be worked
around.

**Cost is recorded, not estimated.** `seconds_generated`, `megapixels` and
`cost_cents` sit on every job and asset row. When the self-hosting question comes
back at scale, the answer is a query:
`break-even throughput = gpu_hourly_rate / api_per_second_rate`.

**`studio_audit_log` exists from day one.** India's IT Rules 2026 amendment
extends heightened expectations to the AI tools that *enable* creation, and asks
for audit systems and detailed logging. Every generation traceable to a tenant, a
consent record and a source. Cheap now, expensive to retrofit.

## The prompt builder

`buildWorkflow.js` contains no model calls, by design. The identity block is
concatenated verbatim, in a fixed position, on every generation — drift in the
face would be drift in this file, and this file does not drift.

Assembly order, which is load-bearing:

```
trigger → identity → wardrobe → location → pose → expression →
camera → light → grade → skin → asymmetry → hair → framing → quality
```

Three things worth knowing:

**There is no negative prompt.** Flux dev is guidance-distilled and effectively
ignores one, so `avoid_block` is not sent. It works by *absence* instead: no row
in `prompt_vocabulary` emits "flawless skin", "porcelain complexion" or "perfect
symmetry", so no combination of picker choices can produce them. Subtraction is
structural rather than a rule someone has to remember. A test asserts this and
will fail if anyone adds such a row.

**Expressions are not prompted.** A blended or multi-pass preset — `crying` is
sad-at-strong plus a tears pass, `weird` is contempt blended with confused —
generates a neutral still and is refined by a separate face-region edit, which is
what keeps identity intact. Prompting a strong expression fights the LoRA.

**The advanced field appends only.** Newlines and separators are stripped, length
is capped at 240 characters, and it lands after the quality tail. A power user
can add something; they cannot break their own face.

### A bug the tests caught, worth keeping caught

fal bills FLUX-with-LoRA **per megapixel, rounded up**. The free tier was drafted
at 896×1152 — which is 1.03 MP and therefore bills as **2**, costing exactly what
the paid tier costs and quietly removing the entire reason the free tier is
affordable. It is now 880×1104 (0.97 MP), and a test guards the actual pixel
count rather than the label.

## Not built yet

The Mac worker, the ComfyUI HTTP client, the face-QC embedding comparison, the
Studio UI, and every publishing integration. This drop is the foundation those
sit on: schema, identity assembly, and the workflow they will submit.

## Next, in the order I'd do it

1. **Calibrate the expression baselines.** For each preset, generate against the
   seed face and record where similarity lands in `expression_baselines`. Without
   this the QC gate uses one flat threshold, silently eats every emotional shot,
   and you conclude the model cannot do crying.
2. **The Mac worker** — poll `/api/studio/jobs/next`, POST to ComfyUI on
   `127.0.0.1:8188`, upload, report back. Under 200 lines; it is a queue
   consumer, not an application.
3. **The claim endpoint**, with `FOR UPDATE SKIP LOCKED` and a lease so a dead
   worker's job returns to the queue.
