# Running Studio locally

From a clean checkout of `rstudio-backend` to a rendered, QC'd photo of your
avatar. Roughly 40 minutes, most of it waiting on a LoRA to train.

**One thing you need before you start: a fal API key.** https://fal.ai/dashboard/keys

You do **not** need ComfyUI, a Flux checkpoint, a rented GPU, or S3.

> **Steps 1–4 are already done on your Mac.** The drop is copied in, `app.js` and
> `authController.js` are patched (backups at `*.pre-studio.bak`), and
> `studio/.env.studio.example` is written. Skip to **step 3, migrations**, then
> fill in the env and run the preflight. Steps 1–2 are here for a second machine.

---

## Storage without S3

`STUDIO_STORAGE=local` is the default and needs no bucket. Files land under
`STUDIO_STORAGE_DIR` and are served back through two routes on the API:

- `PUT /api/studio/files/upload?key=…&sig=…` — authorised by an HMAC in its own
  query string, the same model as an S3 presigned PUT. The worker holds no
  credential, only a grant for one key, one content type, fifteen minutes.
- `GET /api/studio/files/*` — public read.

The worker, uploader and publisher are byte-identical between drivers; only the
host in the URL moves. Switching to a real bucket later is one env var.

**Two places local disk is not enough, and how each is handled:**

| | |
|---|---|
| **fal must fetch your seed-set zip and your still images** | Handled automatically. The server marks the payload `publicly_fetchable: false`, and the worker pushes those files through **fal's own storage** first. Training and image-to-video work from a laptop with no tunnel. |
| **Instagram fetches media from a URL to publish it** | Not handled, and cannot be. Publishing needs a real bucket or a tunnel (`cloudflared`, `ngrok`) with `STUDIO_PUBLIC_BASE` pointing at it. Publishing is gated on Meta's app review anyway, so this is not the thing blocking you today. |

The preflight prints a `warn` for the second one rather than a failure, because
everything upstream of publishing works fine on disk.

---

## 1. Copy the drop into place

Unpack `studio-drop4.tar.gz` so that `studio/` sits inside `rstudio-backend/`,
then:

```bash
cd ~/Rstudio/BackEnd/rstudio-backend

cp    studio/migrations/*.sql             src/db/migrations/
cp -r studio/backend/src/models/*         src/models/
cp    studio/backend/src/middleware/*     src/middleware/
cp -r studio/backend/src/services/*       src/services/
cp    studio/backend/src/controllers/*    src/controllers/
cp    studio/backend/src/routes/studio.js src/routes/
cp -r studio/backend/worker               worker/
cp -r studio/backend/tests/studio         tests/
```

**Do not copy `studio/backend/src/config/db.js`** — you already have a real one,
and the copy in the drop is only a test-harness stand-in.

## 2. Two edits to code you already run

**`src/app.js`** — mount the routes and start the in-process runner:

```js
const studioRoutes = require('./routes/studio');
app.use('/api/studio', studioRoutes);

const { ServerRunner } = require('./services/studio/serverRunner');
if (process.env.STUDIO_SERVER_RUNNER !== 'off') ServerRunner.start();
```

`ServerRunner` handles the `prompt` stage in the API process, because it needs
the database and nothing else — a render worker holds a shared secret that lives
on a laptop and must never be able to read tenant content.

**`src/controllers/authController.js`** — apply `PATCH-authController.md`. Two
lines in `issueTokens`. This is the only edit to existing code in the whole drop.

## 3. Migrations

```bash
npm run migrate        # or however 001–025 are normally applied
```

026–032 are idempotent and safe to re-run. Check:

```bash
psql -d rstudio -c "\d render_jobs" | grep cost_cents
# cost_cents | numeric(12,4)     ← if this says integer, 032 did not apply
```

## 4. Environment

`studio/.env.studio.example` is already written on your Mac. Append it to `.env`
and fill in three values:

```bash
cat studio/.env.studio.example >> .env

# then edit .env:
FAL_KEY=fal-...
STUDIO_STORAGE_SECRET=$(openssl rand -hex 32)
STUDIO_WORKER_TOKEN=$(openssl rand -hex 32)
```

That is the whole configuration. `STUDIO_STORAGE=local` and
`STUDIO_PUBLIC_BASE=http://127.0.0.1:3000` are already set.

`STUDIO_STORAGE_SECRET` is not optional — without it every upload URL is
forgeable, and on a host that also serves those files back that is a write
primitive rather than an inconvenience. The server refuses to mint any URL
without it.

Then check everything at once:

```bash
npm run studio:preflight
```

It verifies the wiring, all eight tables, that migration 032 actually applied,
that the vocabulary and presets are seeded, and that the storage directory is
writable — each of which otherwise surfaces several steps later and somewhere
unhelpful.

## 5. Start the two processes

```bash
# terminal 1 — the API
npm run dev

# terminal 2 — the render worker
STUDIO_API=http://127.0.0.1:3000 \
STUDIO_WORKER_TOKEN=<the same token as .env> \
WORKER_PROVIDER=fal \
WORKER_RUNNER=cloud \
WORKER_STAGES=still,motion,lora_train \
FAL_KEY=fal-... \
npm run studio:worker
```

Expect:

```
Studio worker worker-<host>
  api      http://127.0.0.1:3000
  provider fal
  runner   cloud
  stages   still, motion, lora_train
```

The worker polls **out**. No public IP, no tunnel, no port forwarding — and you
can close the laptop mid-render: the lease expires server-side and the job
returns to the queue.

## 6. Set the avatar up

This is the once-per-avatar path. Everything after it is just shooting.

### 6a. Create the avatar and freeze its look

Fill in `studio/personas/persona-bible.template.md` first — the identity block is
25–45 words, physical only, and it is **frozen**: it is concatenated verbatim into
every prompt this avatar ever generates, so changing it later changes her face.

```sql
INSERT INTO avatars (tenant_id, slug, name, mode, status, identity_block, avoid_block, lora_trigger)
VALUES (1, 'aanya-kapoor', 'Aanya Kapoor', 'synthetic', 'draft',
        '<your 25-45 word identity block>',
        'extra fingers, deformed hands, plastic skin', 'a4ny4prsn');

INSERT INTO look_profiles (avatar_id, base_look, lens, colour, grain, skin)
VALUES (<avatar id>, 'editorial', 'portrait_85', 'warm', 'fine', 'natural');
```

`mode` matters. `synthetic` is a person who does not exist. `twin` or `reference`
means a real person's likeness, and **generation is refused without a verified
consent record** — a ticked box is not a gate.

### 6b. Generate a candidate pool and cull it

Generate 200–400 frames from the identity block alone (no LoRA exists yet) and
keep 12–40. Do the culling yourself. No score is trustworthy enough for this: the
seed set's mean embedding becomes the reference **every future frame is judged
against, permanently**, so one off-model face quietly moves that reference toward
a person who does not exist.

This is the one step worth doing on local ComfyUI if you have it — hundreds of
throwaway frames at $0.035 each adds up, and nothing here is published.

Zip the survivors, get an upload URL, and PUT to it:

```bash
curl -X POST 127.0.0.1:3000/api/studio/avatars/<id>/seed-set \
  -H "Authorization: Bearer <token>" -H 'Content-Type: application/json' \
  -d '{"slug":"aanya-kapoor"}'

curl -X PUT "<the url it returned>" --data-binary @seed-set.zip
```

### 6c. Embed the seed set

```bash
cd worker
python3 -m venv .venv && . .venv/bin/activate
pip install insightface onnxruntime numpy pillow

# One long-lived process; model load is 3–8s and would otherwise sit
# inside every job's lease.
node -e "
const { FaceEmbedder } = require('./faceEmbed');
(async () => {
  const e = new FaceEmbedder();
  const fs = require('fs');
  const out = [];
  for (const f of fs.readdirSync('seed')) {
    const r = await e.embed(require('path').resolve('seed', f));
    if (r.faces === 1) out.push(r.embedding); else console.warn('skipped', f, r.faces, 'faces');
  }
  fs.writeFileSync('seed-embeddings.json', JSON.stringify(out));
  console.log(out.length, 'embedded');
  e.stop();
})();
"
```

### 6d. Train

```bash
curl -X POST 127.0.0.1:3000/api/studio/avatars/<id>/train \
  -H "Authorization: Bearer <token>" -H 'Content-Type: application/json' \
  -d '{"seed_set_url":"<public url of the zip>",
       "trigger_token":"a4ny4prsn",
       "seed_embeddings":'"$(cat worker/seed-embeddings.json)"'}'
```

Coherence is checked **before** the job is queued. If it refuses, it names which
images to drop by index — drop them and resubmit rather than lowering anything.

The trigger token must contain a digit. `aanya` would bind the face to everything
the base model already associates with that name; `a4ny4prsn` collides with
nothing.

Training runs on fal in ~10 minutes and costs $2–6. It returns a `.safetensors`
**you own** — which is the whole reason this is not a Pro finetune.

### 6e. Calibrate

```bash
curl 127.0.0.1:3000/api/studio/loras/<lora id>/calibration \
  -H "Authorization: Bearer <token>"
```

You get a work list and a price. Roughly 11 presets × 3 framings × 6 frames ≈ 200
images ≈ $14. Generate each cell, embed the frames, and post the samples:

```bash
curl -X POST 127.0.0.1:3000/api/studio/loras/<lora id>/calibration \
  -H "Authorization: Bearer <token>" -H 'Content-Type: application/json' \
  -d '{"preset_key":"laughing","framing":"medium",
       "samples":[{"faces":1,"embedding":[...]}, ...]}'
```

**Do not drop your worst frames before posting them.** The spread *is* the
measurement: a filtered sample looks tighter than reality, which produces a
smaller tolerance, which makes the gate reject normal output forever after. Only
structurally broken frames (no face, two faces) are excluded, and the service
does that itself.

Then:

```bash
curl -X POST 127.0.0.1:3000/api/studio/loras/<id>/activate -H "Authorization: Bearer <token>"
```

Activation is refused until every measurable preset has a baseline. That refusal
is the feature — a model calibrated on `neutral` alone passes a naive check and
then silently rejects every laughing frame it ever makes.

## 7. Shoot

```bash
curl -X POST 127.0.0.1:3000/api/studio/shoots \
  -H "Authorization: Bearer <token>" -H 'Content-Type: application/json' \
  -d '{"avatar_id":<id>, "kind":"post", "frame_count":4,
       "scene":{"location_key":"cafe","time_of_day":"afternoon",
                "continuity":{"location_text":"corner cafe in Bandra, large street-facing window",
                              "wardrobe_text":"cropped charcoal tee, wide-leg sand trousers"}},
       "shots":[{"framing":"medium","expression_key":"soft_smile"},
                {"framing":"close","expression_key":"laughing"},
                {"framing":"wide","expression_key":"neutral"},
                {"framing":"medium","expression_key":"confident"}]}'
```

Watch it:

```bash
curl 127.0.0.1:3000/api/studio/shoots/<project id> -H "Authorization: Bearer <token>"
```

Steps go `waiting → running → done`. Whole plan is declared up front, so you see
nine steps with seven still to come rather than one spinner, and a failure reads
as "stage 4 of 9, frame 3".

## 8. Moving off local disk, later

One env change:

```bash
STUDIO_STORAGE=s3
S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com
S3_BUCKET=rstudio
S3_ACCESS_KEY_ID=…
S3_SECRET_ACCESS_KEY=…
S3_PUBLIC_BASE=https://media.rstudio.app
```

No code changes. Existing objects stay on disk — the key is stored per asset, so
old and new coexist rather than needing a migration.

The driver is chosen by configuration, not by "is S3 configured", deliberately:
falling back to disk because a var was missing is how a month of posts end up on
a laptop Instagram cannot reach. A misspelled driver name fails at boot.

## 9. Local R&D on ComfyUI (optional)

Only if you want free unlimited iteration. `claude/comfyui-mac-install.md` has the
install.

```bash
WORKER_PROVIDER=local WORKER_RUNNER=mac WORKER_STAGES=still,qc \
COMFY_URL=http://127.0.0.1:8188 node worker/index.js
```

It prints a warning on startup, deliberately:

```
⚠️  Local provider: FLUX.1-dev weights are non-commercial. R&D only — do not publish this output.
```

To route a shoot to it, pass `"intent":"local"`. A shoot already bound to a
publishing slot refuses with `LICENCE_INTENT_CONFLICT` rather than quietly
rendering on the wrong weights.

---

## Running the tests

```bash
createdb rstudio_test
for f in src/db/migrations/*.sql; do psql -q -v ON_ERROR_STOP=1 -d rstudio_test -f "$f"; done
DATABASE_URL=postgresql://localhost/rstudio_test npm run studio:test
node --test studio/comfyui/buildWorkflow.test.js
```

167 tests. They run against a real Postgres, not a mock — the queue's guarantees
are Postgres guarantees (`FOR UPDATE SKIP LOCKED`, lease expiry, transaction
rollback), and a mock would assert that the mock works.

## When something goes wrong

| Symptom | Cause |
|---|---|
| Worker prints `Provider fal is not ready` | `FAL_KEY` unset |
| `503 STORAGE_UNCONFIGURED` on upload | `STUDIO_STORAGE_SECRET` not set |
| `403` on the upload URL | the grant expired (15 min) or the content type does not match the one it was signed for |
| `413` on train or calibrate | `STUDIO_JSON_LIMIT` — a 16-image seed set is ~160 KB and the global limit is 100 KB |
| `415` reading a stored file | extension not on the allowlist; unknown types are refused rather than served with a guessed content type |
| Stills queued, nothing claims them | worker on `WORKER_RUNNER=mac`; stills default to `cloud` |
| `409 NO_LORA` on a shoot | no **active** LoRA — calibrate, then activate |
| `409 NOT_CALIBRATED` on activate | check `GET /loras/:id/readiness` for what's missing |
| `409 SEED_SET_INCOHERENT` | the response names the image indices — drop those |
| `CONTENT_FILTERED` | fal's safety checker fired; change the wardrobe or pose picks |
| Stills done, motion never starts | worker not listening on `motion` — add it to `WORKER_STAGES` |
| Jobs stuck `claimed` after a crash | run `POST /api/studio/jobs/reap` on a timer |

---

## 10. Signing in to the Studio frontend

The culling screen (`/avatars/:id/face`) talks to the cull service on :5055, which
has no authentication. **Set her look** is the first screen that talks to the real
backend on :3000, which does — so it is the first screen that will ask you to sign
in, and the first that can fail for reasons that have nothing to do with the screen.

### One line you must add to the backend `.env`

```
AUDIENCE_ORIGINS=https://studio.rstudio.app=studio,https://admin.rstudio.app=admin,http://localhost:3100=studio,http://127.0.0.1:3100=studio
```

Without the two local entries every Studio call returns:

```
403 {"error":"This token belongs to another application (platform)","code":"TOKEN_AUDIENCE_MISMATCH"}
```

That is correct behaviour, not a bug. The backend derives a token's audience from
the Origin the login came from — a caller must not be able to nominate its own
audience, or the claim proves nothing — so a login through `localhost:3100` is a
`platform` login unless the map says otherwise. Note that the map is **literal**:
`localhost` and `127.0.0.1` are different origins, and the browser sends whichever
one is in the address bar. Map both.

`ENFORCE_TOKEN_AUDIENCE` being unset does not save you here. The grace period
forgives a *missing* audience, deliberately not a *mismatched* one — a real
cross-app token is the exact case the claim exists for.

### Which account

Studio has no user table of its own; it shares the backend's. Sign in with a
Rstudio account whose `tenant_id` owns the avatar. If you sign in as a user from a
different workspace the API returns **404, not 403** — it will not confirm that an
avatar it cannot show you exists. The screen says so, because otherwise a 404 here
reads as "this avatar was deleted".

### What each failure looks like

| What you see | What it means |
|---|---|
| Amber **"The backend is not answering"** | Nothing is listening on :3000. Not an auth problem. |
| **Sign in to Studio** panel | No token, or it expired past refresh. |
| "Invalid credentials" | Wrong password. |
| "Account not found" | That email is not in *this* database. |
| "This token belongs to another application" | The `AUDIENCE_ORIGINS` line above. |
| "Could not load this" + 404 | Signed in as the wrong workspace. |

Access tokens live fifteen minutes. The client silently spends the HttpOnly refresh
cookie once on a 401 and retries, so a long culling session should not sign you out.

---

## 11. Signing up and signing in

Studio shares accounts with rstudio.app — one `users` table, one password, one
email. What it does not share is the **workspace**. On rstudio.app a tenant is
created by an admin; on Studio you get one by signing up, because Studio is
self-serve and every table in it is scoped by `tenant_id`.

### Before this works, run two migrations

```
npm run db:migrate
```

**Not `psql` by hand.** This project has a runner — `src/db/migrate.js` — which
reads `src/db/migrations/` and records each file in `schema_migrations`. Earlier
drafts of this file told you to run psql directly, which was wrong twice over: it
bypasses the ledger, so the runner would try the file again later, and it hides
the actual failure mode, which is that **a migration in `studio/migrations/` is
invisible to the runner**. New studio migrations must be copied into
`src/db/migrations/` or they will never run, and the symptom is not a migration
error — it is a 500 from whichever endpoint uses the column.

`node studio/doctor-schema.js` reads `schema_migrations`, lists anything pending
with what it breaks, and warns about files that exist only in
`studio/migrations/`.

### And set these

```
AUDIENCE_ORIGINS=https://studio.rstudio.app=studio,https://admin.rstudio.app=admin,http://localhost:3100=studio,http://127.0.0.1:3100=studio
STUDIO_APP_URL=http://localhost:3100
APP_URL=https://rstudio.app
```

`STUDIO_APP_URL` is where an OAuth sign-in returns to. `APP_URL` **needs its
scheme** — it was `rstudio.app`, and without `https://` Express treats it as a
relative path and lands the browser on `<backend-host>/rstudio.app/auth/callback`.

### What happens on sign-up

1. `POST /api/auth/register` writes a `pending_registrations` row — **no account
   yet** — and records `signup_audience` from the request Origin.
2. A six-digit code goes out by email. 10-minute expiry, 60-second resend
   cooldown, 5 resends.
3. `POST /api/auth/verify-email` creates the user, and *because the pending row
   says `studio`*, creates a workspace and makes them its `tenant_admin` before
   the token is minted — so the token carries the new `tenant_id`.
4. Free tier needs no seeding: `studio_entitlements` rows with `plan_id IS NULL`
   **are** the free tier, globally.

A rstudio.app sign-up is unchanged — no workspace, exactly as before.

### An existing rstudio.app account arriving at Studio

They verified their email months ago, so nothing in the sign-up path will ever
run for them again. `GET /api/studio/me` provisions on first use instead, and
returns `token_stale: true` — the token in their hand was minted before the
workspace existed and still claims `tenant_id: null`. The frontend refreshes
before rendering. Ignoring that flag gives you an empty app with no error.

### OAuth

`/api/auth/google?app=studio` seals the app into signed `state`. Two things
changed from the platform flow:

- **`state` is now sent and verified.** It was absent, which is a login-CSRF
  hole: an attacker completes an authorization with *their* account and gets your
  browser to finish it, so everything you do afterwards is in a workspace they
  can read.
- **Studio returns a single-use handoff code, not a token.** The old flow put a
  live JWT in the redirect URL, which lands in history, in the Referer of the
  next request, and in every access log in front of the app — and could never set
  the refresh cookie in development, because during the redirect the browser is
  on the *backend's* origin. The Studio callback POSTs the code back same-origin;
  that response carries the token in a body and sets the cookie where it belongs.

rstudio.app's callback page is untouched and still gets its token in the URL.

### The gate

Every route except `/login`, `/signup` and `/auth/callback` requires a session.
The list lives in `components/AuthProvider.jsx` — a guard you opt into is one
someone forgets on the screen that mattered. An unauthenticated visit to
`/avatars/2/look` redirects to `/login?next=/avatars/2/look` and returns there
after signing in.

Access tokens live 8 hours here (`JWT_ACCESS_EXPIRES_IN=8h`). The client renews
silently from the refresh cookie on mount and once on any 401, so a long culling
session does not sign you out.

---

## 12. Aanya on fal, end to end — the commercially clean path

**Why this section exists.** The seed set generated locally comes out of FLUX.1-dev
weights, which are licensed for **non-commercial** use. Training a LoRA on those
images and then earning money from what it produces is, at best, an unsettled
reading of that licence — a model trained on non-commercial output, monetised, is
arguably commercial use of that output. If Aanya is ever going to carry a brand
deal, affiliate link or ad revenue, her face needs to come from fal, where the
commercial rights arrive through fal's agreement with BFL.

The local ComfyUI stack keeps its job. It is free, unlimited, and exactly right
for R&D: prompt sweeps, culling practice, calibration experiments, the multi-pass
inpaint work. It is just not where her actual face should come from.

**Everything below runs in your own Terminal.** Neither sandbox I work in can
reach fal.ai or your Postgres, so I cannot run any of it for you — I can only
write it, dry-run the parts that do not need the network, and read the results.

### 1. Seed set on fal

```
node studio/seed-set.js --avatar 2 --provider fal --count 150 --yes
```

150 candidates ≈ **$5.25** at $0.035 each (880×1104 is 0.97 MP — deliberately
under the megapixel cliff, since fal rounds *up* and 1.03 MP costs exactly
double for an image nobody can tell apart).

150, not 300: coverage across the grid is satisfiable well before that, the
top-up logic fills the thinnest cells first, and you only need 20 survivors. If
the cull leaves you short in one framing, re-run the same command — it tops up
rather than starting over.

Drop `--yes` first to see the estimate. Above $2 it refuses without it.

### 2. Cull

```
node studio/cull.js          # then open the Find her face screen
```

The rule has not changed and it is the one that matters: **keep the frames that
look like the same person, not the ones that look best.** The set's mean
embedding becomes the reference every future frame is judged against, for as long
as this persona exists. One striking frame that is subtly a different face
poisons that reference permanently.

### 3. The face embedder (once)

`train.js` will not get past its first step without insightface, because the
coherence check is what decides whether the seed set is usable:

```
bash studio/setup-embedder.sh
```

It builds a dedicated virtualenv at `studio/.venv-embed` rather than installing
into whatever `python3` happens to be — Homebrew's Python refuses `pip install`
outright under PEP 668, and on a Mac `python3` can be Xcode's, Homebrew's,
conda's or python.org's depending on PATH order. It picks an interpreter **by
version, not by name**, and it verifies by actually loading the model rather than
by importing the package: insightface downloads its weights (buffalo_l, ~280 MB)
on first *use*, so a setup that stops at "import ok" hands you the download
failure later, mid-training, looking like something else.

Then add the line it prints to `.env`:

```
FACE_EMBED_PYTHON=/Users/…/studio/.venv-embed/bin/python
```

Verified end to end on Linux/arm64 — install, download, model load. The macOS
paths are the part I could not test from here.

### 4. Train

```
node studio/train.js --avatar 2          # checks the set, stops before spending
node studio/train.js --avatar 2 --yes    # zips, embeds, submits, watches
```

**This used to say `POST /api/studio/avatars/2/train`, which was not something
you could run.** It is an HTTP endpoint, it needs a bearer token nothing told you
how to get, and its body needs two things that do not exist after culling:
`seed_set_url` (a fetchable zip) and `seed_embeddings` (one face embedding per
image, for the coherence check). The cull screen writes the kept images to
`personas/<slug>/seed/` and stops there. `train.js` is everything between that
folder and a queued job — zip, embed, check, submit, watch — and it talks to
Postgres and the services directly, the way `seed-set.js` does, so there is no
token to find.

A worker has to be running to pick the job up:

```
node worker/index.js
```

The dry run is worth doing on its own: it embeds every image and runs the
coherence check **before** anything is zipped or spent, and it names the exact
files to drop if the set is not confidently one person. That refusal is the one
worth failing — the mean of this set becomes the reference every frame she ever
makes is judged against, permanently.

**Measured: $2.00 and 7.2 minutes** for 15 images at 1000 steps
(`fal-ai/flux-lora-fast-training`, 9 Sep 2026). That is the real number from a
real run, not an estimate — earlier drafts of this file said I could not verify
it, and now it is verified. Steps drive the price, so `--steps 500` roughly
halves it if you are iterating on a seed set.

The trained LoRA lands **inactive**. Deliberately: an untested model should not
start serving shoots because a training job happened to finish.

### 5. Calibrate

```
node studio/calibrate.js                 # lists your trained LoRAs and their ids
node studio/calibrate.js --lora 3        # the plan: cells, frames, price
node studio/calibrate.js --lora 3 --framings medium
```

Also previously written as a bare `GET /api/studio/loras/:id/calibration`. Same
correction: it is an endpoint, this is the command.

`--framings` is the main cost lever. All three framings across every preset is
roughly two hundred frames; medium alone is a third of that, and the QC fallback
chain degrades sensibly — exact cell, then the same expression at any framing,
then a permissive floor — so an uncalibrated framing is not a rejected one. Start
at medium and add the others once she is earning.

**The recording half is not scripted yet.** Generating the frames needs a shoot
through the queue rather than a loop in a script, so `calibrate.js` reads the
plan and the readiness and stops. Until that exists the LoRA stays inactive and
the QC gate uses its permissive floor — which is safe, just not measured.

Two things hold whenever it does run: low-scoring frames are **not** dropped (the
spread *is* the measurement, and filtering it makes the gate reject normal output
forever), and `readiness` refuses to call a model ready on `neutral` alone.

### 6. The landing page

```
node studio/hero-assets.js --lora <path-from-the-trained-lora>          # plan
node studio/hero-assets.js --lora <path> --yes                          # ~$0.52
```

$0.04 still + $0.27 motion + $0.21 for six setups. It writes
`frontend/public/hero/` and a manifest; the page reads the manifest server-side
and switches the contact sheet from "one take, six frames" to "one persona, six
setups" on its own.

**Look at the six cells before shipping them.** If one is subtly a different
person, that is the LoRA telling you the seed set was thin in that framing — and
finding that out on a contact sheet costs nothing, whereas finding it out at post
40 costs the account.

Once calibration has run, fill `qc` in the manifest with a real measured score
and the slate shows `Looks like her · 0.94` instead of generation metadata. It
stays `null` until then on purpose: a number invented for a screenshot is the one
thing on that page worth nothing.

### What the whole chain costs

| Step | Cost |
|---|---|
| Seed set, 150 on fal | ~$5.25 |
| Training | **$2.00** — measured, 15 images at 1000 steps, 7.2 min |
| Calibration | whatever `calibrate.js --lora N` prints |
| Hero assets | ~$0.52 |

---

## 13. The port, and why a 403 was so confusing

**The API listens on `PORT=3000`, not 5000.** Every earlier note in this file said
5000 — that was my assumption from a test harness, never checked against this
`.env`, and it was wrong.

It mattered more than a typo normally would, because **macOS runs AirPlay
Receiver on port 5000** and it answers every request with an **empty 403**. So a
misdirected upload did not fail as "nothing is there" — it failed as "you are
forbidden", which points at the signature code, where you can look for a long
time before suspecting the port.

Now set correctly:

```
PORT=3000                                   # the API
STUDIO_PUBLIC_BASE=http://127.0.0.1:3000    # where signed upload URLs point
```

and `studio/frontend/.env.local`:

```
STUDIO_API=http://127.0.0.1:3000
CULL_API=http://127.0.0.1:5055
```

`studio/train.js` now probes the port before uploading and names AirPlay
explicitly if it finds it, rather than reporting a refusal it did not receive
from us. If you would rather have 5000 back, turn the receiver off in
System Settings ▸ General ▸ AirDrop & Handoff ▸ AirPlay Receiver.
