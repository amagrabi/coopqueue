-- CoopQueue migration 018 — when the group played a game.
--
--   npm run db:migrate -- --file=./migrations/018-play-dates.sql
--
-- `games.started` and `games.finished` already existed and had no UI. They are
-- human-typed ISO dates and, like `hours`, they always win.
--
-- **Steam cannot tell us when a group started a game.** `GetOwnedGames` returns
-- `playtime_forever` and `rtime_last_played` and nothing else time-shaped — no
-- first-played, no acquired, no purchase date. Checked against the live API, whose
-- per-row keys are exactly: appid, name, playtime_forever, img_icon_url,
-- playtime_windows/mac/linux/deck_forever, rtime_last_played, content_descriptorids,
-- playtime_disconnected. So a start date is manual, always.
--
-- The *end* is derivable, and worth having: `rtime_last_played` is real (this group's
-- Elden Ring reads 2026-06-16). `games.finished_estimated` holds the latest date any
-- participant last played it — when the group as a whole stopped — and is shown with
-- an "≈" only when nobody has typed `finished`, exactly like hours_estimated.
--
-- Additive columns only; no table rebuild, so none of migration 017's hazards apply.

ALTER TABLE playtime ADD COLUMN last_played INTEGER;
ALTER TABLE games    ADD COLUMN finished_estimated TEXT;
