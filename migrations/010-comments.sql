-- CoopQueue migration 010 — a comment thread per game.
--
--   npm run db:migrate -- --file=./migrations/010-comments.sql
--
-- Replaces the single free-text `notes` field in the game dialog with something
-- several people can add to. `games.notes` is deliberately left in place and still
-- shown read-only: it holds imported text from the original spreadsheet
-- ("ggf. gruselig; Development ended, servers still up") that nobody wrote here and
-- nobody should be credited with.
--
-- group_id is denormalised onto the row even though game_id implies it. Invariant 2
-- requires every statement below the tenancy boundary to filter on group_id, and
-- having it on the row makes that a single-table predicate instead of a join that
-- somebody will eventually forget to write.

CREATE TABLE IF NOT EXISTS comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id   INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  game_id    INTEGER NOT NULL REFERENCES games(id)  ON DELETE CASCADE,
  steam_id   TEXT    NOT NULL REFERENCES users(steam_id) ON DELETE CASCADE,
  body       TEXT    NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_comments_game ON comments(game_id, created_at);
CREATE INDEX IF NOT EXISTS idx_comments_group ON comments(group_id);
