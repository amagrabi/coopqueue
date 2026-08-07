-- CoopQueue migration 019 — retire `games.notes` into the comment thread.
--
--   npm run db:migrate -- --file=./migrations/019-notes-to-comments.sql
--
-- `games.notes` held text imported from the original spreadsheet, and the detail
-- panel showed it in a bespoke read-only box labelled "Note from the spreadsheet".
-- That box is an artifact of one group's import: nobody who starts a group here
-- would ever see it, which makes it exactly the kind of field that teaches people
-- the UI is inconsistent.
--
-- The content is worth keeping — "DEAD — servers shut down Jan 2023", "geht nur im
-- remote play together", "Best coop game 2024 laut youtube video" — so it moves to
-- the place comments already live rather than being dropped.
--
-- Authorship is the wrinkle. `comments.steam_id` is NOT NULL and references `users`,
-- and attributing imported text to a real person would credit them with something
-- they did not write. So each group gets an `import:<group_id>` user row, following
-- the existing `seed:<group_id>:<name>` convention for identities that are real rows
-- but can never log in. It gets no membership, so it is not a member, does not
-- appear in the group list, and takes no colour slot.
--
-- `games.notes` is left in place. The column is no longer read by the UI, but
-- keeping it means this migration is reversible and loses nothing if it is wrong.
-- Idempotent: re-running inserts nothing, because the NOT EXISTS matches on body.

INSERT OR IGNORE INTO users (steam_id, display_name)
SELECT DISTINCT 'import:' || g.group_id, 'Imported from the spreadsheet'
  FROM games g
 WHERE g.notes IS NOT NULL AND TRIM(g.notes) <> '';

INSERT INTO comments (group_id, game_id, steam_id, body, created_at)
SELECT g.group_id, g.id, 'import:' || g.group_id, TRIM(g.notes),
       COALESCE(g.created_at, unixepoch())
  FROM games g
 WHERE g.notes IS NOT NULL
   AND TRIM(g.notes) <> ''
   AND NOT EXISTS (
     SELECT 1 FROM comments c
      WHERE c.game_id = g.id
        AND c.steam_id = 'import:' || g.group_id
        AND c.body = TRIM(g.notes)
   );
