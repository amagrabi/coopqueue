-- CoopQueue migration 017 — a "Failed to finish" status.
--
--   npm run db:backup                                   # FIRST. See the warning below.
--   npm run db:migrate -- --file=./migrations/017-status-unfinished.sql
--
-- "We tried to finish this and didn't" is a different fact from "dropped" (we gave up
-- on it) and from "sampled" (we poked at it). It is the honest label for a co-op
-- campaign a group got most of the way through and never reassembled for, which is a
-- common ending and previously had nowhere to go.
--
-- ── why this is a table rebuild, and why it looks paranoid ───────────────────
-- `games.status` carries a CHECK constraint and SQLite cannot ALTER one, so widening
-- it means rebuilding the table. The danger is `DROP TABLE games`: with foreign keys
-- enforced, SQLite runs an implicit DELETE FROM first, firing ON DELETE CASCADE on
-- `ratings`, `comments` and `skips`. Ratings are the one thing here that cannot be
-- recreated.
--
-- The obvious guard does NOT work. `PRAGMA defer_foreign_keys = on` defers the
-- constraint *violation check*, but cascade *actions* still fire. Replaying that
-- version over a full export of the live database destroyed all 242 ratings, both
-- comments and the one skip, while cheerfully reporting zero foreign key violations
-- afterwards — the rows were gone, so nothing was left to violate anything.
--
-- `PRAGMA foreign_keys = OFF` is the documented fix, but D1 enforces foreign keys as
-- a platform property and silently ignoring it would be indistinguishable from it
-- working, right up until the ratings were gone.
--
-- So this does not try to prevent the cascade. It stashes the three child tables
-- first and restores them after the rebuild, which is correct whether the cascade
-- fires or not. Verified by replaying the whole file over a real `d1 export`:
-- 115 games, 242 ratings, 2 comments, 1 skip, identical score checksum, no foreign
-- key violations.

CREATE TABLE _stash_ratings  AS SELECT * FROM ratings;
CREATE TABLE _stash_comments AS SELECT * FROM comments;
CREATE TABLE _stash_skips    AS SELECT * FROM skips;

CREATE TABLE games_rebuilt (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id          INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  steam_appid       INTEGER,
  genre             TEXT,
  status            TEXT NOT NULL DEFAULT 'backlog'
                      CHECK (status IN ('backlog','playing','finished','unfinished','dropped','sampled')),
  max_players       INTEGER,
  coop_note         TEXT,
  header_image      TEXT,
  trailer_url       TEXT,
  short_description TEXT,
  price             TEXT,
  release_date      TEXT,
  metacritic        INTEGER,
  hours             REAL,
  hours_estimated   REAL,
  hours_participants INTEGER,
  started           TEXT,
  finished          TEXT,
  notes             TEXT,
  added_by          TEXT REFERENCES users(steam_id) ON DELETE SET NULL,
  enriched_at       INTEGER,
  archived_at       INTEGER,
  created_at        INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (group_id, steam_appid)
);

INSERT INTO games_rebuilt
  (id, group_id, name, steam_appid, genre, status, max_players, coop_note, header_image,
   trailer_url, short_description, price, release_date, metacritic, hours, hours_estimated,
   hours_participants, started, finished, notes, added_by, enriched_at, archived_at, created_at)
SELECT
   id, group_id, name, steam_appid, genre, status, max_players, coop_note, header_image,
   trailer_url, short_description, price, release_date, metacritic, hours, hours_estimated,
   hours_participants, started, finished, notes, added_by, enriched_at, archived_at, created_at
FROM games;

DROP TABLE games;
ALTER TABLE games_rebuilt RENAME TO games;

CREATE INDEX idx_games_group  ON games(group_id, status);
CREATE INDEX idx_games_active ON games(group_id, archived_at);

-- Put the children back. INSERT OR IGNORE so this is still correct on a platform
-- where the cascade did not fire and the rows are already there.
INSERT OR IGNORE INTO ratings  (game_id, steam_id, score, comment, updated_at)
  SELECT game_id, steam_id, score, comment, updated_at FROM _stash_ratings;
INSERT OR IGNORE INTO comments (id, group_id, game_id, steam_id, body, created_at)
  SELECT id, group_id, game_id, steam_id, body, created_at FROM _stash_comments;
INSERT OR IGNORE INTO skips    (game_id, steam_id, not_played, created_at)
  SELECT game_id, steam_id, not_played, created_at FROM _stash_skips;

DROP TABLE _stash_ratings;
DROP TABLE _stash_comments;
DROP TABLE _stash_skips;
