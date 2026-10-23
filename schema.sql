-- CoopQueue — Cloudflare D1 schema (multi-tenant)
-- Fresh installs and tests only. Never apply this file to an existing remote
-- database: the statements immediately below deliberately destroy every table.
--
-- Tenancy model: everything a group owns hangs off groups.id. A person is one
-- row in users (keyed by their SteamID64) and can belong to any number of
-- groups; their display name and role are per-group, held on memberships.

DROP TABLE IF EXISTS session_overrides;
DROP TABLE IF EXISTS member_away;
DROP TABLE IF EXISTS session_rsvps;
DROP TABLE IF EXISTS session_schedules;
DROP TABLE IF EXISTS activity_item_reads;
DROP TABLE IF EXISTS activity_reads;
DROP TABLE IF EXISTS group_activity;
DROP TABLE IF EXISTS comments;
DROP TABLE IF EXISTS coop_dismissals;
DROP TABLE IF EXISTS history_nudges;
DROP TABLE IF EXISTS game_fact_sources;
DROP TABLE IF EXISTS achievement_progress;
DROP TABLE IF EXISTS playtime;
DROP TABLE IF EXISTS group_library_sync;
DROP TABLE IF EXISTS playtime_sync;
DROP TABLE IF EXISTS seed_assignments;
DROP TABLE IF EXISTS skips;
DROP TABLE IF EXISTS ratings;
DROP TABLE IF EXISTS games;
DROP TABLE IF EXISTS member_preferences;
DROP TABLE IF EXISTS memberships;
DROP TABLE IF EXISTS group_invites;
DROP TABLE IF EXISTS workspace_settings;
DROP TABLE IF EXISTS groups;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS steam_apps;
DROP TABLE IF EXISTS coop_apps;
DROP TABLE IF EXISTS crawl_state;
DROP TABLE IF EXISTS rate_limits;

-- ── people ──────────────────────────────────────────────────────────────────
-- steam_id is a SteamID64, or 'seed:<group>:<name>' for a placeholder member
-- that exists only so imported ratings have somewhere to live until the real
-- person signs in and claims it.
CREATE TABLE users (
  steam_id     TEXT PRIMARY KEY,
  display_name TEXT,
  avatar       TEXT,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  last_seen_at INTEGER
);

-- ── groups ──────────────────────────────────────────────────────────────────
CREATE TABLE groups (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  slug         TEXT NOT NULL UNIQUE,          -- URL segment, e.g. 'g4m1ng'
  name         TEXT NOT NULL,
  invite_code  TEXT UNIQUE,                   -- NULL disables joining by link
  max_players  INTEGER NOT NULL DEFAULT 4,    -- the group's own co-op headcount
  -- Owner-set: hide everyone's ratings from each other while rating, so nobody is
  -- anchored. A group rule rather than a personal preference, because one person
  -- rating blind while the rest see the numbers achieves nothing.
  blind_rating INTEGER NOT NULL DEFAULT 0,
  created_by   TEXT REFERENCES users(steam_id) ON DELETE SET NULL,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Workspace intent is explicit rather than inferred from member count. Every new
-- co-op group starts with one owner too, so "one member" cannot distinguish it
-- from a personal library. Missing rows are legacy co-op workspaces.
CREATE TABLE workspace_settings (
  group_id INTEGER PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,
  mode     TEXT NOT NULL CHECK (mode IN ('coop','personal'))
);

CREATE TABLE memberships (
  group_id   INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  steam_id   TEXT    NOT NULL REFERENCES users(steam_id) ON DELETE CASCADE,
  short_name TEXT    NOT NULL,                -- what the group calls them
  role       TEXT    NOT NULL DEFAULT 'member' CHECK (role IN ('owner','member')),
  is_seed    INTEGER NOT NULL DEFAULT 0,      -- placeholder awaiting a claim
  joined_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (group_id, steam_id)
);

-- Member-facing housekeeping is opt-in. Keeping this in a side table means a
-- missing row is the safe default for every existing and newly-created member.
CREATE TABLE member_preferences (
  group_id        INTEGER NOT NULL,
  steam_id        TEXT    NOT NULL,
  history_prompts INTEGER NOT NULL DEFAULT 0 CHECK (history_prompts IN (0,1)),
  -- Which workspace a hash-less visit opens. Living here rather than in a
  -- per-account table means leaving a group cascades the choice away, so the boot
  -- path can never be pointed at a workspace you are no longer in.
  default_workspace INTEGER NOT NULL DEFAULT 0 CHECK (default_workspace IN (0,1)),
  PRIMARY KEY (group_id, steam_id),
  FOREIGN KEY (group_id, steam_id) REFERENCES memberships(group_id, steam_id)
    ON DELETE CASCADE
);

-- "At most one default per account" as a constraint rather than a convention.
-- Mirrors migrations/029-default-workspace.sql.
CREATE UNIQUE INDEX idx_member_default_workspace
  ON member_preferences(steam_id) WHERE default_workspace = 1;

-- A direct invitation names an existing account but does not create membership.
-- The recipient must explicitly accept before the tenancy boundary lets them in.
CREATE TABLE group_invites (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id         INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  invited_steam_id TEXT    NOT NULL REFERENCES users(steam_id) ON DELETE CASCADE,
  invited_by       TEXT    NOT NULL REFERENCES users(steam_id) ON DELETE CASCADE,
  status           TEXT    NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','accepted','rejected','cancelled')),
  created_at       INTEGER NOT NULL DEFAULT (unixepoch()),
  responded_at     INTEGER,
  UNIQUE (group_id, invited_steam_id)
);
CREATE INDEX idx_group_invites_recipient
  ON group_invites(invited_steam_id, status, created_at DESC);

-- ── shared Steam metadata cache ──────────────────────────────────────────────
-- Keyed by appid and shared across every group, so a thousand groups adding
-- Terraria costs one request to Steam rather than a thousand. Steam's store
-- endpoints throttle at roughly 200 requests / 5 min per IP, which is the
-- binding constraint once more than one group is using the site.
CREATE TABLE steam_apps (
  appid             INTEGER PRIMARY KEY,
  name              TEXT,
  genre             TEXT,
  header_image      TEXT,
  trailer_url       TEXT,
  short_description TEXT,
  price             TEXT,
  release_date      TEXT,
  metacritic        INTEGER,
  coop_categories   TEXT,                     -- JSON array, Steam modes including Single-player
  -- Steam user tags for games the co-op catalogue does not list. The recommender
  -- learns a group's taste from these, and reading them only from `coop_apps` threw
  -- away 44% of group 1's evidence. NULL means nobody has looked, never "no tags",
  -- or the crawler stops retrying the row. Mirrors migrations/031-steam-app-tags.sql.
  tags              TEXT,
  tags_at           INTEGER,
  fetched_at        INTEGER NOT NULL DEFAULT (unixepoch())
);

-- ── the global co-op catalogue ──────────────────────────────────────────────
-- Browsable list of co-op games on Steam, ranked by popularity, from which any
-- group pulls candidates into its own pool. Not group-scoped and not a cache:
-- steam_apps holds metadata for games someone already looked at, this holds
-- games nobody has looked at yet. Kept in sync with migrations/001-coop-apps.sql
-- — change both, since existing databases only ever see the migration.
CREATE TABLE coop_apps (
  appid             INTEGER PRIMARY KEY,
  name              TEXT NOT NULL,
  popularity_rank   INTEGER,          -- 1 = most reviewed co-op game on Steam
  review_count      INTEGER,          -- total Steam reviews; the popularity signal
  review_hint       TEXT,             -- Steam's score summary, e.g. 'Very Positive'
  header_image      TEXT,
  short_description TEXT,
  genre             TEXT,
  price             TEXT,
  release_date      TEXT,             -- Steam's display string, e.g. '16 May, 2011'
  release_ts        INTEGER,          -- parsed epoch seconds; sorting the string is NOT chronological
  metacritic        INTEGER,
  coop_categories   TEXT,             -- JSON array of Steam's co-op tags: a HINT
  -- Steam user tags, most-voted first, scraped off the store page — they are in no
  -- Steam JSON API, and `genre` is too coarse to substitute (235 of 337 rows are
  -- "Action"). These are what the Recommended sort matches against a group's taste.
  tags              TEXT,             -- JSON array of tag names
  -- 0 for primary PvP or Singleplayer with no multiplayer evidence. Requiring a co-op tag instead
  -- was measured wrong: 24% of real co-op games carry none. See lib/coop.js.
  is_coop           INTEGER,
  tags_at           INTEGER,
  max_players       INTEGER,          -- verified online co-op cap; NULL = unknown
  max_players_src   TEXT,             -- provenance; NULL means nobody checked
  coop_note         TEXT,
  crawled_at        INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX idx_coop_apps_rank ON coop_apps(popularity_rank);
CREATE INDEX idx_coop_apps_name ON coop_apps(name COLLATE NOCASE);
CREATE INDEX idx_coop_apps_released ON coop_apps(release_ts);
CREATE INDEX idx_coop_apps_reviews  ON coop_apps(review_count);
CREATE INDEX idx_coop_apps_crawled  ON coop_apps(crawled_at);

-- Cursor and last-run summary for the cron crawler in crawler/. A Worker
-- invocation is a cold start with no memory of the previous one, so the
-- discovery page it should fetch next has to live in the database.
CREATE TABLE crawl_state (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- ── a group's library ───────────────────────────────────────────────────────
-- Metadata is denormalised onto the row rather than joined from steam_apps so
-- a group can override anything (rename it, correct a player count) without
-- affecting every other group's copy.
CREATE TABLE games (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id          INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  steam_appid       INTEGER,
  genre             TEXT,
  status            TEXT NOT NULL DEFAULT 'backlog'
                      -- 'unfinished' = we tried to finish it and never did, which is
                      -- neither 'dropped' (gave up) nor 'sampled' (barely started).
                      CHECK (status IN ('backlog','playing','finished','unfinished','dropped','sampled')),
  max_players       INTEGER,                  -- max simultaneous ONLINE co-op players
  -- Retained for compatibility with the earlier Play Night experiment. It is not
  -- exposed by the current attendee filter; Steam lifetime hours must never be
  -- repurposed as a session-length estimate.
  min_session_minutes INTEGER,
  coop_note         TEXT,                     -- 'Remote Play Together', 'needs a mod', …
  header_image      TEXT,
  trailer_url       TEXT,
  short_description TEXT,
  price             TEXT,
  release_date      TEXT,
  metacritic        INTEGER,
  hours             REAL,             -- manual or accepted snapshot; always wins over live estimate
  hours_estimated   REAL,             -- min across participants; an upper bound, not a measurement
  hours_participants INTEGER,         -- how many people that minimum was taken over
  started           TEXT,             -- ISO date; exact when manual, approximate when
                                      -- provenance records release/achievement evidence
  finished          TEXT,             -- manual or accepted snapshot; wins over live estimate
  finished_estimated TEXT,            -- latest rtime_last_played across participants
  notes             TEXT,
  added_by          TEXT REFERENCES users(steam_id) ON DELETE SET NULL,
  enriched_at       INTEGER,
  -- NULL means active. Removing a game archives it rather than deleting it, so
  -- the ratings survive and restoring brings everything back. Mirrors
  -- migrations/009-archive.sql.
  archived_at       INTEGER,
  created_at        INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (group_id, steam_appid)              -- one copy per group; NULLs exempt
);

CREATE TABLE ratings (
  game_id    INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  steam_id   TEXT    NOT NULL REFERENCES users(steam_id) ON DELETE CASCADE,
  score      REAL    NOT NULL CHECK (score >= 1 AND score <= 10),
  comment    TEXT,
  -- Would you play it again with this group? Only asked where the score cannot
  -- answer it: a game the GROUP has not played but you personally have, where
  -- "it was great" and "I want to play it again" are different statements.
  -- NULL means never asked; any value is also the record that you have played it.
  -- Mirrors migrations/030-replay-appetite.sql.
  replay     TEXT    CHECK (replay IS NULL OR replay IN ('yes','maybe','no')),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (game_id, steam_id)
);

-- Per-person Steam playtime. Global rather than group-scoped: one person's minutes
-- in a game are the same fact in every group they belong to. Mirrors
-- migrations/011-playtime.sql, which explains why the group estimate is a MINIMUM.
CREATE TABLE playtime (
  steam_id    TEXT    NOT NULL,
  appid       INTEGER NOT NULL,
  minutes     INTEGER NOT NULL,
  -- Steam's rtime_last_played. The only time-shaped field GetOwnedGames returns;
  -- there is no first-played date, which is why games.started is manual.
  last_played INTEGER,
  fetched_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (steam_id, appid)
);
CREATE INDEX idx_playtime_app ON playtime(appid);

-- Steam returns an empty list for a private profile rather than an error, so
-- "owns nothing" and "hidden from us" are indistinguishable unless the attempt is
-- recorded. This is what lets the group settings say whose data is missing.
-- `games` is how many titles came back; `played` how many had any playtime at all.
-- Both are needed because Steam has two privacy switches: one hides the library,
-- another hides only the minutes. A member with 455 games and 0 played minutes has
-- the second one set, and counting games would call that a successful sync.
CREATE TABLE playtime_sync (
  steam_id  TEXT PRIMARY KEY,
  games     INTEGER,
  played    INTEGER,
  synced_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- A global playtime sync is not proof that a missing row belongs to THIS group's
-- library: the sync stores only games in the group from which it was launched.
-- This group-scoped watermark is therefore the only thing allowed to turn an
-- absent playtime row into "not owned". Existing data stays unknown until the
-- group is synced once, which is safer than a false negative.
CREATE TABLE group_library_sync (
  group_id  INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  steam_id  TEXT    NOT NULL,
  games     INTEGER,
  played    INTEGER,
  synced_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (group_id, steam_id)
);

-- Achievement progress is global for the same reason playtime is: a Steam
-- account's progress in an app does not change between groups. Members sync one
-- game at a time from its detail panel, keeping Steam traffic bounded and making
-- profile privacy failures attributable rather than silently incomplete.
CREATE TABLE achievement_progress (
  steam_id   TEXT    NOT NULL,
  appid      INTEGER NOT NULL,
  achieved   INTEGER NOT NULL,
  total      INTEGER NOT NULL,
  unlocked   TEXT    NOT NULL,                -- JSON [{key,name,unlocktime}]
  fetched_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (steam_id, appid)
);
CREATE INDEX idx_achievement_app ON achievement_progress(appid);

-- Provenance for shared history fields. The values stay on games because they
-- are read everywhere; this small side table explains whether a value was typed
-- by a person or accepted from a deliberately approximate Steam suggestion.
-- group_id is denormalised for the same tenancy reason as comments.
CREATE TABLE game_fact_sources (
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

-- "Don't know" and "later" are personal answers: one friend drawing a blank
-- must not hide the prompt from somebody else who may remember. Filled facts
-- disappear automatically because the queue only selects missing values.
CREATE TABLE history_nudges (
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
CREATE INDEX idx_history_nudges_member
  ON history_nudges(group_id, steam_id, snoozed_until);

-- One comment thread per game. group_id is denormalised on purpose: invariant 2
-- wants every statement below the tenancy boundary to filter on group_id, and a
-- column beats a join somebody will forget. Mirrors migrations/010-comments.sql.
CREATE TABLE comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id   INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  game_id    INTEGER NOT NULL REFERENCES games(id)  ON DELETE CASCADE,
  steam_id   TEXT    NOT NULL REFERENCES users(steam_id) ON DELETE CASCADE,
  body       TEXT    NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX idx_comments_game  ON comments(game_id, created_at);
CREATE INDEX idx_comments_group ON comments(group_id);

-- "Not interested": catalogue games this group has rejected, hidden from Find
-- games until somebody undoes it. Group-scoped rather than personal, on the same
-- reasoning as games.archived_at — it is a shared decision, it destroys nothing,
-- and steam_id records who so the others know whom to argue with. `name` is a
-- snapshot because the crawler deletes coop_apps rows it later rejects, and an
-- undo list full of unlabelled appids would be useless. Mirrors
-- migrations/034-coop-dismissals.sql.
CREATE TABLE coop_dismissals (
  group_id   INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  appid      INTEGER NOT NULL,
  name       TEXT    NOT NULL,
  steam_id   TEXT REFERENCES users(steam_id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (group_id, appid)
);
CREATE INDEX idx_coop_dismissals_group ON coop_dismissals(group_id, created_at DESC);

-- Pre-assigned identities: an owner can decide in advance that a SteamID64 is
-- "Leo", so that friend signs in and lands as Leo without seeing the claim
-- prompt. Keyed on SteamID64 because persona names are mutable and not unique,
-- and a vanity URL only exists if the person set one. Mirrors
-- migrations/005-seed-assignments.sql.
CREATE TABLE seed_assignments (
  group_id      INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  steam_id      TEXT    NOT NULL,
  seed_steam_id TEXT    NOT NULL,
  note          TEXT,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (group_id, steam_id)
);

-- "I looked at it and have no opinion" — keeps the queue from re-showing it.
CREATE TABLE skips (
  game_id    INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  steam_id   TEXT    NOT NULL REFERENCES users(steam_id) ON DELETE CASCADE,
  -- 1 = "I wasn't part of this one", not "no opinion". A group of four does not
  -- always play as four, and the difference matters: a game you did not play
  -- comes out of YOUR coverage denominator instead of counting as unrated.
  not_played INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (game_id, steam_id)
);

-- Per-account abuse protection for writes and Steam-backed lookups. One row per
-- account/category is reused every window, so this table never needs a cleanup job.
CREATE TABLE rate_limits (
  bucket       TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  hits         INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX idx_games_group     ON games(group_id, status);
CREATE INDEX idx_games_active    ON games(group_id, archived_at);
CREATE INDEX idx_ratings_game    ON ratings(game_id);
CREATE INDEX idx_ratings_user    ON ratings(steam_id);
CREATE INDEX idx_memberships_usr ON memberships(steam_id);
CREATE INDEX idx_groups_invite   ON groups(invite_code);

-- Group activity: mirrors migrations/036-group-activity.sql.
-- New activity only: no history is backfilled and no existing game is changed.
-- Keep this definition in schema.sql too. Apply before deploying the activity API.
CREATE TABLE IF NOT EXISTS group_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  actor_id TEXT REFERENCES users(steam_id) ON DELETE SET NULL,
  game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('game_added','rating','status_changed','comment')),
  from_status TEXT,
  to_status TEXT,
  comment_id INTEGER REFERENCES comments(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_activity_group_id ON group_activity(group_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_activity_group_time ON group_activity(group_id, created_at);

-- AUTOINCREMENT event ids are watermarks: an acknowledged id must never be reused.
-- A member leaving loses their read state; another member's cursor is independent.
CREATE TABLE IF NOT EXISTS activity_reads (
  group_id INTEGER NOT NULL,
  steam_id TEXT NOT NULL,
  last_read_id INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (group_id, steam_id),
  FOREIGN KEY (group_id, steam_id) REFERENCES memberships(group_id, steam_id) ON DELETE CASCADE
);

-- Individual acknowledgements complement the existing mark-all watermark.
-- Mirrors migrations/037-activity-item-reads.sql.
CREATE TABLE IF NOT EXISTS activity_item_reads (
  group_id INTEGER NOT NULL,
  steam_id TEXT NOT NULL,
  event_id INTEGER NOT NULL REFERENCES group_activity(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, steam_id, event_id),
  FOREIGN KEY (group_id, steam_id) REFERENCES memberships(group_id, steam_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_activity_item_reads_event ON activity_item_reads(event_id);

-- Capture writes atomically, including bulk imports, without copying rating values
-- or comment bodies. Seed claims and metadata enrichment must not manufacture news.
CREATE TRIGGER IF NOT EXISTS activity_game_added AFTER INSERT ON games
WHEN EXISTS (SELECT 1 FROM memberships WHERE group_id=NEW.group_id AND steam_id=NEW.added_by AND is_seed=0)
 AND NOT EXISTS (SELECT 1 FROM workspace_settings WHERE group_id=NEW.group_id AND mode='personal')
BEGIN
  INSERT INTO group_activity (group_id,actor_id,game_id,kind)
  VALUES (NEW.group_id,NEW.added_by,NEW.id,'game_added');
END;

CREATE TRIGGER IF NOT EXISTS activity_rating_added AFTER INSERT ON ratings
BEGIN
  INSERT INTO group_activity (group_id,actor_id,game_id,kind)
  SELECT g.group_id,NEW.steam_id,g.id,'rating' FROM games g
  JOIN memberships m ON m.group_id=g.group_id AND m.steam_id=NEW.steam_id AND m.is_seed=0
  WHERE g.id=NEW.game_id
    AND NOT EXISTS (SELECT 1 FROM workspace_settings w WHERE w.group_id=g.group_id AND w.mode='personal');
END;

CREATE TRIGGER IF NOT EXISTS activity_rating_changed AFTER UPDATE OF score ON ratings
WHEN NEW.score IS NOT OLD.score
BEGIN
  INSERT INTO group_activity (group_id,actor_id,game_id,kind)
  SELECT g.group_id,NEW.steam_id,g.id,'rating' FROM games g
  JOIN memberships m ON m.group_id=g.group_id AND m.steam_id=NEW.steam_id AND m.is_seed=0
  WHERE g.id=NEW.game_id
    AND NOT EXISTS (SELECT 1 FROM workspace_settings w WHERE w.group_id=g.group_id AND w.mode='personal');
END;

CREATE TRIGGER IF NOT EXISTS activity_comment_added AFTER INSERT ON comments
BEGIN
  INSERT INTO group_activity (group_id,actor_id,game_id,kind,comment_id)
  SELECT NEW.group_id,NEW.steam_id,NEW.game_id,'comment',NEW.id FROM games g
  JOIN memberships m ON m.group_id=g.group_id AND m.steam_id=NEW.steam_id AND m.is_seed=0
  WHERE g.id=NEW.game_id AND g.group_id=NEW.group_id
    AND NOT EXISTS (SELECT 1 FROM workspace_settings w WHERE w.group_id=g.group_id AND w.mode='personal');
END;

-- Index-bounded housekeeping on the group receiving a write; no scheduled job.
CREATE TRIGGER IF NOT EXISTS activity_retention AFTER INSERT ON group_activity
BEGIN
  DELETE FROM group_activity WHERE group_id=NEW.group_id AND created_at < unixepoch()-7776000;
END;

-- Regular play sessions: mirrors migrations/038-session-schedule.sql.

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

-- One-off session changes: mirrors migrations/039-session-overrides.sql.

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
