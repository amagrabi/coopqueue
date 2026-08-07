-- Per-account fixed-window rate limits for writes and Steam-backed requests.
-- Additive and idempotent; application middleware reuses one row per bucket.

CREATE TABLE IF NOT EXISTS rate_limits (
  bucket       TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  hits         INTEGER NOT NULL DEFAULT 1
);
