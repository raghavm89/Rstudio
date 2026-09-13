-- 051_avatar_counted_once.sql
--
-- One avatar, counted once.
--
-- ── What went wrong ─────────────────────────────────────────────────────────
-- The `avatars` lifetime entitlement was reserved TWICE for the same avatar:
-- once when it was created, and once when its first LoRA was requested.
--
-- Training reserved it first, historically — back when an avatar was only
-- counted once it had a model. Creation then started reserving too, which is
-- the correct place: the cap is a statement about how many avatars you may
-- HAVE, and one exists from the moment it is created. The avatars list has
-- always said "1 of 1 on your plan" off the row count rather than off this
-- counter, which is why nobody noticed the counter saying something else.
--
-- The effect was not an edge case. On a one-avatar plan every customer hit it
-- at the worst possible moment: create the avatar, spend the slot, cull a seed
-- set, press Train, and be told "Not enough avatars remaining: asked for 1,
-- 0 left of 1" — about the avatar they already own, at the point of paying.
--
-- The application fix is in loraTraining.requestTraining. This repairs the
-- counters of workspaces that were already charged twice.
--
-- ── Why a reconcile and not a decrement ─────────────────────────────────────
-- Subtracting one per trained avatar assumes the exact history that produced
-- each row, and the histories differ: avatars made before creation reserved,
-- avatars made by `studio/load-persona.js` (which inserts directly and reserves
-- nothing), avatars deleted after being counted. The number this counter is
-- supposed to hold is not a running total anybody has to reconstruct — it is
-- COUNT(*) FROM avatars. So it is set to that.

BEGIN;

UPDATE studio_usage_counters c
   SET used = t.n,
       updated_at = NOW()
  FROM (
    SELECT tenant_id, COUNT(*)::numeric AS n
      FROM avatars
     GROUP BY tenant_id
  ) t
 WHERE c.tenant_id = t.tenant_id
   AND c.metric = 'avatars'
   AND c.period_start = DATE '1970-01-01'   -- how `lifetime` is spelled
   AND c.used <> t.n;

-- A workspace whose avatars were all deleted keeps a counter with nothing to
-- join to above, and it should read zero rather than whatever it last was.
UPDATE studio_usage_counters c
   SET used = 0,
       updated_at = NOW()
 WHERE c.metric = 'avatars'
   AND c.period_start = DATE '1970-01-01'
   AND c.used <> 0
   AND NOT EXISTS (SELECT 1 FROM avatars a WHERE a.tenant_id = c.tenant_id);

COMMIT;
