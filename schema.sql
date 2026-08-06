-- CoopQueue — Cloudflare D1 schema (multi-tenant)
-- Apply with:  npx wrangler d1 execute g4m1ng --remote --file=./schema.sql
--
-- Tenancy model: everything a group owns hangs off groups.id. A person is one
-- row in users (keyed by their SteamID64) and can belong to any number of
-- groups; their display name and role are per-group, held on memberships.

DROP TABLE IF EXISTS comments;
DROP TABLE IF EXISTS playtime;
DROP TABLE IF EXISTS playtime_sync;
DROP TABLE IF EXISTS seed_assignments;
DROP TABLE IF EXISTS skips;
DROP TABLE IF EXISTS ratings;
DROP TABLE IF EXISTS games;
DROP TABLE IF EXISTS memberships;
DROP TABLE IF EXISTS groups;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS steam_apps;
DROP TABLE IF EXISTS coop_apps;
DROP TABLE IF EXISTS crawl_state;

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

CREATE TABLE memberships (
  group_id   INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  steam_id   TEXT    NOT NULL REFERENCES users(steam_id) ON DELETE CASCADE,
  short_name TEXT    NOT NULL,                -- what the group calls them
  role       TEXT    NOT NULL DEFAULT 'member' CHECK (role IN ('owner','member')),
  is_seed    INTEGER NOT NULL DEFAULT 0,      -- placeholder awaiting a claim
  joined_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (group_id, steam_id)
);

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
  coop_categories   TEXT,                     -- JSON array, Steam's own co-op tags
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
  -- 0 only for games whose top tags are a PvP genre. Requiring a co-op tag instead
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
                      CHECK (status IN ('backlog','playing','finished','dropped','sampled')),
  max_players       INTEGER,                  -- max simultaneous ONLINE co-op players
  coop_note         TEXT,                     -- 'Remote Play Together', 'needs a mod', …
  header_image      TEXT,
  trailer_url       TEXT,
  short_description TEXT,
  price             TEXT,
  release_date      TEXT,
  metacritic        INTEGER,
  hours             REAL,             -- typed by a human; always wins over the estimate
  hours_estimated   REAL,             -- min across participants; an upper bound, not a measurement
  hours_participants INTEGER,         -- how many people that minimum was taken over
  started           TEXT,
  finished          TEXT,
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
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (game_id, steam_id)
);

-- Per-person Steam playtime. Global rather than group-scoped: one person's minutes
-- in a game are the same fact in every group they belong to. Mirrors
-- migrations/011-playtime.sql, which explains why the group estimate is a MINIMUM.
CREATE TABLE playtime (
  steam_id   TEXT    NOT NULL,
  appid      INTEGER NOT NULL,
  minutes    INTEGER NOT NULL,
  fetched_at INTEGER NOT NULL DEFAULT (unixepoch()),
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

CREATE INDEX idx_games_group     ON games(group_id, status);
CREATE INDEX idx_games_active    ON games(group_id, archived_at);
CREATE INDEX idx_ratings_game    ON ratings(game_id);
CREATE INDEX idx_ratings_user    ON ratings(steam_id);
CREATE INDEX idx_memberships_usr ON memberships(steam_id);
CREATE INDEX idx_groups_invite   ON groups(invite_code);
