-- CoopQueue migration 012 — distinguish a hidden library from hidden playtime.
--
--   npm run db:migrate -- --file=./migrations/012-playtime-visibility.sql
--
-- Steam has two separate privacy controls, and only knowing about one of them
-- produced a wrong answer. "Game details" governs whether the owned-games list is
-- readable; a further checkbox — "Always keep my total playtime private, even if
-- users can see my game details" — hides the minutes while leaving the list
-- visible.
--
-- Measured on this group: one member returned 455 owned games with playtime_forever
-- of 0 on every single one. Judging readability by the game count therefore
-- reported him as fine while contributing nothing to any estimate. `played` records
-- how many games came back with any playtime at all, which is the number that
-- actually decides whether the sync learned anything.

ALTER TABLE playtime_sync ADD COLUMN played INTEGER;
