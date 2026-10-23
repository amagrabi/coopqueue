-- Reschedule polls: somebody can't make a session, suggests replacement times, and
-- the group marks which work. Keep these definitions in schema.sql too. Additive
-- and idempotent; nothing existing is read or changed.

-- One poll per session at a time, keyed like everything else by the session's
-- original date. Confirming a result writes the same session_overrides row an
-- owner's direct move or cancel does, so the outcome looks identical either way.
CREATE TABLE IF NOT EXISTS session_polls (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id      INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  session_key   TEXT    NOT NULL,
  -- When the session was when the poll started. It may already have been moved,
  -- and a decided poll still has to say what it replaced.
  replaces_date TEXT    NOT NULL,
  replaces_time TEXT    NOT NULL CHECK (replaces_time GLOB '[0-2][0-9]:[0-5][0-9]'),
  created_by    TEXT REFERENCES users(steam_id) ON DELETE SET NULL,
  status        TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open','decided','withdrawn')),
  decided_option INTEGER,
  decided_by    TEXT REFERENCES users(steam_id) ON DELETE SET NULL,
  decided_at    INTEGER,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_session_polls_open
  ON session_polls(group_id, session_key) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_session_polls_group ON session_polls(group_id, session_key);

-- 'slot' is a replacement time; 'asplanned' is "keep the session, play without
-- whoever can't make it"; 'skip' is "no session this week".
CREATE TABLE IF NOT EXISTS poll_options (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  poll_id   INTEGER NOT NULL REFERENCES session_polls(id) ON DELETE CASCADE,
  kind      TEXT    NOT NULL CHECK (kind IN ('slot','asplanned','skip')),
  slot_date TEXT,
  slot_time TEXT CHECK (slot_time IS NULL OR slot_time GLOB '[0-2][0-9]:[0-5][0-9]'),
  added_by  TEXT REFERENCES users(steam_id) ON DELETE SET NULL,
  CHECK ((kind = 'slot') = (slot_date IS NOT NULL AND slot_time IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_poll_options_poll ON poll_options(poll_id);

-- group_id is denormalised so leaving a group cascades a member's votes, the same
-- shape comments use for the invariant-2 filter.
CREATE TABLE IF NOT EXISTS poll_votes (
  option_id  INTEGER NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
  group_id   INTEGER NOT NULL,
  steam_id   TEXT    NOT NULL,
  answer     TEXT    NOT NULL CHECK (answer IN ('yes','maybe','no')),
  set_by     TEXT REFERENCES users(steam_id) ON DELETE SET NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (option_id, steam_id),
  FOREIGN KEY (group_id, steam_id) REFERENCES memberships(group_id, steam_id) ON DELETE CASCADE
);
