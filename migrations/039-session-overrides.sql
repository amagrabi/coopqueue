-- One-off changes to single sessions: moved to another day or time, or cancelled.
-- Keep this definition in schema.sql too. Additive and idempotent; the standing
-- rule and every existing answer are untouched.

-- Keyed by the date the rule gives the session, which stays its identity after a
-- move. Answers in session_rsvps use the same key, so a moved session keeps one
-- identity no matter how often it moves; away ranges apply to the date it is
-- actually played on.
CREATE TABLE IF NOT EXISTS session_overrides (
  group_id      INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  original_date TEXT    NOT NULL,
  new_date      TEXT,
  new_time      TEXT CHECK (new_time IS NULL OR new_time GLOB '[0-2][0-9]:[0-5][0-9]'),
  cancelled     INTEGER NOT NULL DEFAULT 0 CHECK (cancelled IN (0,1)),
  set_by        TEXT REFERENCES users(steam_id) ON DELETE SET NULL,
  updated_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (group_id, original_date),
  CHECK ((cancelled = 1 AND new_date IS NULL AND new_time IS NULL)
      OR (cancelled = 0 AND new_date IS NOT NULL AND new_time IS NOT NULL))
);
