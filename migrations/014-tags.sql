-- CoopQueue migration 014 — user tags, and a co-op flag we can filter on.
--
--   npm run db:migrate -- --file=./migrations/014-tags.sql
--
-- Steam's own `genres` field is too coarse to be useful: 235 of the 337 games in
-- this catalogue are simply "Action". The group's hand-entered spreadsheet
-- taxonomy is far better — "Survival", "Roguelike", "Hero Shooter", "Jump 'n' Run"
-- — and Steam's *user tags* are much closer to that than its genres are.
--
-- Tags are not in the appdetails payload, but SteamSpy exposes them free and
-- without a key, with vote counts:
--   steamspy.com/api.php?request=appdetails&appid=892970
--   -> Open World Survival Craft 2379, Survival 2252, Online Co-Op 2174, ...
--
-- Stored as a JSON array of the top tags by votes, most-voted first. That is what
-- the "Recommended" sort compares a candidate against the group's own taste.
--
-- `is_coop` is 0 only for games whose top tags are a PvP genre. Steam's category 38
-- is how these games were found, but it is applied loosely enough that the
-- catalogue contains Counter-Strike, Apex Legends and Dead by Daylight — so the
-- browse view needs something better than "it was in the co-op search" to filter on.
--
-- Note it is NOT "the tags mention co-op". That was tried and measured against 42
-- games group 1 plays co-operatively: it hid 20 of them, Terraria and Stardew Valley
-- included. Excluding PvP genres hid 2, both of which really are PvP. lib/coop.js
-- carries the full numbers; migration 015 recomputes the column under the new rule.

ALTER TABLE coop_apps ADD COLUMN tags TEXT;
ALTER TABLE coop_apps ADD COLUMN is_coop INTEGER;
ALTER TABLE coop_apps ADD COLUMN tags_at INTEGER;
