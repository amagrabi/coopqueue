-- Add index on crawled_at to coop_apps to optimize the crawler's refresh query.
-- The crawler looks for the stalest rows:
-- SELECT appid, review_count FROM coop_apps ORDER BY crawled_at ASC LIMIT ?
-- Without this index, that query does a full table scan and sort on thousands of rows every hour.

CREATE INDEX IF NOT EXISTS idx_coop_apps_crawled ON coop_apps(crawled_at);
