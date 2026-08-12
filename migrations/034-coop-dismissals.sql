-- CoopQueue migration 034 — "not interested", and the way back from it.
--
--   npm run db:migrate -- --file=./migrations/034-coop-dismissals.sql
--
-- Find games shows a few hundred catalogue rows and a group works through them
-- once. Without a way to say no, the same games it has already rejected sit at the
-- top of the list every time somebody looks, and the list never gets shorter.
--
-- **Group-scoped, not personal.** One person dismissing hides the game for
-- everybody, which is the same call `games.archived_at` makes: Find games is a
-- shared decision about what to add, and a per-person hide would leave four people
-- each rejecting the same game separately. `steam_id` records who, so the others
-- know whom to argue with rather than finding a game silently gone — and anybody
-- can undo it, exactly like restoring an archived game.
--
-- That is only safe because it destroys nothing. The game stays in the catalogue,
-- keeps its ratings elsewhere, and reappears in full on undo.
--
-- `name` is stored rather than joined for a specific reason: the crawler DELETEs
-- `coop_apps` rows that turn out to be DLC or fall under the review floor, so a
-- dismissal joined against a vanished row would render as an unlabelled orphan in
-- the very list built for undoing it. It is a snapshot of what was rejected.
--
-- `group_id` is denormalised into the primary key for the same reason `comments`
-- carries it: invariant 2 wants a single-table predicate below the tenancy
-- boundary, not a join somebody eventually forgets.
--
-- No foreign key to `coop_apps`. Catalogue rows come and go with every crawl, and
-- a dismissal outliving its row is harmless; one cascading away silently is not.

CREATE TABLE IF NOT EXISTS coop_dismissals (
  group_id   INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  appid      INTEGER NOT NULL,
  name       TEXT    NOT NULL,
  steam_id   TEXT REFERENCES users(steam_id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (group_id, appid)
);

CREATE INDEX IF NOT EXISTS idx_coop_dismissals_group
  ON coop_dismissals(group_id, created_at DESC);
