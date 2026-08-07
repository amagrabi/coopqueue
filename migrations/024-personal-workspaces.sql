-- Explicit personal/co-op workspace intent. Additive and safe to re-run.
-- Existing groups stay co-op by the absence of a row; member count is not a
-- safe inference because every newly-created co-op group also starts at one.

CREATE TABLE IF NOT EXISTS workspace_settings (
  group_id INTEGER PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,
  mode     TEXT NOT NULL CHECK (mode IN ('coop','personal'))
);
