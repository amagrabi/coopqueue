-- CoopQueue migration 013 — hiding other people's ratings is a group rule, not a taste.
--
--   npm run db:migrate -- --file=./migrations/013-blind-rating.sql
--
-- This started as a personal display preference in localStorage. The owner's call:
-- it belongs to the group. If the point is unbiased ratings, one person opting in
-- privately achieves nothing — the group's numbers are only unanchored if everybody
-- rates blind. So it moves to a column the owner sets, applying to all members.
--
-- Default 0 keeps existing behaviour: ratings visible unless a group chooses
-- otherwise.

ALTER TABLE groups ADD COLUMN blind_rating INTEGER NOT NULL DEFAULT 0;
