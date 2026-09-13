-- 052_ungendered_vocabulary.sql
--
-- A prompt fragment that decided the avatar's gender.
--
-- `lens / environmental_35` read:
--
--     "35mm f/2 lens, environmental framing, the room visible behind her"
--
-- Every fragment in `prompt_vocabulary` is concatenated verbatim into the
-- prompt for every frame that uses it. So an avatar described as a man, on the
-- 35mm lens, sent the word "her" to the model alongside his own identity block
-- — arguing with it in the one place the two could not both win.
--
-- This is not a copy problem. It is a generation problem wearing copy's
-- clothes: the look profile is CHOSEN ONCE AND LOCKED, so a customer who picked
-- 35mm early would have carried that word into every photograph the avatar ever
-- took, and the only visible symptom would be a face that drifts the wrong way
-- and no reason on the screen for it.
--
-- The fix is to say what the lens does and let the identity block say who is in
-- front of it. That is the division of labour the whole prompt assembly is
-- built on — identity first, verbatim, then the controls.

BEGIN;

UPDATE prompt_vocabulary
   SET fragment = '35mm f/2 lens, environmental framing, the room visible behind the subject'
 WHERE facet = 'lens'
   AND option_key = 'environmental_35'
   AND fragment LIKE '%behind her%';

COMMIT;
