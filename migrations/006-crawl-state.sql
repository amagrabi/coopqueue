-- CoopQ migration 006 — incremental crawl support.
--
--   npm run db:migrate -- --file=./migrations/006-crawl-state.sql
--
-- Two things the cron crawler needs that the bulk seed did not.
--
-- review_count: the bulk seed ranked by review count but only stored Steam's
-- score summary, not the number. The crawler stores the number so it can
-- recompute popularity_rank itself. Existing rows stay NULL until refreshed, and
-- the crawler deliberately skips re-ranking while any NULL remains — ranking on
-- COALESCE(review_count, 0) with mostly-NULL data collapses every game to rank 1.
--
-- crawl_state: a Worker invocation is a cold start with no memory of the last
-- one, so the discovery page cursor and the last-run summary have to live in the
-- database.

ALTER TABLE coop_apps ADD COLUMN review_count INTEGER;
CREATE INDEX IF NOT EXISTS idx_coop_apps_reviews ON coop_apps(review_count);

CREATE TABLE IF NOT EXISTS crawl_state (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
