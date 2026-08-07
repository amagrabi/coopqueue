-- Session-specific shortlisting and bounded Steam achievement progress.
-- Additive; apply once because SQLite has no `ADD COLUMN IF NOT EXISTS`.
-- `min_session_minutes` is deliberately human-entered:
-- lifetime playtime is not a session length, and Steam publishes no replacement.

ALTER TABLE games ADD COLUMN min_session_minutes INTEGER;

CREATE TABLE IF NOT EXISTS achievement_progress (
  steam_id   TEXT    NOT NULL,
  appid      INTEGER NOT NULL,
  achieved   INTEGER NOT NULL,
  total      INTEGER NOT NULL,
  unlocked   TEXT    NOT NULL,
  fetched_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (steam_id, appid)
);

CREATE INDEX IF NOT EXISTS idx_achievement_app ON achievement_progress(appid);

-- `playtime_sync` is account-global, but each run only stores games from the
-- group that launched it. A group-specific watermark is required before absence
-- can honestly mean "not owned" for that group's game.
CREATE TABLE IF NOT EXISTS group_library_sync (
  group_id  INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  steam_id  TEXT    NOT NULL,
  games     INTEGER,
  played    INTEGER,
  synced_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (group_id, steam_id)
);
