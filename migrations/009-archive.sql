-- CoopQueue migration 009 — archiving instead of deleting.
--
--   npm run db:migrate -- --file=./migrations/009-archive.sql
--
-- Removing a game used to DELETE the row, which cascaded away every rating anyone
-- had given it. That is a lot of destruction for a tidy-up action any member can
-- take, and the ratings are the one thing here that cannot be recreated.
--
-- So "remove" now sets archived_at. The row and its ratings stay exactly where
-- they are; the game simply drops out of the rating queue, Play next, coverage
-- denominators and the default Library view. Restoring clears the column and
-- everything is back, because nothing was ever thrown away.
--
-- NULL means active. A timestamp is stored rather than a boolean because knowing
-- *when* something was archived is free and occasionally useful.

ALTER TABLE games ADD COLUMN archived_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_games_active ON games(group_id, archived_at);
