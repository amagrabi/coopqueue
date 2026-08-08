# Importing a personal Steam history

This is the repeatable process used to seed **Amadeus Solo Games** from Steam in
migrations 026 and 027. It is intentionally conservative: Steam can prove that an
account owns or launched a game, but it usually cannot prove why somebody stopped
playing it or whether they consider it complete.

## Built-in import for any player

Personal library Settings now exposes the repeatable parts of this process to every
signed-in player. **Import games from Steam** previews only titles missing from the
current personal workspace across both the owned library and public wishlist.
Nothing is written until the player reviews checkboxes; the dialog can show both
sources or either one, include unplayed owned games, select or deselect every shown
title, and narrow the selection to owned or wishlisted games. The initial combined
view loads 250 candidates at a time; changing to one source loads every page for
that source and selects each new row by default. A reviewed selection has no
browser-side cap. It is sent in batches of at most 250 games, and the server
re-fetches both sources before every write, so a crafted request cannot inject an
arbitrary appid. The same **Import selected** action appears above and below the
candidate list so a large reviewed library does not require a final scroll to the
bottom.

If Steam reports zero minutes for every owned game, the UI warns that the separate
"Always keep my total playtime private" setting may be masking the data and asks
for confirmation before treating selected owned titles as Backlog. A successful
import also refreshes playtime for every already-tracked owned title before
advancing the group library watermark, so ownership can never become a false
negative. If only the wishlist is readable, its games can still be imported without
advancing that watermark or pretending the owned library was checked.

Played titles start as `sampled`; unplayed titles start as `backlog`. Lifetime
minutes and last-played timestamps are saved with provenance. The import itself
refreshes playtime for the whole readable library, so no duplicate sync is needed.
If the shared catalogue already has a player cap with explicit verification
provenance, that cap and its note are copied into the new workspace. Steam's store
categories are not a trustworthy cap, so every other game remains unknown.
Afterwards the browser automatically attempts up to three eight-game metadata
batches and up to twelve played games through four-game achievement batches.
**Fill missing game details** and **Analyze achievements** remain as resumable retry
controls, with a session cursor so private or unsupported games do not block later
titles. The earliest unlocked achievement is saved as an approximate first-played
boundary when it does not contradict the release or last-played date. Achievement
evidence never changes a status automatically.

The curated terminal-achievement allowlist lives in `lib/completion.js`. Matches
appear as **Likely finished** in the personal Library, game details and Stats, never
as automatic status changes. The manual migration procedure below remains useful
for Steam Replay evidence and one-off historical reconstruction that the Web API
cannot do.

## Evidence and what it means

Use the sources in this order:

| Source | Safe conclusions | Important limitation |
|---|---|---|
| Steam `GetOwnedGames` | owned app ids, exact lifetime minutes, most recent play timestamp | no first-played date, no completion state |
| Steam `IWishlistService/GetWishlist` | public wishlisted app ids and dates added | undocumented by Valve; an empty response can mean empty or private |
| `GetPlayerAchievements` | unlocked achievements and their timestamps | locked/private data can be unavailable; not every game has a terminal achievement |
| Steam Replay | games played in a year and their share of that year's playtime | percentages are not lifetime hours and the page omits many exact dates |
| Steam store metadata via `getAppDetails()` | title, art, genre, release date and store fields | store data describes the game, not this player's history |

Never treat a release date as a precise first-played date. Never reconstruct exact
hours from a rounded Replay percentage. Store approximate dates with provenance so
the UI can explain them and a later human correction can take priority.

## Status classification

- `backlog`: owned with zero recorded lifetime minutes.
- `sampled`: Steam proves some playtime, but there is no strong evidence of a
  completed ending. This also covers ongoing, multiplayer, sandbox and live-service
  games unless the person deliberately changes the status.
- `finished`: an unlocked achievement explicitly proves reaching the story ending,
  final credits, or completing the game. Completion percentage and long playtime do
  not qualify by themselves.
- `playing`, `failed to finish`, and `dropped`: require a person's current intent or
  recollection; do not infer them from Steam silence.

Migration 027 promoted these titles based on explicit terminal evidence:

| App | Evidence |
|---|---|
| The Stanley Parable | `Beat the game` |
| Subnautica | `Go Among the Stars` |
| Hollow Knight | `The Hollow Knight` / `Dream No More` |
| Pony Island | `Escape` |
| What Remains of Edith Finch | `The End of Everything` says all stories were finished |
| Nephise | achievement description explicitly says `Finish game` |
| Sekiro | `Immortal Severance` |
| Ori and the Will of the Wisps | `Destiny` |
| Cyberpunk 2077 | `The World` |
| Black Myth: Wukong | `Meet the Match` and `A Duel of Destiny` |
| Dispatch | final Los Angeles / ending-choice achievements |

Examples deliberately left as `sampled` include PUBG and Dune: Awakening (ongoing
games), Life is Strange Episode 1 (only one episode proven), Inscryption (only Act 1
proven), The Wolf Among Us (partial episodes), and Deponia: The Complete Journey
(finishing one installment does not prove the whole collection).

## Repeatable import procedure

1. Make a fresh production backup and restore it to a temporary local database.

   ```bash
   npm run db:backup
   sqlite3 /tmp/coopqueue-import.db < backup.sql
   ```

2. Fetch a complete `GetOwnedGames` snapshot for the Steam account. Keep the API
   key out of source files and logs. Compare app ids with both the source group and
   target personal workspace; import only the intended difference.

3. Resolve every game's full metadata through `getAppDetails(db, appid)`. A bounded
   selective-import preview may use `getAppSummaries(db, appids)` for names and art;
   its partial cache rows stay stale until full enrichment. Do not fetch and persist
   raw Steam store responses outside those cache paths.

4. Fetch public achievements. Record the earliest unlock only as an approximate
   first-played date and the latest unlock as an approximate last-played date. Prefer
   Steam's `last_played` timestamp for the latter when available.

5. Review unlocked achievement names and descriptions manually against the strict
   completion rule above. Keep an explicit allowlist with the exact evidence rather
   than inventing a percentage threshold.

6. Generate an additive, idempotent migration. Use `INSERT OR IGNORE`, update only
   `NULL` values or the known imported `sampled` state, and never overwrite later
   manual edits. Convert minutes with `round(minutes / 60.0, 1)` and save provenance
   in `game_fact_sources`.

7. Rehearse the migration twice over the restored production backup. Confirm game,
   rating, comment and membership counts; run `PRAGMA foreign_key_check`; inspect
   the target titles and status totals after each pass. The second pass must make no
   further changes.

8. Apply the migration remotely, verify the same counts, then run the personal
   workspace's Steam playtime sync. That sync only records games already present in
   the workspace, so it is most useful after the import.

9. Run `npm test`, browser-check all six views if `public/app.js` changed, commit,
   push and deploy according to [OPERATIONS.md](OPERATIONS.md).

## Precision and future corrections

Steam reports lifetime playtime as whole minutes. CoopQueue stores and displays
hours to one decimal place, which is enough useful precision without exposing
values such as `12.333333333`. Manual edits are rounded the same way by the API.

An achievement-derived date is a boundary, not a session log. A later manual edit
replaces its provenance with `manual` and is authoritative. Rerunning an import must
not reverse that correction.
