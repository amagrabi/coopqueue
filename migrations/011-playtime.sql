-- CoopQueue migration 011 — Steam playtime, and an estimate of group co-op hours.
--
--   npm run db:migrate -- --file=./migrations/011-playtime.sql
--
-- What Steam can and cannot tell us:
--   CAN  — lifetime minutes each person has played each game they own, one API
--          call per person for their entire library (IPlayerService/GetOwnedGames).
--   CANNOT — when they played, or with whom. There is no session or concurrency
--          data in the public API at all.
--
-- So "hours we played this together" is not measurable, only estimable, and the
-- estimate used is the MINIMUM across the people who actually played it. That is a
-- true upper bound — you cannot all have been playing together for longer than the
-- person who played least — and it satisfies the three cases that matter:
--   * only one person played it        -> fewer than 2 participants -> 0
--   * co-op plus somebody's solo hours -> the solo overflow is above the minimum,
--                                         so it cannot inflate the result
--   * three of four played             -> the fourth is not a participant, so
--                                         their zero cannot drag it down
--
-- `games.hours` keeps its meaning: a number a human typed, which always wins.
-- hours_estimated is only ever shown when hours IS NULL, and is labelled as an
-- estimate with the participant count, because presenting a bound as a measurement
-- would be a lie.

-- Global, not group-scoped: one person's playtime in a game is the same fact in
-- every group they belong to, exactly like steam_apps.
CREATE TABLE IF NOT EXISTS playtime (
  steam_id   TEXT    NOT NULL,
  appid      INTEGER NOT NULL,
  minutes    INTEGER NOT NULL,
  fetched_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (steam_id, appid)
);
CREATE INDEX IF NOT EXISTS idx_playtime_app ON playtime(appid);

-- Whether the last sync could read each member's library. Steam returns an empty
-- list for a private profile rather than an error, so "no games" and "hidden" look
-- identical unless the attempt is recorded.
CREATE TABLE IF NOT EXISTS playtime_sync (
  steam_id   TEXT PRIMARY KEY,
  games      INTEGER,          -- how many owned games came back; 0 means unreadable
  synced_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

ALTER TABLE games ADD COLUMN hours_estimated REAL;
ALTER TABLE games ADD COLUMN hours_participants INTEGER;
