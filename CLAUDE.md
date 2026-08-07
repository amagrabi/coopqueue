# CLAUDE.md

Context for Claude Code working in this repo. This file covers the things that are
not obvious from the code, and the state the project is in.

The other docs, and what each is for:

- **`AGENTS.md`** — the short orientation for any coding agent: hard rules, layout,
  and which constants are measured rather than chosen. Start there if this file is
  too long to read in full.
- **`docs/OPERATIONS.md`** — the runbook for the deployed instance: what exists in
  Cloudflare, secrets, deploying, migrations, backups and recovery, catalogue
  maintenance, and a troubleshooting table.
- **`README.md`** — the product, and first-time setup from nothing.

Keep them in sync when behaviour changes. This file is the one with the numbers.

## The name

The product is **CoopQueue**, live at **<https://coopqueue.pages.dev>**. The Pages
project is `coopqueue`; the old `g4m1ng` project has been deleted and that URL is
gone. `coopq.pages.dev` was not available — `*.pages.dev` names are globally
unique across all Cloudflare accounts, and `coopq` is taken by someone else.

Every remaining `g4m1ng` in this repo is deliberate and must not be "tidied up".
They are three unrelated identifiers that happen to share the old name:

- the **D1 database**, still `g4m1ng` (`wrangler.toml`, `crawler/wrangler.toml`,
  the `db:*` scripts). D1 has no rename, and the name is cosmetic — bindings
  resolve by `database_id`. Renaming would mean creating a database and migrating
  every row for no gain.
- the **session cookie** `g4_session` (`lib/auth.js`). Renaming it signs everyone
  out for no benefit.
- **group 1's slug and name**, which is genuinely what those four friends call
  themselves — nothing to do with the product name.

The GitHub repository is **`amagrabi/coopqueue`** (private) and the local checkout is
**`~/code/coopqueue`**, renamed from `~/code/g4m1ng` at the owner's request.

That rename breaks the worktrees, and repairing them has one non-obvious step. Git
records absolute paths in **both** directions — each worktree's `.git` file points at
`<main>/.git/worktrees/<name>`, and that directory's `gitdir` file points back at the
worktree — so after moving the checkout every worktree under `.claude/worktrees/`
shows up as `prunable`.

**Bare `git worktree repair` is not enough.** With no arguments it only fixes the main
side; `git worktree list` still reports the old paths, still prunable. The moved
worktrees have to be named explicitly:

```bash
cd ~/code/coopqueue
git worktree repair .claude/worktrees/*        # the new paths, not bare `repair`
git worktree list                              # verify: nothing says "prunable"
```

Nothing else hardcodes the path — `git grep "code/g4m1ng"` finds only this note.

One thing the rename does *not* carry over: Claude Code keys its per-project state
(session transcripts, the memory directory) on the working-directory path, so anything
from before the rename lives under `~/.claude/projects/-Users-amadeus-code-g4m1ng/`
and a session started in the renamed directory will not see it. Nothing is lost, but
nothing finds it automatically either.

Deleting a Pages project does **not** touch D1: they are separate resources, and
the row counts were identical either side of the deletion. A custom domain is
still the right long-term answer; then the `pages.dev` host stops mattering.

## What this is

A multi-tenant co-op game tracker. Groups of friends rate games they've played,
vote on what to play next, and get told which games their whole group can
actually fit into. Cloudflare Pages + Functions + D1, Steam OpenID for identity.
No framework, no bundler, no build step — edit a file and deploy.

It started as a Google Sheet belonging to four friends (Ama, Leo, Pat, Dave)
with 92 games and 232 ratings; `seed.sql` is that data, imported as group #1.
`recommendations.sql` is a second optional import: 22 candidates researched
against the group's demonstrated taste, with player counts verified against
Steam and Co-Optimus rather than taken from store pages. Both are optional —
skipping them gives you an empty instance.

## Commands

```bash
npm run setup            # one-shot Cloudflare provisioning + first deploy
npm run deploy           # ship changes
npm test                 # 114 tenancy/permission/scoring assertions — ALWAYS run before deploying
npm run test:ui          # renders every screen headless — does NOT run on macOS, see State
npm run db:backup        # wrangler d1 export — D1's free tier has NO automatic backups
node test/harness.mjs    # local UI dev server; SCENARIO=anon|fresh|claim|member

npm run db:migrate -- --file=./migrations/001-coop-apps.sql   # apply one migration
npm run crawl:coop -- --pages 8 --out migrations/002-coop-seed.sql
node scripts/seed-player-caps.mjs --from migrations/002-coop-seed.sql \
                                 --out migrations/003-player-caps.sql

node scripts/validate-palette.mjs      # re-check player-colour separation (invariant 4)

# tags and the co-op flag (invariant 7). backfill reads Steam store pages, ~1.7s
# apart; reclassify needs no network at all, it re-derives the flag from stored tags.
node scripts/backfill-tags.mjs --out migrations/015-steam-tags.sql
node scripts/backfill-tags.mjs --all   # re-read every row, not just untagged ones
node scripts/reclassify-coop.mjs --out migrations/017-reclassify.sql

cd crawler && npx wrangler deploy      # the hourly cron catalogue crawler
cd crawler && npx wrangler tail        # watch cron runs live
```

**`schema.sql` can never be applied to a live database** — it opens with
`DROP TABLE`, so running `db:init` against production wipes every group and
rating. Anything that has to reach an existing database goes in `migrations/` as
an additive, idempotent file applied with `db:migrate`. New tables must be added
to *both* `schema.sql` (for fresh installs and both test suites, which build from
it) and a migration (for production) — they are kept in sync by hand.

`npm run dev` (wrangler pages dev) works but Steam OpenID cannot redirect back to
`localhost`, so use `test/harness.mjs` for anything UI. It serves the real
frontend against an in-memory SQLite copy of `schema.sql` + `seed.sql` with auth
stubbed, and it has four scenarios covering every auth state.

## Invariants — do not break these

**1. The tenancy boundary is `functions/api/g/[slug]/_middleware.js`.** It is the
only place that decides whether a caller may touch a group. It returns **404,
not 403**, for a group you are not in, so private groups cannot be discovered by
guessing URLs. Keep it that way.

**2. Every query below that boundary still filters on `data.group.group_id`.**
Game ids are global and sequential. Being a legitimate member of group A must not
let you `PATCH /api/g/group-a/games/5000` and hit group B's row 5000. This is the
single easiest bug to reintroduce when adding an endpoint — `test/isolation.mjs`
asserts it for read, rate, patch, delete and the queue, so add a case there for
any new route.

**3. Steam metadata goes through `getAppDetails(db, appid)` in `lib/steam.js`,
never a raw fetch.** It is cache-first against the shared `steam_apps` table.
Steam's store endpoints throttle at roughly 200 requests / 5 min *per IP*, and
Workers egress from a shared pool — this cache is the only reason the site can
have more than a handful of groups.

**4. Colours come from the validated palette in `styles.css`, and the ORDER they
are handed out in matters as much as the values.** The eight `--series-*` values
clear 3:1 contrast against the `#1a1a19` surface. They do **not** all clear CVD
separation from each other — measured, the worst pair is ΔE 2.2 under
deuteranopia, so the palette is safe for a handful of series and not for eight.

`SERIES` in `app.js` therefore hands them out in a non-numeric order, currently
blue / orange / magenta / green. Run `scripts/validate-palette.mjs` before
reordering or adding hues; do not pick by eye. It reads `SERIES` straight out of
`app.js`, because a second hardcoded copy of the order went stale once and had the
validator cheerfully reporting on an assignment the site no longer used.

**Optimising the worst case across all three vision types is not sufficient on its
own**, and the script says so in its own output. That objective picks blue/orange/
magenta/**red**: ΔE 25.1 at worst for a dichromat, but magenta vs red is only ΔE
25.4 in *normal* vision, and "Leo and Pat are both red-ish" was the actual reported
complaint. The live order keeps normal-vision separation high first (worst pair
ΔE 52.3, and Leo vs Pat specifically is 119.8) and then takes the best CVD figure
available under that constraint (ΔE 16.1, up from 9.2 for plain numeric order).
Both numbers are printed; a change has to justify itself on both.

**5. `public/vendor/hls.min.js` is the one vendored dependency — keep it that
way, and keep it the FULL build.** "No dependencies at runtime" held until Steam
moved trailers to adaptive-only streaming; playing them anywhere except Safari now
requires a streaming library, and the rating queue is built around the trailer.
It must not be swapped for `hls.light.min.js` to save 55 KB: Steam serves audio as
a *separate* HLS rendition, which the light build parses but cannot play — it
reported 0 audio tracks and decoded 0 audio bytes in Chromium while video played
fine, so trailers ran silently and the mute button had nothing to unmute. It is
committed as a static asset rather than fetched from a CDN so the site stays a
self-contained bundle with no build step, and it costs nothing: Pages does not
meter static assets, and hls.js pulls segments from Steam's CDN straight to the
browser, never through a Worker. Anything else wanting a package should still
justify itself against that bar.

**6. `max_players` means max *simultaneous online co-op* players.** Not the Steam
store's headline number, not local/couch co-op. Steam's own co-op categories are
stored as a hint in `steam_apps.coop_categories` and deliberately never used as
truth, because they are frequently wrong. Couch-only and one-copy games are not
"blocked" — `viability()` returns `'workaround'` for them.

**7. Steam user tags come from the store page HTML, via `parseStoreTags`, and they
are the only usable signal for "is this co-op".** Three things were measured here
and all three are load-bearing:

- **Tags are in no Steam JSON API.** Not `appdetails`, not the search endpoint.
  Only the `glance_tags` block on `store.steampowered.com/app/<id>/`. `genres` is
  no substitute — 235 of 337 catalogue rows are simply "Action".
- **SteamSpy is not a viable source**, despite publishing the same tags as clean
  JSON. It had tags for 219 of 337 rows and returned `tags: []` for **all 118** of
  the rest, which are overwhelmingly the unreleased and newly released games
  (ARC Raiders, Borderlands 4, Grounded 2, Overwatch) — precisely the rows a
  catalogue with a recent-releases crawl keeps acquiring. Steam's own page has tags
  for every one of them.
- **`is_coop` is set by EXCLUDING PvP genres, never by requiring a co-op tag.**
  `classifyCoop` in `lib/coop.js` carries the numbers; the short version is that
  requiring a co-op tag hid 20 of 42 games this group demonstrably plays together
  (Terraria, Stardew Valley, Elden Ring, Baldur's Gate 3), because 24% of real
  co-op games carry no co-op tag at all. Excluding PvP hid 2, both genuinely PvP.
  Steam's categories cannot help: Apex Legends, Euro Truck Simulator 2 and Terraria
  all report exactly `['Multi-player', 'Co-op', 'Online Co-op']`.

The window is the top **6** tags. Untagged rows (`is_coop IS NULL`) stay *visible*
under the co-op filter — hiding them would empty a freshly crawled catalogue — so a
row with no tag block must be left NULL rather than recorded as "no tags", or the
crawler will never retry it.

## Architecture notes

- **Sessions** are HMAC-SHA256-signed cookies (`lib/auth.js`), 90-day expiry, no
  session table. Rotating `SESSION_SECRET` signs everyone out and loses nothing.
- **Steam OpenID** is verified by posting every callback parameter back to Steam
  with `mode=check_authentication`. Nothing in the callback URL is trusted before
  that returns `is_valid:true`. Removing that check makes login trivially
  forgeable.
- **Scoring is the plain mean, on purpose.** `scoreGame()` returns the average
  and the vote count, nothing cleverer. There used to be a calibrated-and-shrunk
  "weighted" score and the owner removed it: a rating is a judgement, not a
  measurement to be corrected, somebody who has only given 8-10 may simply have
  played good games and may hand the next one a 4, and the number was impossible
  to reconstruct from the column beside it. `n` is surfaced instead, so thin
  evidence is visible rather than silently discounted. `calibrate()` survives but
  only *describes* people on the Stats page — it decides no ranking, and the
  library payload no longer calls it at all.

  Two knock-on effects of that removal, both easy to miss: the Library score filter
  now offers **9+**, because a plain average reaches the top of the scale (group 1's
  best game is 9.5) where the shrunk score topped out around 8.8 and made 9+ come
  back permanently empty; and the landing page no longer advertises calibration,
  which it went on describing for a while after the feature was gone.
- **Seed identities** are rows like `seed:1:ama` in both `users` and
  `memberships` with `is_seed = 1`. `claim.js` repoints their ratings onto a real
  SteamID64 and deletes the placeholder. Order matters in that batch: the real
  membership must already exist before ratings are repointed, or the foreign key
  fires. D1 enforces foreign keys — SQLite does not by default, so tests set
  `PRAGMA foreign_keys = ON` to match production.
- **Routing is hash-based** (`#/g/<slug>/<view>`) so the frontend stays a pure
  static bundle with no server-side rewrite rules. Invite links use a query param
  (`/?join=CODE`) because they must survive the Steam redirect round-trip, which
  drops the fragment.
- **Invite codes** use a 32-symbol alphabet with no `O/0/I/1` so they survive
  being read aloud. The join validator only accepts `[A-Z0-9]{6,24}` — a code
  containing other characters can never be used. `seed.sql` therefore ships
  `invite_code = NULL` (joining disabled) rather than a placeholder string.

## Gotchas already hit

- `wrangler d1 execute --local` and `wrangler pages dev` key their local SQLite
  files differently, so data written by one is invisible to the other. This is
  why `test/harness.mjs` exists instead of a local-D1 workflow.
- `pkill -f harness.mjs` kills the shell running it, because the pattern matches
  the shell's own command line. Use `pkill -f "[h]arness.mjs"`.
- An `aspect-ratio` box that hits `max-height` also shrinks its width, leaving a
  gap. `.rate-media` uses a fixed height for that reason.
- Playwright: use `executablePath: '/opt/pw-browsers/chromium-*/chrome-linux/chrome'`
  rather than downloading a browser. That path is Linux-only, so `test/shots.mjs`
  cannot run on a Mac as written.
- **Steam no longer serves progressive trailer files.** `movies[]` entries now
  carry `dash_av1` / `dash_h264` / `hls_h264` manifests; the old `mp4.max` and
  `webm.max` keys are simply absent, and there is no derivable single-file mp4
  (the DASH manifest is genuinely segmented `.m4s` chunks, and every legacy
  `cdn.akamai.steamstatic.com/steam/apps/<movie_id>/movie480.mp4` path 404s).
  `trailer_url` therefore holds an HLS manifest, played via the vendored hls.js
  in `public/vendor/` — see the note on that in Invariants, including why it has
  to be the full build and not the light one.
- **A `<video>` is not bound by a fixed-height container.** It is a replaced
  element that sizes itself from the stream's intrinsic aspect ratio, and inside
  `.rate-media`'s `place-items: center` a `height: 100%` resolved to 448px in a
  243px box on a short window — the trailer then covered the game's title and the
  first lines of its description. The media children are pinned with
  `position: absolute` and the box clips; do not "simplify" that back to flow
  layout.
- **Autoplay needs a `canplay` retry, not just a `play()` call.** Trailers autoplay
  muted (every browser blocks unmuted autoplay). hls.js attaches its buffer
  asynchronously, so the `play()` immediately after `attachTrailer` usually lands at
  `readyState 0` and rejects — which presents exactly like a blocked autoplay: muted,
  loaded, paused at 0:00. `playTrailer` therefore retries once on `canplay`. The mute
  choice is remembered for the session, so unmuting once carries through the queue.
- **Do not trust `canPlayType` for HLS.** Chromium answers
  `canPlayType('application/vnd.apple.mpegurl')` with `"maybe"` — truthy — while
  being completely unable to play HLS. `attachTrailer()` therefore tries
  `Hls.isSupported()` *first* and only falls back to native playback for iOS
  Safari, which has real native HLS but no MSE for hls.js to use. Reversing that
  order produces a video element that silently never starts in Chrome.
- **A seeded instance cannot be entered through the product.** `seed.sql` ships
  `invite_code = NULL` (joining disabled) and group 1's only owner is the
  placeholder `seed:1:ama`, which can never log in — so there is no member who
  can rotate the code and no link to join with. The first real human has to be
  let in out-of-band, once:
  `wrangler d1 execute g4m1ng --remote --command "UPDATE groups SET invite_code='<10 chars from ABCDEFGHJKLMNPQRSTUVWXYZ23456789>' WHERE id=1"`,
  then `/?join=CODE` → claim prompt. Signing in without that lands you in the
  "you're not in a group yet" onboarding, where creating a group silently makes a
  *second*, empty one (`g4m1ng-2`) instead.
- `showOnboard()` and the members panel read `state.me.displayName` with no null
  guard, and the `hashchange` listener calls `openFromHash()` without checking
  whether anyone is signed in. A hash change while `state.me` is null therefore
  throws and renders a headless "Welcome," card. Not reachable by a normal
  signed-out visitor (boot catches the 401 and shows the landing page before any
  hashchange fires), so it is latent rather than urgent.
- **`npm run setup` is only re-runnable up to a point.** The seed and
  recommendations imports are nested inside the "schema did not exist" branch, so
  a run that dies after the schema is applied can never offer them again; the
  re-run sees existing tables and only offers to wipe. Import them by hand with
  `wrangler d1 execute --remote --file=./seed.sql` instead of accepting the wipe.
- **`wrangler pages deploy` infers the branch from git.** Anything other than the
  production branch silently becomes a preview deploy reading a *different* set
  of secrets, so it boots without `SESSION_SECRET` and reports success anyway.
  `scripts/setup.mjs` now pins `--branch main`; do the same for any manual deploy
  from a feature branch, or use `npm run deploy` from `main`.
- **A single `SELECT` of every `tags` column is too big for the D1 HTTP API.** It
  fails with a Cloudflare API error rather than a truncated result.
  `scripts/reclassify-coop.mjs` chunks on `appid % N` for that reason.
- **A store page served without cookies is an age gate, and an age gate has no
  tags.** `STORE_HEADERS` sends `birthtime=0; mature_content=1`. Without it the
  affected games silently come back untagged rather than erroring.
- **Do not extract the tag block with a lazy `[\s\S]*?</div>`.** `glance_tags` first
  matches the wrapper, and the nearest `</div>` closes the *label* div that precedes
  every anchor — so the match is a window containing no tags at all, and the parse
  returns empty for every game. `parseStoreTags` anchors on
  `class="glance_tags popular_tags"` and takes a fixed byte window instead.
- **A tiebreak has to be smaller than the number it is displayed beside.** The
  recommender's popularity term originally spanned 0.14–0.50 against fit values of
  roughly ±0.4, so it silently reordered genuine matches and the visible fit column
  read 0.23, 0.23, 0.25, 0.23. See `POP_WEIGHT`.
- **`wrangler d1 execute --json` prints human-readable preamble before the JSON.**
  Every script here slices from the first `[` rather than parsing the whole stream.

## State

**Live at <https://coopqueue.pages.dev>** (Cloudflare account
amadeus.magrabi@googlemail.com, Pages project `coopqueue`, D1 `g4m1ng` =
`f16e7e1e-e2c3-463b-b1e4-158bc961de92`, committed into `wrangler.toml`).
`SESSION_SECRET` and `STEAM_API_KEY` are set on the **production** environment
only; the preview environment has neither, so a preview deploy boots with no
session support. `ALLOWED_STEAM_IDS` is unset, so anyone can sign in and create
their own groups.

A second Worker, **`coopq-crawler`** (`crawler/`), binds the same D1 and keeps the
catalogue fresh on an hourly Cron Trigger. It is a Worker and not a Pages
Function because **Pages Functions cannot carry Cron Triggers**. Registering any
cron also requires the account to have a workers.dev subdomain, which is created
by opening the Workers page in the dashboard once — until that happens the script
uploads but the schedule is rejected with error 10063.

Group 1 `g4m1ng` holds 114 games (92 seeded + 22 recommendations) and 232
ratings. **Ama is claimed** by SteamID64 `76561198049961191` (owner, 77 ratings
repointed). Leo (48), Pat (82) and Dave (25) are still unclaimed seeds, but each
now has a `seed_assignments` row (migration 007), so they will be claimed
automatically the first time they sign in — no prompt.

The catalogue holds 337 games with real review counts, **all 337 tagged** from
Steam store pages, of which 9 classify as PvP-primary and are hidden by the default
co-op filter: Rainbow Six Siege, Apex Legends, Marvel Rivals, Overwatch, THE FINALS,
SMITE 2, Enlisted, F1 25 and PvZ Garden Warfare 2. The crawler re-ranks only
once every row has a `review_count`; a handful are still NULL, so the seeded ranks
stand until the cron fills them in, then re-ranking takes over by itself. `/enrich`
has been run to completion: **87 of 114 games linked, all 87 with a trailer and
header art**; the remaining 27 were too ambiguous to auto-match and need linking
by hand from the Library.

There is also an empty group 2 `g4m1ng-2` — an artifact of signing in before the
seeded group was enterable (see the bootstrap gotcha below). Safe to delete.

Neither `d1 create` parsing nor the `d1 list --json` branch turned out to be the
problem. What actually broke is in the git log for `e06be5f`; the short version
is that no unresolved import can be caught locally (no build step, and
`test/isolation.mjs` does not import `functions/api/steam/search.js`), so
`npm run deploy` is the first thing that ever type-checks the bundle.

114/114 assertions pass. `npm run test:ui` does **not** run on macOS: it
imports `playwright`, which is not in `package.json`, and hardcodes a Linux
Chrome path (`/opt/pw-browsers/…`) from the container it was written in.

Steam-link coverage is **105 of 114**. The 9 that remain have no usable Steam page
and are the reason the manual-add path exists: Valorant (Riot client only), Rocket
League (left Steam for Epic in 2020), Spellbreak (servers shut down, page gone),
Overwatch 2 and Diablo 4 (search returns edition/season packs, not the game),
Farming Simulator (which one?), Supervive, Sea of Thieves: Monkey Island (an
expansion, not an app) and Schach — German for chess, never on Steam at all.
`scripts/fix-game-names.mjs` fixed the other 18, which were only ever spelling
mismatches the conservative enrich matcher would not guess at.

Verified end to end against production: Steam sign-in (display name and avatar
resolve, so `STEAM_API_KEY` works), `POST /api/groups/join`, claiming a seed
identity, `PATCH /api/g/:slug/members {invite:'on'}` to rotate the invite link,
`/enrich`, and a trailer playing in the rating queue in **Chromium** — the
browser that could not play one before hls.js.

## The agreed v2 shape

The pool model, decided with the owner: a **global** co-op library that is
browsable and searchable, ranked by popularity; each group pulls games it cares
about into its own pool, and **only pool games generate rating nudges**. That
opt-in step is what stops a big library from destroying rating coverage — the
denominator stays curated per group. New groups start empty; group 1 is
pre-filled because its 114 games already are the pool.

Mapping onto what exists: `games` is already per-group with
`UNIQUE (group_id, steam_appid)`, so **it is the pool** — no new group-scoped
table, and the tenancy boundary is untouched. The global side is `coop_apps`,
alongside `steam_apps` (**built**; see `schema.sql` for the columns it actually
has, which now include `tags`, `is_coop` and `release_ts` that this plan did not
anticipate — the cap column is `max_players`, not `verified_max_players`).

Discovery works, with three traps that `scripts/crawl-coop.mjs` exists to handle.
All three were measured against live Steam, not assumed:

- **`sort_by=Reviews_DESC` sorts by review *score*, not review count.** It ranked
  a 534-review DLC above Stardew Valley's 1.03 million and happily included
  listings with **zero** reviews. Using it as a popularity proxy — an earlier
  version of this file recommended exactly that, wrongly — fills the browse
  page with obscurities and buries everything recognisable. Popularity means
  `total_reviews`, fetched per game from
  `store.steampowered.com/appreviews/<appid>?json=1&num_per_page=0`. Discovery
  uses `filter=globaltopsellers`, and a review floor drops unreleased and
  abandoned listings.
- **The co-op search is full of things that are not games**: 141 of the first 398
  hits were DLC, demos or soundtracks. Filtering on `appdetails`' `type` field
  is mandatory, which costs one throttled request per candidate.
- **`max_players` cannot come from the crawl** (invariant #6). The upsert
  deliberately omits it, so a re-crawl refreshes metadata and popularity without
  flattening a verified cap. Unverified caps render as "player count unverified",
  and the fit filter excludes them rather than claiming they fit —
  `test/isolation.mjs` asserts this, because it is the claim that costs someone
  money.

Two Steam calls per candidate at ~1.7s spacing makes a few-hundred-game crawl a
**cron that fills in over minutes-to-days, never a button press**. Browsing is
instant because it reads `coop_apps` and never touches Steam.

Verified caps live in the curated list in `scripts/seed-player-caps.mjs`, matched
to appids by name against the crawl output so the appids come from Steam rather
than from memory. Extending it is a one-line edit per game. Ambiguous games
(party size vs dedicated-server size) record the smaller always-true number in
`max_players` and the nuance in `coop_note`; genuinely unclear ones are left out.

Build order agreed with the owner: coverage (**done**) → `coop_apps` + browse/add
UI (**done**) → crawl cron (**done**, hourly) → Steam playtime (**done**) /
achievements → recent-releases button (**done** — the crawler's second discovery
pass) → comments (**done**). Note the Steam stats step depends on every member
setting Steam privacy → *Game details* to Public, **and** unticking the separate
"always keep my total playtime private"; `GetOwnedGames` returns an empty list for
the first and a full list of zeroes for the second.

## Backups and data safety

- **Deploying never touches data.** `wrangler pages deploy` and
  `wrangler deploy` ship code only. The row counts were identical either side of
  deleting an entire Pages project.
- **The one real danger is `schema.sql`**, which opens with `DROP TABLE`.
  `npm run db:init` against production wipes everything. Use `migrations/`.
- **D1 Time Travel** gives point-in-time restore for the last 30 days, on the
  free plan, with nothing to configure:
  `wrangler d1 time-travel info g4m1ng` prints the current bookmark, and
  `wrangler d1 time-travel restore g4m1ng --timestamp=<ISO>` rewinds. This is the
  real safety net, and it covers the wipe case above.
- **`npm run db:backup`** writes a full `.sql` dump locally, also free. Worth
  doing before any migration, since Time Travel cannot outlive its 30-day window.

## Next up, roughly in value order

1. **Rate-limit writes.** Cloudflare Rate Limiting rules are free. Right now the
   only protection is soft caps (20 owned groups/person, 64 members/group, 2000
   games/group) enforced in application code.
2. **Scheduled D1 backups.** A cron trigger running `d1 export`. Free tier has no
   automatic backups; losing the database means losing everything.
3. **Verified player caps, at scale.** Only **55 of 337** catalogue rows have one,
   so most cards read "player count unverified" and the "only ones we can all play"
   filter excludes them — correctly, per invariant 6, but it makes the filter look
   broken. Steam genuinely does not publish a co-op player cap anywhere
   machine-readable: `categories` is the closest thing and it is a yes/no, which is
   why the crawler deliberately never writes `max_players`. **IGDB** is the
   candidate: its `multiplayer_modes.onlinecoopmax` is exactly this number, and the
   API is free with Twitch developer credentials (client id + secret, which the
   owner has to create — nobody has verified its coverage against this catalogue
   yet). Failing that, `scripts/seed-player-caps.mjs` is a hand-curated list and
   extending it is one line per game.
4. **Achievement sync.** `ISteamUserStats/GetPlayerAchievements`, keyed on the
   SteamID64s already stored. Playtime sync is done (see Group hours); this would
   add a "who already owns this" badge and completion figures.
5. **A weekly nudge** (Discord webhook) listing games with fewer votes than the
   group has members. Rating coverage is the app's core problem — in the original
   spreadsheet it ranged from 89% to 27% per person.
6. **Public read-only group pages.** Also the cheapest growth loop the site has.

## Group hours

`games.hours` is a number a human typed and **always wins**. `hours_estimated` is
shown only in its absence, prefixed "≈", with `hours_participants` so a 2-of-4
estimate is visibly weaker than a 4-of-4 one.

The estimate is `min(minutes)` over members who played the game for at least an
hour, and 0 below two of them. Steam exposes lifetime minutes per person and
**nothing about when or with whom** — no session or concurrency data exists in the
public API — so joint time cannot be measured, only bounded: you cannot all have
played together longer than whoever played least. That one rule handles all three
cases the group cared about (solo play scores 0, one member's extra solo hours
cannot inflate it, and a non-participant's zero cannot drag it down).

Corroborated against the group's own hand-typed figures: Valheim ≈67.3 vs 66 typed,
Grounded ≈66.0 vs 67, Raft ≈21.1 vs 21, Green Hell ≈14.2 vs 14.

**Steam has two separate privacy switches and both matter.** "Game details"
controls whether the owned-games list is readable; a further checkbox — "Always
keep my total playtime private, even if users can see my game details" — hides the
minutes while leaving the list visible. One member of this group returns **455
owned games with 0 minutes on every one**, so judging readability by game count
reports him as fine while he contributes nothing. `playtime_sync.played` is the
column that actually decides, and the Group tab names the specific setting to fix.

All three code paths — status, sync and recompute — resolve a placeholder
membership through `seed_assignments`, so a group that imported its history gets
real estimates before its friends have signed in.

## Comments

One thread per game, in `comments`. It replaced the single `notes` textarea, which
was one shared line whoever edited last overwrote. `games.notes` is **kept and
still shown read-only** as "Note from the spreadsheet": it holds imported text
nobody here wrote and nobody should be credited with.

`comments.group_id` is denormalised even though `game_id` implies it, so the
invariant-2 filter is a single-table predicate rather than a join somebody
eventually forgets. Deleting is yours-or-owner. The thread is fetched per game
rather than bundled into the library payload, which is loaded once and filtered
client-side — shipping every comment for every game would grow that for a thread
almost nobody has open.

Ten assertions cover it, four of them the attacks that matter: commenting on,
reading, and deleting another group's thread by guessing a game id, and that the
thread never returns a foreign row.

## "I didn't play this"

`skips.not_played` (migration 016) separates two answers the queue used to conflate:
**"no opinion"** (I was there, nothing to say) and **"I didn't play this"** (I wasn't
in that session). A group of four often plays as two or three, and without the
distinction the people who sat a game out looked like they were failing to rate it.

Both hide the card, which is why it is a column on `skips` rather than a second table
needing the same cascade, tenancy filter and group-scoped delete for one bit.

The bit is load-bearing in exactly one place: **a game you sat out leaves your own
coverage denominator.** "No opinion" deliberately does not — it is still a game you
could rate. That means coverage denominators are now per person, in three places that
must agree: `stats.js`, `renderMyCoverage()` and the Group tab's leaderboard. Seven
assertions cover it, including that "no opinion" leaves the percentage alone and that
a mis-click is fixable by re-posting.

Only offered in **Played** mode. In Want-to-play mode the question is interest, not
memory, so "I didn't play it" is not an answer to anything.

## Statuses, and the table rebuild that added one

`games.status` is `backlog | playing | finished | unfinished | dropped | sampled`.
**`unfinished` means "we tried to finish it and never did"** — not `dropped` (gave up)
and not `sampled` (barely started). It counts as *played*, so it lands in the "how
good was it?" queue and in the played-game stats: `PLAYED_STATUS` in `app.js` and
`PLAYED` in `stats.js` both list it, and they must agree.

**Adding it needed a table rebuild, and the obvious way to do that destroys every
rating.** `status` carries a CHECK constraint, SQLite cannot ALTER one, so the column
list has to be recreated. `DROP TABLE games` then runs an implicit DELETE FROM with
foreign keys enforced, firing `ON DELETE CASCADE` on `ratings`, `comments` and
`skips`.

`PRAGMA defer_foreign_keys = on` looks like the fix and is not: it defers the
*violation check*, while cascade *actions* still fire. Replaying that version over a
real `d1 export` deleted all 242 ratings and then reported **zero** foreign key
violations, because nothing was left to violate anything. `PRAGMA foreign_keys = OFF`
is the documented answer but D1 enforces foreign keys as a platform property, and it
ignoring the pragma would look identical to it working — until the ratings were gone.

`migrations/017-status-unfinished.sql` therefore does not try to stop the cascade. It
copies `ratings`, `comments` and `skips` into stash tables, rebuilds, and restores
them, which is correct whether the cascade fires or not. **Test any future rebuild
the same way**: restore `npm run db:backup` output into a local SQLite file with
`PRAGMA foreign_keys = ON`, replay the migration, and compare row counts *and* a
checksum of the ratings before and after.

## Changing a rating

The queue only ever offers games you have **not** scored, so once you rated something
there was no route back to it. The Rate tab has a third mode, **Already rated**, which
lists them in name order and opens the slider on *your* current score rather than the
group average — that number is the thing you came to change. Saving advances to the
next one, because the list does not shrink underneath you and a card that just sits
there looks like it failed to save.

It is never auto-selected when another mode empties: it is somewhere you go on
purpose, not a backlog. The skip buttons are hidden there — "no opinion" on a game you
have scored is not an action, and `rate.js` has always been an upsert, so nothing
server-side needed to change.

## Early Access

`early_access` is computed in the library query from `coop_apps.tags` containing
`"Early Access"` — a single bit rather than shipping the whole tag array for every
game, since the library payload is fetched on every load. It renders as a warning
chip on the rating card and detail panel, an `EA` marker in the Library table, and a
line on catalogue cards.

Checked against real data before shipping: it flags 8 of group 1's games and all 8
are genuinely in Early Access, including four where the tag sits outside the top six
(Subnautica 2, Abiotic Factor, Grounded 2, RuneScape: Dragonwilds) — so the match is
against the whole stored array, not the ranked window `classifyCoop` uses.

The tag is deliberately still in `NON_TASTE` for the recommender: "this ships
unfinished" is worth *warning* about and worthless as a *taste*.

## Imported notes

`games.notes` held text from the original spreadsheet and used to render in a bespoke
read-only box labelled "Note from the spreadsheet" — a field only this group would
ever see, which is exactly how a UI teaches people it is inconsistent.

Migration 019 moves it into the normal comment thread. Authorship was the wrinkle:
`comments.steam_id` is NOT NULL and references `users`, and crediting a real person
with imported text is the thing the old label was avoiding. So each group gets an
`import:<group_id>` row in `users`, following the existing `seed:<group_id>:<name>`
convention for identities that are real rows but can never log in. It gets **no
membership**, so it is not a member, takes no colour slot and never appears in the
group list — and the comments query now falls back to `users.display_name` when there
is no membership, which also improves the genuine "member left the group" case.

`games.notes` is deliberately still populated. Nothing reads it, but keeping it makes
019 reversible. A fresh install that imports `seed.sql` gets notes with no UI, so run
019 after seeding.

## Blind rating

`groups.blind_rating` (migration 013) hides everyone else's scores in the rating
queue until you have voted. It is a **group** setting, owner-only, and not a
personal preference — one person rating blind while the others see the numbers
achieves nothing, so a per-person toggle would be a setting that does not do what
its name says. Default off. Three assertions: the default, the owner can set it, and
a plain member gets 403 with the column unchanged.

## Who added a game

`games.added_by` is stamped automatically on anything added through the site, and is
editable by hand from the game's detail panel — necessary rather than nice, because
an imported library has it on almost nothing (1 of 115 rows for group 1). It renders
as a chip on the rating card and in the detail panel, and **only when the id resolves
to a current member**: "Added by Someone" is worse than saying nothing.

It is validated against `memberships` in the PATCH handler rather than riding along in
`EDITABLE`, because the value is displayed as a person's name — an unchecked write
would let a member paint any SteamID64, including another group's member, onto their
own rows.

## Play dates

`games.started` and `games.finished` are ISO dates typed by a human and, like `hours`,
they always win. `games.finished_estimated` is derived.

**Steam cannot tell you when a group started a game.** `GetOwnedGames` returns
`playtime_forever` and `rtime_last_played` and nothing else time-shaped — checked
against the live API, whose per-row keys are exactly `appid, name, playtime_forever,
img_icon_url, playtime_windows/mac/linux/deck_forever, rtime_last_played,
content_descriptorids, playtime_disconnected`. No first-played, no acquired, no
purchase date. So a start date is manual, always, and the UI says so rather than
leaving people hunting for a sync button that cannot exist.

The **end** is partly derivable. `finished_estimated` is the **latest**
`rtime_last_played` across participants — a `max`, where the hours estimate is a
`min`.

**But Steam only returns `rtime_last_played` for the account that owns the API key.**
Measured on this group: Pat has 188 played games visible and **zero** last-played
timestamps, Dave 23 and zero, while Ama — whose key it is — has all 98. Playtime and
last-played are separate privacy facets, and the second is simply not exposed for
other people. There is no setting the others can change to fix it.

So this has **no two-person floor**, unlike hours: requiring two would make it
permanently null for every group. That means it is *not* "when the group finished" —
it is the latest play date we can see, which is a good prompt for typing the real one,
and the UI says exactly that rather than dressing one person's timestamp up as the
group's. Shown only when nobody has typed `finished`.

## The Library's default view

`LIB_DEFAULTS` in `app.js` is the single definition, and the default sort is
**Recently started**: the Library doubles as the group's history, and what you most
often want from it is what you have been playing lately. Games with no start date sort
to the bottom and keep best-first order among themselves — without that fallback a
library nobody has dated yet (which is every library, at first) opens looking randomly
shuffled.

The defaults are re-established when you arrive at the Library **from another view**,
and deliberately not on a same-view re-render: the detail dialog re-renders the
current view on save, and having that silently undo your sort would be maddening. The
Reset button appears only when something deviates, so it is a way back rather than a
permanently lit control that usually does nothing.

## Recommendations, and the co-op filter

"Recommended for us" is the default sort on **Find new games**. The ranking is
`lib/recommend.js` — a pure function, shared with `test/harness.mjs` so the local
ordering is the shipped ordering — behind
`functions/api/g/[slug]/recommend.js`.

**Why it is a separate route and not `sort=fit` on `/api/coop`.** The catalogue
endpoint is deliberately group-blind: no slug, no membership read, nothing
group-scoped, asserted by two tests. Ranking needs the group's ratings, so it has
to sit *below* the tenancy boundary. Bolting it onto `/api/coop` would put library
data behind an endpoint with no tenancy check at all. Both routes select
`CATALOGUE_COLS` and apply the same filters, so the card shape and the eligible set
do not change when you switch sort order.

How it ranks: per-tag preference is the group's mean score for library games
carrying that tag minus the group's overall mean, shrunk by `n/(n+3)`. Below five
rated games it does not pretend — it returns `basis: 'popularity'` and the UI says
so.

**Two guards, both added because the first run against real data was bad.** With
`TAG_MIN_GAMES = 2` and no stoplist, group 1's second-strongest "preference" came
out as **Early Access** at +0.51 off three games, and it drove five of the top ten
suggestions — a list of unreleased games nobody has heard of (Windrose, Species:
Unknown, SpaceCraft). Two changes fixed it:

- `NON_TASTE` drops tags describing how a game *ships* rather than how it plays:
  Early Access, Free to Play and similar. Deliberately narrow — generic genre tags
  like "Multiplayer" stay, because they sit on nearly every row and so contribute
  almost equally to every candidate and cannot reorder anything.
- `TAG_MIN_GAMES` is **3**. At 2, a coincidence reads as a taste.

A third guard, added after reading the live output again: **tag preferences are
weighted by inverse document frequency**. Without it every tag on a candidate counts
equally, so the common ones win by sheer commonness — "Exploration" and "Open World"
outvoted "Souls-like" and put four driving simulators (Euro Truck, American Truck,
SnowRunner, Need for Speed Payback) in group 1's top ten, for a group whose single
strongest signal is Souls-likes. `log(N/df)` is 0 for a tag on every row and grows as
a tag gets rarer, so specific tags decide the order and generic ones only break ties.
Afterwards the top of the list is Stranger of Paradise, ELDEN RING NIGHTREIGN, Nioh 3,
Rise of the Ronin and CODE VEIN, and the driving sims are gone.

`NON_TASTE` also covers **camera perspective** ("Third Person" scored +0.29 and was
dragging in racing games) and **PvP genres**, which are incoherent as a reason for a
suggestion in a catalogue already filtered to co-op — "Wingspan — matches your taste
for Building and PvP" was a real card.

Afterwards the same group's top tags are Souls-like, Action RPG, Building and Open
World (that last on 22 games), and the suggestions are recognisable: Stormworks,
Stronghold Crusader, Nioh 3, ELDEN RING NIGHTREIGN. Check the output against real
data after touching any of this — the tests cannot tell you the ranking is *useless*,
only that it is self-consistent.
The response carries `why` (the two tags that drove each card), `likes` and
`dislikes`, and the UI shows all of them: a list labelled "recommended" that will
not say why is asking for trust it has not earned.

**`POP_WEIGHT` is 0.02 and the magnitude is load-bearing.** Raw
`1/log10(10 + reviews)` spans ~0.14–0.50 while fit spans roughly ±0.4, so
unweighted it does not break ties, it reorders real ones — the first run produced a
list whose own fit column read 0.23, 0.23, 0.25, 0.23. At 0.02 the term stays below
the resolution of the fit the card displays, so visible fit always wins and
popularity only separates games that look equally good. An assertion checks the
displayed column is descending.

The **Co-op only** toggle is on by default and filters on `is_coop` — see invariant
7 for why that flag is computed by excluding PvP genres, and why untagged rows stay
visible rather than being hidden.

## Archiving, not deleting

Removing a game sets `games.archived_at` instead of deleting the row. Any member
can do it, and that is only safe *because* it destroys nothing: a real DELETE
cascades away every rating anyone gave the game, and ratings are the one thing here
that cannot be recreated. Archived games drop out of the rating queue, Play next,
the stats and coverage denominators, and reappear under Library → Archived, where
restoring clears the column and brings the whole history back.

There is deliberately **no hard-delete endpoint for a game**. If a group genuinely
wants data gone, deleting the group does that and says so plainly.

Anything counting the library must filter on `archived_at IS NULL` — the queue,
stats, coverage bars and Play next all do, and `isActive()` / `activeGames()` in
`app.js` exist so the client cannot forget.

## Brand assets

`public/brand/` is **generated** by `scripts/build-brand.py`, not hand-drawn. Re-run it
when the logo changes: `python3 scripts/build-brand.py path/to/logo.png`. Two decisions there are load-bearing:

- **The favicons and app icons keep a dark field rather than transparency.** The
  three figures inside the controller are white, so a transparent icon leaves them
  invisible against light browser chrome — only the controller outline survives.
- **The lockup's transparency comes from a luminance ramp, not a colour key.** The
  source is bright content on a near-black field (luminance ~17; the darkest part of
  the gradient is ~125), so a ramp between the two separates them while leaving
  antialiased edges as partial alpha. A hard colour match leaves a staircase, and
  keying to one exact RGB value misses the compression noise around the glyphs. It
  composites cleanly on both `--plane` (#0d0d0d) and the lighter card surfaces.

`logo.png` is 448×96 — 3× a 26–30px display height, not the full-resolution crop,
which was 116 KB for a mark nobody sees above 30px. On screens under 560px the
topbar clips the lockup to the controller with `object-fit: cover`, because the
wordmark, the group switcher and the tab row cannot share one line.

The source image had a generator watermark in its bottom-right corner. It sits
outside the lockup's bounding box, so the tight crop removes it — but check for one
when regenerating from a new source.

**The name is settled: CoopQueue.** It matches the logo and the host, and the old
"CoopQ" is gone from every comment, file header and user-agent string. The three
`g4m1ng` identifiers are untouched and still deliberate — see The name at the top of
this file.

## Vocabulary

One word per concept, because two words for one thing is how a UI stops making
sense:

- a group's collection of games is its **library** (the `games` table). "Pool" was
  used interchangeably for a while and has been removed — it meant the same thing.
- the global catalogue of co-op games on Steam is the **catalogue** (`coop_apps`),
  surfaced in the UI as **Find games** rather than "Browse", which read as a
  synonym for Library.

**Group names are deliberately not globally unique.** Enforcing that would turn
rename into an oracle for the existence of private groups, which is precisely what
the 404-not-403 boundary prevents — you could sit typing names and learn which are
taken. What *is* refused is a name colliding with another group **the caller is
already in**: that is information they already have, and without the check their
group switcher shows two identical entries. Renaming never touches the slug, so
URLs and invite links already handed out keep working.

## Conventions

- Comments explain *why*, not *what*. Several exist specifically to stop a future
  editor "simplifying" a security check — leave those.
- Two-space indent, single quotes, semicolons. No TypeScript, no dependencies at
  runtime; `wrangler` is the only devDependency.
- Commit messages: short imperative subject, then a paragraph on the reasoning
  where it isn't obvious.
