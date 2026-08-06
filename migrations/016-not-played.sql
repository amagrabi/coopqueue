-- CoopQueue migration 016 — "I didn't play this" as a distinct answer.
--
--   npm run db:migrate -- --file=./migrations/016-not-played.sql
--
-- The rating queue offers finished games to everyone in the group, but a group of
-- four does not always play as four — plenty of games here were played by two or
-- three of them. Those people had only "No opinion", which hides the card but is a
-- different statement: "I played it and have nothing to say" versus "I wasn't
-- there". Conflating them makes rating coverage read as apathy.
--
-- Stored on `skips` rather than a new table because the queue behaviour is
-- identical — both hide the card — and a second table would need the same
-- group-scoped delete, the same cascade and the same tenancy filter for one bit of
-- information.
--
-- The bit is load-bearing for coverage: a game you did not play is removed from
-- YOUR denominator, so a 3-of-4 session no longer drags the fourth person's
-- percentage down for a game they could not have rated.

ALTER TABLE skips ADD COLUMN not_played INTEGER NOT NULL DEFAULT 0;
