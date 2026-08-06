-- CoopQ migration 005 — pre-assigned identities.
--
--   npm run db:migrate -- --file=./migrations/005-seed-assignments.sql
--
-- Lets a group owner decide in advance that a particular SteamID64 is "Leo", so
-- that friend signs in through Steam and lands straight in the group as Leo with
-- Leo's imported ratings, never seeing the "which one are you?" prompt.
--
-- Keyed on SteamID64 rather than a Steam vanity URL or persona name on purpose.
-- Persona names are mutable and not unique, and vanity URLs only exist if the
-- person set one — of four names tried for this group, two were not vanity URLs
-- at all. The SteamID64 is the only stable identifier, and it is what every
-- other table here already keys on.
--
-- An unmatched sign-in is not an error: the person simply gets the existing
-- claim screen, which is one click.

CREATE TABLE IF NOT EXISTS seed_assignments (
  group_id      INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  steam_id      TEXT    NOT NULL,       -- the real SteamID64 expected to sign in
  seed_steam_id TEXT    NOT NULL,       -- the placeholder it should receive
  note          TEXT,                   -- e.g. the Steam name it was taken from
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (group_id, steam_id)
);
