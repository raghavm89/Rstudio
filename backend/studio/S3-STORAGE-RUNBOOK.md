# Storage: dropping the tunnel for real S3

The render pipeline stores every still, reel, seed image and trained LoRA through
one storage layer (`src/services/studio/storage*.js`). Today it runs on the
`local` driver behind a tunnel (`STUDIO_PUBLIC_BASE`), which works but dies with
the laptop and the tunnel. This is how to move it to a real S3-compatible bucket.

The **code is already done** — the S3 driver, presigned SigV4 uploads, public
URLs and signed reads all exist. This is config plus one verification run. No
code ships to switch; you change `.env` and restart.

## Why it matters

Two outside services fetch our media **by URL, with no signature**: Instagram's
Content Publishing API (to post a reel/photo) and fal (to fetch the ~131 MB
trained LoRA and seed zips). If the bucket isn't publicly readable, a shoot
renders perfectly and then fails at the very last step — publish. That's why the
verifier below tests the *public* fetch explicitly.

## Pick a provider (India audience)

Recommended: **Cloudflare R2**. Zero egress fees (Instagram/fal fetches don't
bill), region `auto`, S3-compatible, one-line public access via an `r2.dev`
subdomain or a custom domain. For an India-facing account this is the cheapest
and simplest.

Alternatives, all S3-compatible and fine with this code:
- **AWS S3** — `ap-south-1` (Mumbai) or `ap-south-2` (Hyderabad). Charges egress.
- **DigitalOcean Spaces** — `blr1` (Bangalore) region, has a built-in CDN.
- **Backblaze B2** — cheap storage, pair with Cloudflare in front for free egress.

## Env block (`backend/.env`)

Replace the tunnel with the S3 block. Keep `STUDIO_STORAGE_SECRET` (still signs
local/preflight paths). Remove or comment `STUDIO_PUBLIC_BASE` — under the s3
driver it's ignored (S3_PUBLIC_BASE takes over).

```dotenv
STUDIO_STORAGE=s3

# --- Cloudflare R2 example ---
S3_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com
S3_REGION=auto
S3_BUCKET=zoq-media
S3_ACCESS_KEY_ID=<r2 access key id>
S3_SECRET_ACCESS_KEY=<r2 secret>
# The bucket's PUBLIC read host (r2.dev subdomain or your custom domain).
# Must NOT need a signature. No trailing slash.
S3_PUBLIC_BASE=https://pub-xxxxxxxx.r2.dev
S3_FORCE_PATH_STYLE=true
```

Per-provider deltas:
- **AWS S3**: `S3_ENDPOINT=https://s3.ap-south-1.amazonaws.com`, `S3_REGION=ap-south-1`,
  `S3_FORCE_PATH_STYLE=true` is safe. `S3_PUBLIC_BASE=https://<bucket>.s3.ap-south-1.amazonaws.com`.
- **DO Spaces**: `S3_ENDPOINT=https://blr1.digitaloceanspaces.com`, `S3_REGION=blr1`,
  `S3_PUBLIC_BASE=https://<bucket>.blr1.digitaloceanspaces.com` (or the CDN host).
- **Backblaze B2**: `S3_ENDPOINT=https://s3.<region>.backblazeb2.com`, region as shown
  in the B2 console.

## Make it publicly readable

Public read is a bucket setting, not something the code can do:
- **R2**: bucket → Settings → Public access → enable the `r2.dev` subdomain (or
  attach a custom domain). Use that host as `S3_PUBLIC_BASE`.
- **AWS S3**: turn off "Block all public access" for the bucket and add a bucket
  policy granting `s3:GetObject` on `arn:aws:s3:::<bucket>/*` to `*`. (Prefer a
  CloudFront domain in front for production.)
- **DO Spaces**: set the Space to public, or serve via its CDN endpoint.

Keys should be scoped to just this one bucket (R2 API token limited to it; AWS
IAM user with only `s3:PutObject`/`GetObject`/`DeleteObject` on that bucket).

## Verify before you trust it

```bash
cd backend
node studio/verify-storage.js
```

It uploads a tiny object through a presigned PUT (the exact path a worker uses),
then proves the public URL fetches with **no signature**, that a signed GET works,
and cleans up. Green means Instagram and fal can read your media. Then:

```bash
node studio/preflight.js      # confirms storage driver "s3" configured
```

Restart the API so the new env is loaded. New shoots write to S3 immediately;
media already on the laptop stays there — re-run or re-render if you need old
posts served from S3.

## Rollback

Set `STUDIO_STORAGE=local` and restore `STUDIO_PUBLIC_BASE` (the tunnel). The
factory fails loudly on a half-set S3 block, so you can't accidentally half-migrate.
