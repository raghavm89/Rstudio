-- 064 — mode 3: character image upload — the attestation record.
--
-- A character avatar (subject_type='character') can be built three ways
-- (decision-character-avatars-mode3.md): from a template, "like this template",
-- or by UPLOADING an image to build the character from. The upload path is the
-- only one that raises third-party rights risk (a user could upload someone
-- else's mascot / cartoon / artwork), so the IT-Rules 2026 answer is a gated,
-- LOGGED, indemnified path rather than a bare disclaimer.
--
-- This table is the log. It mirrors consent_records — the same audit artefact
-- the amendment expects an AI tool to produce on demand — but for a COPYRIGHT
-- attestation ("I own or have the rights to this image") rather than a
-- same-person CONSENT. A character depicts nobody, so there is no face match and
-- no `verified` step: the record is proof the user ASSERTED the right, at a
-- provable version of the wording, at a timestamp, from an IP. Liability lands
-- where it belongs.
--
-- The exact attestation + indemnity WORDING is placeholder pending an Indian
-- lawyer (T13); the columns store whichever version was shown, so a later
-- rewrite is a new version, not a lost record.

BEGIN;

CREATE TABLE IF NOT EXISTS character_attestations (
  id                        SERIAL PRIMARY KEY,
  tenant_id                 INTEGER     NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  avatar_id                 INTEGER     NOT NULL REFERENCES avatars(id) ON DELETE CASCADE,
  -- Who ticked the box. A tenant can have several users; the traceability
  -- requirement is per-person, not per-workspace.
  user_id                   INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  -- The storage key/URL of the uploaded reference the attestation covers.
  -- Recorded when the record is written (before the bytes are accepted); the
  -- bytes land at this key immediately after.
  upload_ref                TEXT,
  -- sha256 of the uploaded bytes, filled in at ingest once the file exists. Ties
  -- the record to the exact image, so "which upload did they attest to" is
  -- answerable even if the file is later replaced or removed.
  source_hash               TEXT,
  -- The version of the wording shown, and the wording itself, so the record is
  -- self-contained proof of what was agreed.
  attestation_text_version  INTEGER     NOT NULL DEFAULT 1,
  attested_text             TEXT        NOT NULL,
  -- Where from — the IT-Rules traceability fields.
  ip                        TEXT,
  user_agent                TEXT,
  -- Takedown flips this to FALSE (records are never deleted — the log must
  -- survive the content it describes). The generate/train gate requires an
  -- ACTIVE row, so deactivating it disables the derived avatar.
  active                    BOOLEAN     NOT NULL DEFAULT TRUE,
  taken_down_at             TIMESTAMPTZ,
  taken_down_by             INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  taken_down_reason         TEXT,
  created_at                TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_character_attestations_tenant ON character_attestations(tenant_id);
CREATE INDEX IF NOT EXISTS idx_character_attestations_avatar ON character_attestations(avatar_id);
CREATE INDEX IF NOT EXISTS idx_character_attestations_active ON character_attestations(avatar_id, active);

-- How the character was built. Only 'upload' needs an attestation; 'template'
-- and "like this template" (also 'template' here — they generate from Studio's
-- own art) do not. The generate/train gate reads this to decide whether to
-- require an active attestation, exactly as the consent gate reads `mode`.
ALTER TABLE avatars
  ADD COLUMN IF NOT EXISTS character_source TEXT NOT NULL DEFAULT 'template';

ALTER TABLE avatars DROP CONSTRAINT IF EXISTS avatars_character_source_allowed;
ALTER TABLE avatars
  ADD CONSTRAINT avatars_character_source_allowed CHECK (character_source IN ('template', 'upload'));

-- The current attestation for an upload-origin character. SET NULL on delete
-- keeps the avatar row if a record is ever hard-removed (it should not be), and
-- lets the gate see "no active attestation" cleanly.
ALTER TABLE avatars
  ADD COLUMN IF NOT EXISTS attestation_id INTEGER REFERENCES character_attestations(id) ON DELETE SET NULL;

COMMENT ON TABLE character_attestations IS
  'Mode-3 copyright attestations for character image uploads. Mirrors consent_records but for third-party-rights assertion, not same-person consent. Wording placeholder pending T13.';
COMMENT ON COLUMN avatars.character_source IS
  'template | upload. Only upload-origin characters require an active character_attestations row to generate or train.';

COMMIT;
