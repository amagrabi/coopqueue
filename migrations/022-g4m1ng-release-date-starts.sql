-- One-time, owner-approved approximation for the original g4m1ng import.
-- Each guard makes this safe to re-run and prevents a changed row from being
-- overwritten if an accurate date is entered before the migration is applied.

UPDATE games SET started = '2020-11-04'
WHERE id = 12 AND group_id = (SELECT id FROM groups WHERE slug = 'g4m1ng')
  AND name = 'Apex Legends' AND release_date = '4 Nov, 2020'
  AND status <> 'backlog' AND started IS NULL AND archived_at IS NULL;

UPDATE games SET started = '2017-08-27'
WHERE id = 19 AND group_id = (SELECT id FROM groups WHERE slug = 'g4m1ng')
  AND name = 'Ark: Survival Evolved' AND release_date = '27 Aug, 2017'
  AND status <> 'backlog' AND started IS NULL AND archived_at IS NULL;

UPDATE games SET started = '2020-05-13'
WHERE id = 15 AND group_id = (SELECT id FROM groups WHERE slug = 'g4m1ng')
  AND name = 'Deep Rock Galactic' AND release_date = '13 May, 2020'
  AND status <> 'backlog' AND started IS NULL AND archived_at IS NULL;

UPDATE games SET started = '2024-06-20'
WHERE id = 4 AND group_id = (SELECT id FROM groups WHERE slug = 'g4m1ng')
  AND name = 'Elden Ring: Shadow of the Erdtree' AND release_date = '20 Jun, 2024'
  AND status <> 'backlog' AND started IS NULL AND archived_at IS NULL;

UPDATE games SET started = '2024-02-08'
WHERE id = 41 AND group_id = (SELECT id FROM groups WHERE slug = 'g4m1ng')
  AND name = 'Helldivers 2' AND release_date = '8 Feb, 2024'
  AND status <> 'backlog' AND started IS NULL AND archived_at IS NULL;

UPDATE games SET started = '2025-06-16'
WHERE id = 24 AND group_id = (SELECT id FROM groups WHERE slug = 'g4m1ng')
  AND name = 'Peak' AND release_date = '16 Jun, 2025'
  AND status <> 'backlog' AND started IS NULL AND archived_at IS NULL;

UPDATE games SET started = '2019-08-19'
WHERE id = 14 AND group_id = (SELECT id FROM groups WHERE slug = 'g4m1ng')
  AND name = 'Remnant: From the Ashes' AND release_date = '19 Aug, 2019'
  AND status <> 'backlog' AND started IS NULL AND archived_at IS NULL;

UPDATE games SET started = '2024-09-10'
WHERE id = 20 AND group_id = (SELECT id FROM groups WHERE slug = 'g4m1ng')
  AND name = 'Satisfactory' AND release_date = '10 Sep, 2024'
  AND status <> 'backlog' AND started IS NULL AND archived_at IS NULL;

UPDATE games SET started = '2022-06-16'
WHERE id = 13 AND group_id = (SELECT id FROM groups WHERE slug = 'g4m1ng')
  AND name = 'Teenage Mutant Ninja Turtles: Shredder''s Revenge' AND release_date = '16 Jun, 2022'
  AND status <> 'backlog' AND started IS NULL AND archived_at IS NULL;

UPDATE games SET started = '2021-07-29'
WHERE id = 17 AND group_id = (SELECT id FROM groups WHERE slug = 'g4m1ng')
  AND name = 'The Ascent' AND release_date = '29 Jul, 2021'
  AND status <> 'backlog' AND started IS NULL AND archived_at IS NULL;

UPDATE games SET started = '2023-01-12'
WHERE id = 23 AND group_id = (SELECT id FROM groups WHERE slug = 'g4m1ng')
  AND name = 'The Division 2' AND release_date = '12 Jan, 2023'
  AND status <> 'backlog' AND started IS NULL AND archived_at IS NULL;

UPDATE games SET started = '2023-08-31'
WHERE id = 11 AND group_id = (SELECT id FROM groups WHERE slug = 'g4m1ng')
  AND name = 'Trine 5: A Clockwork Conspiracy' AND release_date = '31 Aug, 2023'
  AND status <> 'backlog' AND started IS NULL AND archived_at IS NULL;

UPDATE games SET started = '2021-02-02'
WHERE id = 6 AND group_id = (SELECT id FROM groups WHERE slug = 'g4m1ng')
  AND name = 'Valheim' AND release_date = '2 Feb, 2021'
  AND status <> 'backlog' AND started IS NULL AND archived_at IS NULL;

UPDATE games SET started = '2025-07-22'
WHERE id = 95 AND group_id = (SELECT id FROM groups WHERE slug = 'g4m1ng')
  AND name = 'Abiotic Factor' AND release_date = '22 Jul, 2025'
  AND status <> 'backlog' AND started IS NULL AND archived_at IS NULL;

UPDATE games SET started = '2024-06-19'
WHERE id = 32 AND group_id = (SELECT id FROM groups WHERE slug = 'g4m1ng')
  AND name = 'Chained Together' AND release_date = '19 Jun, 2024'
  AND status <> 'backlog' AND started IS NULL AND archived_at IS NULL;

UPDATE games SET started = '2016-04-19'
WHERE id = 37 AND group_id = (SELECT id FROM groups WHERE slug = 'g4m1ng')
  AND name = 'SpeedRunners' AND release_date = '19 Apr, 2016'
  AND status <> 'backlog' AND started IS NULL AND archived_at IS NULL;

UPDATE games SET started = '2021-08-17'
WHERE id = 31 AND group_id = (SELECT id FROM groups WHERE slug = 'g4m1ng')
  AND name = 'Tetris® Effect: Connected' AND release_date = '17 Aug, 2021'
  AND status <> 'backlog' AND started IS NULL AND archived_at IS NULL;
