-- Regular play sessions: one standing rule per co-op group, per-session answers,
-- and away ranges. Keep these definitions in schema.sql too. Additive and
-- idempotent; nothing existing is read or changed.

-- The rule is stored as local wall-clock time plus an IANA zone, never as a UTC
-- instant: "Tuesdays 20:30" must stay 20:30 across a daylight-saving change.
-- anchor_date is the first session's local date and fixes the phase of an
-- every-other-week rule.
CREATE TABLE IF NOT EXISTS session_schedules (
  group_id     INTEGER PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,
  weekdays     TEXT    NOT NULL,   -- JSON array of ISO weekdays, 1 = Monday … 7 = Sunday
  start_time   TEXT    NOT NULL CHECK (start_time GLOB '[0-2][0-9]:[0-5][0-9]'),
  timezone     TEXT    NOT NULL,
  every_weeks  INTEGER NOT NULL DEFAULT 1 CHECK (every_weeks BETWEEN 1 AND 4),
  anchor_date  TEXT    NOT NULL CHECK (anchor_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  duration_min INTEGER NOT NULL DEFAULT 180 CHECK (duration_min BETWEEN 30 AND 720),
  updated_by   TEXT REFERENCES users(steam_id) ON DELETE SET NULL,
  updated_at   INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Attendance is opt-out: no row means the member is expected. A row is keyed by
-- the session's local date rather than an instant, so moving the start time does
-- not orphan answers already given. 'in' exists only to override an away range.
CREATE TABLE IF NOT EXISTS session_rsvps (
  group_id     INTEGER NOT NULL,
  steam_id     TEXT    NOT NULL,
  session_date TEXT    NOT NULL,
  answer       TEXT    NOT NULL CHECK (answer IN ('in','maybe','out')),
  set_by       TEXT REFERENCES users(steam_id) ON DELETE SET NULL,
  updated_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (group_id, steam_id, session_date),
  FOREIGN KEY (group_id, steam_id) REFERENCES memberships(group_id, steam_id) ON DELETE CASCADE
);

-- "Away from X to Y" covers every session in the range, including sessions a
-- later schedule change creates, which per-session rows could not.
CREATE TABLE IF NOT EXISTS member_away (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id   INTEGER NOT NULL,
  steam_id   TEXT    NOT NULL,
  from_date  TEXT    NOT NULL,
  to_date    TEXT    NOT NULL CHECK (to_date >= from_date),
  set_by     TEXT REFERENCES users(steam_id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (group_id, steam_id) REFERENCES memberships(group_id, steam_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_member_away_group ON member_away(group_id, to_date);
