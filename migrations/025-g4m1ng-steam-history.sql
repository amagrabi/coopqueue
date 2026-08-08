-- Reconcile g4m1ng's imported history with Ama's public Steam evidence.
--
-- Steam Replay confirms the first-play year and month for the recent games;
-- public Community achievement unlocks supply the exact evidence date below.
-- An earliest achievement proves the game had been played by that day, not that
-- it was the group's first session, so every corrected start remains visibly
-- approximate through `source = achievement`.
--
-- The two new end dates are the account's synced rtime_last_played and therefore
-- remain approximate too. Shared hours are intentionally untouched: one person's
-- lifetime Steam time cannot measure how long the group played together.
--
-- Every write is guarded by the exact imported value so re-running this file is
-- harmless and cannot overwrite a later edit.

-- Monster Hunter was already underway before the imported 18 February date.
UPDATE games SET started = '2020-02-16'
WHERE id = 9 AND group_id = (SELECT id FROM groups WHERE slug = 'g4m1ng')
  AND steam_appid = 582010 AND started = '2020-02-18' AND archived_at IS NULL;

-- These release-date fallbacks are replaced by the account's earliest unlock.
UPDATE games SET started = '2025-01-08'
WHERE id = 11 AND group_id = (SELECT id FROM groups WHERE slug = 'g4m1ng')
  AND steam_appid = 1436700 AND started = '2023-08-31' AND archived_at IS NULL;

UPDATE games SET started = '2020-12-05'
WHERE id = 12 AND group_id = (SELECT id FROM groups WHERE slug = 'g4m1ng')
  AND steam_appid = 1172470 AND started = '2020-11-04' AND archived_at IS NULL;

UPDATE games SET started = '2025-03-19'
WHERE id = 20 AND group_id = (SELECT id FROM groups WHERE slug = 'g4m1ng')
  AND steam_appid = 526870 AND started = '2024-09-10' AND archived_at IS NULL;

UPDATE games SET started = '2025-11-06'
WHERE id = 24 AND group_id = (SELECT id FROM groups WHERE slug = 'g4m1ng')
  AND steam_appid = 3527290 AND started = '2025-06-16' AND archived_at IS NULL;

UPDATE games SET started = '2025-03-11'
WHERE id = 32 AND group_id = (SELECT id FROM groups WHERE slug = 'g4m1ng')
  AND steam_appid = 2567870 AND started = '2024-06-19' AND archived_at IS NULL;

UPDATE games SET started = '2025-10-12'
WHERE id = 41 AND group_id = (SELECT id FROM groups WHERE slug = 'g4m1ng')
  AND steam_appid = 553850 AND started = '2024-02-08' AND archived_at IS NULL;

-- The manually entered future date is contradicted by an earlier unlock.
UPDATE games SET started = '2026-07-07'
WHERE id = 95 AND group_id = (SELECT id FROM groups WHERE slug = 'g4m1ng')
  AND steam_appid = 427410 AND started = '2026-10-02' AND archived_at IS NULL;

-- Preserve the uncertainty of all achievement-derived starts. UPDATE handles
-- existing release/manual provenance; INSERT covers older imported rows.
UPDATE game_fact_sources
   SET source = 'achievement', set_by = '76561198049961191', updated_at = unixepoch()
 WHERE group_id = (SELECT id FROM groups WHERE slug = 'g4m1ng')
   AND field = 'started' AND game_id IN (9,11,12,20,24,32,41,95)
   AND source IN ('release-date','manual')
   AND EXISTS (
     SELECT 1 FROM games g
      WHERE g.group_id = game_fact_sources.group_id
        AND g.id = game_fact_sources.game_id
        AND (g.id, g.started) IN (
          (9,'2020-02-16'), (11,'2025-01-08'), (12,'2020-12-05'),
          (20,'2025-03-19'), (24,'2025-11-06'), (32,'2025-03-11'),
          (41,'2025-10-12'), (95,'2026-07-07')
        )
   );

INSERT OR IGNORE INTO game_fact_sources
  (group_id, game_id, field, source, set_by)
SELECT g.group_id, g.id, 'started', 'achievement', '76561198049961191'
  FROM games g JOIN groups gr ON gr.id = g.group_id
 WHERE gr.slug = 'g4m1ng'
   AND (g.id, g.started) IN (
     (9,'2020-02-16'), (11,'2025-01-08'), (12,'2020-12-05'),
     (20,'2025-03-19'), (24,'2025-11-06'), (32,'2025-03-11'),
     (41,'2025-10-12'), (95,'2026-07-07')
   );

-- Steam exposes a latest play for these otherwise incomplete history rows.
UPDATE games SET finished = '2024-12-04'
WHERE id = 18 AND group_id = (SELECT id FROM groups WHERE slug = 'g4m1ng')
  AND steam_appid = 2344520 AND finished IS NULL AND status = 'finished'
  AND archived_at IS NULL;

UPDATE games SET finished = '2025-10-07'
WHERE id = 32 AND group_id = (SELECT id FROM groups WHERE slug = 'g4m1ng')
  AND steam_appid = 2567870 AND finished IS NULL AND status = 'sampled'
  AND archived_at IS NULL;

INSERT OR IGNORE INTO game_fact_sources
  (group_id, game_id, field, source, set_by)
SELECT g.group_id, g.id, 'finished', 'steam-last-played', '76561198049961191'
  FROM games g JOIN groups gr ON gr.id = g.group_id
 WHERE gr.slug = 'g4m1ng'
   AND (g.id, g.finished) IN ((18,'2024-12-04'), (32,'2025-10-07'));

-- The Division 2 shipped on Steam after this group had already finished it, so
-- migration 022's Steam release date is provably not a start date. No stronger
-- account evidence exists for the Ubisoft copy; leave it for the group to recall.
DELETE FROM game_fact_sources
 WHERE group_id = (SELECT id FROM groups WHERE slug = 'g4m1ng')
   AND game_id = 23 AND field = 'started' AND source = 'release-date'
   AND EXISTS (
     SELECT 1 FROM games g
      WHERE g.group_id = game_fact_sources.group_id AND g.id = 23
        AND g.steam_appid = 2222570 AND g.started = '2023-01-12'
        AND g.finished = '2021-12-19' AND g.archived_at IS NULL
   );

UPDATE games SET started = NULL
WHERE id = 23 AND group_id = (SELECT id FROM groups WHERE slug = 'g4m1ng')
  AND steam_appid = 2222570 AND started = '2023-01-12'
  AND finished = '2021-12-19' AND archived_at IS NULL;

-- Filled facts invalidate any personal snooze/dismiss state for that field.
DELETE FROM history_nudges
 WHERE group_id = (SELECT id FROM groups WHERE slug = 'g4m1ng')
   AND ((field = 'started' AND game_id IN (9,11,12,20,24,32,41,95))
     OR (field = 'finished' AND game_id IN (18,32)));
