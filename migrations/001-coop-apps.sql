-- CoopQ migration 001 — the global co-op library.
--
-- Additive and idempotent on purpose. schema.sql begins with DROP TABLE and so
-- can never be re-run against a live database; anything that has to reach
-- production after the first deploy belongs in a file like this instead.
--
--   npm run db:migrate
--
-- What this table is for: `steam_apps` caches metadata for games somebody has
-- already looked at. `coop_apps` is the opposite — a browsable catalogue of
-- co-op games nobody in any group has necessarily touched yet, which is what
-- lets a brand new group build a pool by browsing rather than by knowing what
-- to search for. A group's pool is still `games`; nothing here is group-scoped.

CREATE TABLE IF NOT EXISTS coop_apps (
  appid             INTEGER PRIMARY KEY,
  name              TEXT NOT NULL,
  -- Crawl position under Steam's Reviews_DESC ordering: 1 is the most reviewed
  -- co-op game on Steam. A proxy for popularity, and the default browse order.
  popularity_rank   INTEGER,
  review_hint       TEXT,             -- Steam's own review summary, when offered
  header_image      TEXT,
  short_description TEXT,
  genre             TEXT,
  price             TEXT,
  release_date      TEXT,
  release_ts        INTEGER,          -- parsed epoch seconds; the string is not sortable
  metacritic        INTEGER,
  coop_categories   TEXT,             -- JSON array of Steam's co-op tags: a HINT
  -- Max simultaneous ONLINE co-op players. NULL means genuinely unknown, which
  -- viability() reports as unknown rather than blocked. Steam does not expose
  -- this anywhere machine-readable and its own co-op tags are wrong often
  -- enough to be dangerous (invariant 6), so a number here must come from a
  -- human or a source that actually checked — recorded in max_players_src.
  max_players       INTEGER,
  max_players_src   TEXT,             -- 'manual', 'co-optimus', … NULL if unverified
  coop_note         TEXT,             -- 'Remote Play Together', 'one copy needed', …
  crawled_at        INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Browsing is always "most popular first, optionally filtered", so rank leads.
CREATE INDEX IF NOT EXISTS idx_coop_apps_rank ON coop_apps(popularity_rank);
CREATE INDEX IF NOT EXISTS idx_coop_apps_name ON coop_apps(name COLLATE NOCASE);
