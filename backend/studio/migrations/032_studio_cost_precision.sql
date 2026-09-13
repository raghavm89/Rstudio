-- 032_studio_cost_precision.sql
--
-- 🐛 `cost_cents` was INTEGER. A 1 MP still on fal costs 3.5 cents, so every
-- image rounded to 3 or 4 — a ~14% error, in the same direction, on the single
-- most-recorded number in the system.
--
-- That column exists so the self-hosting decision ("at what volume does renting
-- GPUs from E2E beat paying fal per megapixel?") is a query rather than a guess.
-- A consistent 14% bias would move the crossover point by tens of thousands of
-- images and point the answer the wrong way. Video is worse: 2.2 cents/second
-- rounds to 2, a 9% undercount, and stills and video would be biased by
-- different amounts and in different directions — so even their ratio would lie.
--
-- NUMERIC(12,4) holds a tenth of a millicent and widens losslessly from INTEGER,
-- so existing rows carry over untouched. Re-running is a no-op.

ALTER TABLE render_jobs
  ALTER COLUMN cost_cents TYPE NUMERIC(12,4);

ALTER TABLE studio_usage_counters
  ALTER COLUMN cost_cents TYPE NUMERIC(12,4);

COMMENT ON COLUMN render_jobs.cost_cents IS
  'Provider cost in cents, fractional. fal stills are 3.5c/MP and video 2.2c/s — integers would bias the self-hosting analysis this column exists to answer.';
