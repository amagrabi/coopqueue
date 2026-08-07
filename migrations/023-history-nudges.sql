-- Shared-history provenance and per-member nudge state.
-- Additive and safe to re-run: both tables use IF NOT EXISTS and the one-time
-- provenance backfill uses INSERT OR IGNORE.

CREATE TABLE IF NOT EXISTS game_fact_sources (
  group_id   INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  game_id    INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  field      TEXT    NOT NULL CHECK (field IN ('started','finished','hours')),
  source     TEXT    NOT NULL CHECK (source IN (
               'manual','release-date','steam-hours','steam-last-played','achievement'
             )),
  set_by     TEXT REFERENCES users(steam_id) ON DELETE SET NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (group_id, game_id, field)
);

CREATE TABLE IF NOT EXISTS history_nudges (
  group_id      INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  game_id       INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  field         TEXT    NOT NULL CHECK (field IN ('started','finished','hours')),
  steam_id      TEXT    NOT NULL,
  state         TEXT    NOT NULL CHECK (state IN ('dismissed','snoozed')),
  snoozed_until INTEGER,
  updated_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (group_id, game_id, field, steam_id),
  FOREIGN KEY (group_id, steam_id)
    REFERENCES memberships(group_id, steam_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_history_nudges_member
  ON history_nudges(group_id, steam_id, snoozed_until);

-- Migration 022 used these release dates as an owner-approved approximation for
-- the original g4m1ng import. Preserve that provenance so the UI shows ≈ rather
-- than presenting the dates as recalled history. Exact ids and values keep this
-- from labelling an independently edited row.
INSERT OR IGNORE INTO game_fact_sources (group_id, game_id, field, source)
SELECT g.group_id, g.id, 'started', 'release-date'
  FROM games g JOIN groups gr ON gr.id = g.group_id
 WHERE gr.slug = 'g4m1ng'
   AND (g.id, g.started) IN (
     (12,'2020-11-04'), (19,'2017-08-27'), (15,'2020-05-13'),
     (4,'2024-06-20'), (41,'2024-02-08'), (24,'2025-06-16'),
     (14,'2019-08-19'), (20,'2024-09-10'), (13,'2022-06-16'),
     (17,'2021-07-29'), (23,'2023-01-12'), (11,'2023-08-31'),
     (6,'2021-02-02'), (95,'2025-07-22'), (32,'2024-06-19'),
     (37,'2016-04-19'), (31,'2021-08-17')
   );
