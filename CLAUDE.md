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

The product is **CoopQueue**, live at **<https://coopqueue.app>**. The Pages project
is `coopqueue`, with `coopqueue.pages.dev` retained as its deployment host; the old
`g4m1ng` project has been deleted and that URL is gone. `coopq.pages.dev` was not
available — `*.pages.dev` names are globally unique across all Cloudflare accounts,
and `coopq` is taken by someone else.

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
npm test                 # 190 tenancy/permission/scoring assertions — ALWAYS run before deploying
npm run test:ui          # renders every screen headless — does NOT run on macOS, see State
npm run db:backup        # wrangler d1 export — D1's free tier has NO automatic backups
node test/harness.mjs    # local UI dev server; SCENARIO=anon|fresh|claim|member

npm run db:migrate -- --file=./migrations/001-coop-apps.sql   # apply one migration
npm run crawl:coop -- --pages 8 --out migrations/002-coop-seed.sql
node scripts/seed-player-caps.mjs --from migrations/002-coop-seed.sql \
                                 --out migrations/003-player-caps.sql
TWITCH_CLIENT_ID=... TWITCH_CLIENT_SECRET=... npm run measure:caps -- \
  --from migrations/002-coop-seed.sql --out igdb-cap-coverage.json

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
`DROP TABLE`, so applying it remotely to an existing database wipes every group and
rating. The old remote `db:init` shortcut was removed to make that mistake harder.
Anything that has to reach an existing database goes in `migrations/` as
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

**3. Steam metadata goes through cache-first helpers in `lib/steam.js`, never a
raw route fetch.** Full records use `getAppDetails(db, appid)`. The selective
wishlist preview may use `getAppSummaries(db, appids)` to resolve one bounded page
of names and artwork in a single store-browse request. Those partial cache rows
have `fetched_at = 0`, so they never suppress authoritative full enrichment.
Steam's store endpoints throttle at roughly 200 requests / 5 min *per IP*, and
Workers egress from a shared pool — this cache is the only reason the site can
have more than a handful of groups.

Root middleware enforces per-account fixed-window limits: 30 Steam searches per
minute, 20 Steam-backed writes per five minutes, and 60 other writes per minute.
Migration 020 creates the compact `rate_limits` table these checks require. JSON
request bodies are capped at 32 KB and outbound Steam calls time out after 10
seconds; keep both bounds when adding routes.

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
  Steam's categories cannot distinguish PvP from co-op: Apex Legends, Euro Truck Simulator 2 and Terraria
  all report exactly `['Multi-player', 'Co-op', 'Online Co-op']`.

The PvP window is the top **6** tags. The singleplayer exclusion checks the full
retained tag list, with Steam modes allowed only to rescue multiplayer evidence
missing from older truncated lists. Untagged rows (`is_coop IS NULL`) stay *visible*
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

**Live at <https://coopqueue.app>** (Cloudflare account
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
SMITE 2, Enlisted, F1 25 and PvZ Garden Warfare 2. Browse and thin-history
recommendations order directly by `review_count`; do not refresh the legacy
`popularity_rank` column after crawls, because ranking the whole catalogue hourly
is a quadratic D1 read workload. `/enrich`
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

190/190 assertions pass. `npm run test:ui` does **not** run on macOS: it
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

Direct invitations are a second, explicit join path. Only a co-op workspace owner
can search registered `users` and create one; placeholders and existing members are
excluded. A `group_invites` row is not membership, so the group middleware still
returns 404 until the named SteamID64 accepts through `/api/invites`. Accepting uses
the same 64-member ceiling and post-insert `applySeedAssignment()` path as an invite
code. Reject and owner cancellation retain an auditable terminal state. Converting a
one-person group to personal cancels any pending invitations.

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
UI (**done**) → crawl cron (**done**, hourly) → Steam playtime/ownership (**done**) →
per-game achievement relay (**done**) → Play Night + exports (**done**) →
recent-releases button (**done** — the crawler's second discovery pass) → comments
(**done**) → Complete our history (**done**). Note the Steam stats step depends on every member
setting Steam privacy → *Game details* to Public, **and** unticking the separate
"always keep my total playtime private"; `GetOwnedGames` returns an empty list for
the first and a full list of zeroes for the second.

## Backups and data safety

- **Deploying never touches data.** `wrangler pages deploy` and
  `wrangler deploy` ship code only. The row counts were identical either side of
  deleting an entire Pages project.
- **The one real danger is `schema.sql`**, which opens with `DROP TABLE`.
  Applying it to an existing remote database wipes everything. The old remote
  `db:init` shortcut is deliberately gone; use `migrations/`.
- **D1 Time Travel** gives point-in-time restore for the last 30 days, on the
  free plan, with nothing to configure:
  `wrangler d1 time-travel info g4m1ng` prints the current bookmark, and
  `wrangler d1 time-travel restore g4m1ng --timestamp=<ISO>` rewinds. This is the
  real safety net, and it covers the wipe case above.
- **`npm run db:backup`** writes a full `.sql` dump locally, also free. Worth
  doing before any migration, since Time Travel cannot outlive its 30-day window.

## Next up, roughly in value order

1. **Scheduled D1 backups.** A cron trigger running `d1 export`. Free tier has no
   automatic backups; losing the database means losing everything.
2. **Verified player caps, at scale.** Only **55 of 337** catalogue rows have one,
   so most cards read "player count unverified" and the "only ones we can all play"
   filter excludes them — correctly, per invariant 6, but it makes the filter look
   broken. Steam genuinely does not publish a co-op player cap anywhere
   machine-readable: `categories` is the closest thing and it is a yes/no, which is
   why the crawler deliberately never writes `max_players`. **IGDB** is the
   candidate: its `multiplayer_modes.onlinecoopmax` is exactly this number. The
   measurement-only `scripts/measure-igdb-caps.mjs` maps the Steam catalogue,
   rejects multiple matches and conflicting platform caps, and writes a JSON
   coverage report without touching D1. It needs confidential Twitch credentials;
   none are configured locally, so no real coverage result exists yet. Even a
   `usable-candidate` is input to human verification, never an automatic write.
3. **A weekly nudge** (Discord webhook) listing games with fewer votes than the
   group has members. Rating coverage is the app's core problem — in the original
   spreadsheet it ranged from 89% to 27% per person.
4. **Public read-only group pages.** Also the cheapest growth loop the site has.

## Group hours

`games.hours` is either a human answer or an explicitly accepted estimate snapshot,
and **always wins**. Provenance keeps the latter visibly approximate. The live
`hours_estimated` is shown only in its absence, prefixed "≈", with
`hours_participants` so a 2-of-4 estimate is visibly weaker than a 4-of-4 one. Once
accepted, it no longer borrows a later sync's participant count: it is labelled as
a snapshot instead.

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

Ownership uses the same `playtime` rows but is deliberately three-state. A row is
positive proof of ownership, including zero-minute games. Absence only becomes
"not owned" when `group_library_sync` proves that this exact group was synced after
the game was linked; private, missing and stale libraries remain unknown. The old
`playtime_sync` watermark is account-global and cannot prove this because each run
stores only the launching group's games. Reusing it across groups creates false
negatives, which is why migration 021 adds the group-scoped watermark and existing
groups need one fresh sync before negative ownership appears.

## Attendee filtering on Play next

The old Play Night card over-constrained the answer: 57 of group 1's games had no
human-entered minimum session length, so its default button honestly but uselessly
returned zero. Available minutes and the separate build step are gone. Attendee
chips now sit directly above the backlog and update the list immediately. Ranking
is the plain mean of only the selected people's ratings, with vote count visible.
A verified cap below that crew is excluded; an unknown cap stays in the list and is
labelled unknown rather than being treated as either a fit or a failure. Both the
ranked and too-small lists use the cached Steam header art already returned with the
library data; they do not make another metadata request.

For publishable screenshots, run `MARKETING=1 node test/harness.mjs`. It keeps the
realistic `g4m1ng` game and rating fixture while replacing group/member display
names with neutral identities. Linked games derive their header image from their
real Steam appid; unlinked legacy rows retain the generic fallback. It also hides
the signed-in member's Complete our history prompt so the reusable Library image
stays focused on the shared data rather than one person's housekeeping. The first
Rate card uses PEAK's static header and matching fixture copy instead of the generic
Back 4 Blood trailer used to exercise video playback in ordinary harness sessions.
Do not capture
the production group directly or commit its private comments, invite code, account
identifiers or avatars.

`POST /api/g/:slug/play-night` retains the same attendee-specific semantics for API
callers and accepts 1–64 group members, which also supports personal workspaces. It
does not persist session state.

## Exports and achievements

Only an owner can read `/api/g/:slug/export`. JSON is the lossless, versioned bundle
of group, games, ratings, comments, members and shared-history provenance; CSV is
one relation per download. Version 2 adds the `history` relation. Personal dismiss
and snooze choices are deliberately not exported: they are UI state, not group data.
CSV text beginning with a spreadsheet formula character is prefixed with an
apostrophe, while JSON keeps the exact source text. Response serialization streams
each row so a large group does not allocate a second group-sized output string.

Achievements are also bounded on purpose. Opening a game detail lazily syncs only
the signed-in member for that one Steam app through `GetPlayerAchievements`, and
refreshes rows older than seven days; it never launches a members × games crawl.
The manual button remains as a retry. HTTP 400 responses are parsed because Steam
uses them for meaningful negatives such as private or unavailable achievement data;
they must not be collapsed into "Steam did not answer". `achievement_progress` is global by SteamID64/appid, while
the GET view is group-scoped through the requested game. The Trophy relay shows the
union unlocked, per-person progress, fresh unlocks and (only when every resolvable
account has synced) achievements one member short or unanimous. Steam privacy and
games with no achievements are explicit states, not zero progress.

Personal workspaces also expose `POST /api/g/:slug/achievement-scan`. One request
checks at most four non-backlog games and the browser persists the last game id as
a resumable cursor. A click makes at most three such requests. Failures advance the
cursor rather than trapping every later game behind one private title; no negative
row is cached as a confident zero. The Stats completion suggestions come from the
exact `(appid, achievement key)` allowlist in `lib/completion.js` and always require
a human click before changing `sampled` to `finished`. The same suggestion is shown
as **Likely finished** in the Library and game details, while the stored status stays
`sampled` until confirmed. The scan also saves the earliest unlocked achievement as
an approximate first-played boundary, with `achievement` provenance, after rejecting
future dates and dates outside a known release/end interval.

Do not diagnose every `GetPlayerAchievements` 403 as a dead site key. Measured on
production, the same key successfully completed all four `GetOwnedGames` library
syncs while `ISteamUserStats` refused PEAK; the signed-in profile's public Steam
Community XML returned the game's full achievement list at the same time. But that
XML's `privacyState=public` covers only the profile: for Abiotic Factor it marked all
53 locked while the same account's signed-in Steam page showed 10/53. On a 401/403,
`playerAchievements` therefore uses the Community view only when it contains at
least one positive unlock (or a genuinely empty achievement list). An all-zero list
is ambiguous, stays unsynced, and invalidates an older cached zero rather than
turning hidden data into 0%. The documented JSON Web API remains first because the
older Community view is not a complete replacement.

## Personal workspaces

`workspace_settings.mode` is explicit (`coop | personal`), with a missing row
meaning co-op for every pre-024 group. Never infer this from member count: a new
co-op group also has one member before its invites are used. Migration 024 creates
the side table rather than altering `groups`, keeping the migration idempotent.

A personal workspace is still a group of one internally, so the tenancy boundary,
library, ratings, archive/restore, comments, exports and history provenance all stay
on the existing code paths. It has `max_players = 1`, no invite link, and hides
coverage leaderboards, member comparisons, blind-rating controls and empty Stats
panels. Its Library presents the sole member score as one Rating column rather than
repeating Players, member, Avg and Votes columns that all describe the same person.
Stats and Complete our history use that account's Steam playtime directly.
A one-member co-op group can be converted in Settings; a multi-member group must
remove the others first, and conversion is a transactional D1 batch.

`sampled` is labelled **Sampled** in both personal and co-op workspaces. The same
stored state must not change vocabulary when switching groups. Migration 026 uses
this neutral outcome for Steam imports because playtime proves a launch but not an
ending; migration 027 promotes only games with explicit terminal-achievement
evidence. Backlog remains the known zero-hour outcome. Lifetime Steam minutes are
stored as hours rounded to one decimal, and achievement dates remain approximate
first/last-played evidence. The evidence rules and repeatable import procedure live
in `docs/PERSONAL_STEAM_HISTORY.md`; both migrations are idempotent and preserve
newer user edits.

`POST /api/g/:slug/steam-import` works in both workspace modes and has three bounded actions.
`preview` reads `GetOwnedGames` and the public wishlist, then returns 250 untracked
titles at a time with owned/wishlist source filters plus Co-op / Multiplayer / Solo /
Unknown classification. Personal workspaces enable all four by default; co-op workspaces
start with Co-op only. Catalogue verdicts are re-derived from cached tags and modes
when tags exist, so a stale `is_coop` flag cannot override newer classifier logic.
Catalogue tags take precedence over `steam_apps.tags`; ranked lists are never
concatenated. Outside the catalogue, explicit tags or modes establish a type;
missing evidence stays Unknown. Full Steam metadata retains the Single-player
mode so an explicitly solo game can be distinguished from an unclassified one.
A negative co-op verdict alone proves neither multiplayer nor solo. Preview does
not rewrite saved flags or group games. This classification is only a review filter.
It never writes or claims a
player cap. Selecting a source or type in the UI
loads all of its pages, while the initial combined view keeps an explicit Load more
control. Wishlist ids get cache-first names and art through bounded 50-app
`getAppSummaries()` requests. `import` re-fetches both sources, intersects at most
250 requested appids with that union, and writes only to `data.group.group_id`; the
browser chunks a larger reviewed selection into those batches. `enrich` resolves at
most eight known appids through `getAppDetails()`. That second server-side
intersection is a security boundary: the
browser cannot use the bulk endpoint to inject arbitrary Steam apps or another
group's rows. Archived games count as already tracked, so the unique
`(group_id, steam_appid)` row is preserved. Wishlist-only imports do not advance
the owned-library watermark or manufacture ownership negatives. The import stores
`steam-hours` and `steam-last-played` provenance when Steam provides them. It copies
a player cap only when the global catalogue already carries a non-NULL verified
source; unknown caps stay unknown rather than being inferred from unreliable store
categories. It already refreshes playtime and ownership, so the browser does not
repeat that call. After any import it automatically runs at most three eight-game
metadata passes. Personal workspaces also run three four-game achievement passes,
which can add approximate first-played boundaries and completion suggestions. The
manual Settings controls resume or retry anything left over. Bulk achievement
analysis remains personal-only; co-op workspaces use the existing bounded
per-member, per-game Trophy relay instead.

## History-shaped stats

The Stats page's **Library shape** counts every active game by the six stored
statuses. Its **Genres** panel is one view with Games / Hours / Rating controls,
not three near-identical permanent charts. "Played" there means a settled outcome:
`finished | unfinished | dropped | sampled`, matching the existing genre track
record rather than quietly adding the still-moving `playing` rows.

Hours use the same trustworthy value as the other Stats totals: saved group hours,
or the signed-in account's synced Steam time in a personal workspace. Live group
estimates are suggestions until somebody accepts one, and missing hours stay NULL;
the genre chart reports `hoursGames / games` coverage rather than adding zeroes.

**Gaming over time** counts recorded ISO start dates for every non-backlog game and
recorded finish dates only for games whose status is `finished`. It reports both
coverage denominators because sparse history is still useful but must not look
complete. **Time versus enjoyment** needs six played games with both hours and a
rating before it appears. Its hovered or keyboard-focused point must lift its whole
stacking context above the neighboring points; raising only the tooltip pseudo-element
cannot escape the point's own stacking layer. The custom tooltip uses `aria-label`
without a duplicate native `title` tooltip. `lib/stats.js` owns these aggregations and
is shared with the harness so the local UI cannot drift from the deployed route.

**Who agrees with whom** treats the closest and furthest pair as a summary: their
cards share a row when space allows, then a labelled and deliberately separated
detail list ranks every eligible pair. On narrow phones the summary cards stack
before that list instead of squeezing their labels into two thin columns.

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

Comment deletion uses an app-owned modal rather than `window.confirm`, whose
browser-controlled heading adds "The page at … says" (or its localised equivalent).
Cancel receives focus by default; Cancel and Escape preserve the comment. Every
opening resets the result, so Escape cannot reuse a prior Delete approval. The
pending action is cancelled if game details close and checked against the original
workspace/game before sending DELETE. Server-side yours-or-owner checks still decide
permission.

Ten assertions cover it, four of them the attacks that matter: commenting on,
reading, and deleting another group's thread by guessing a game id, and that the
thread never returns a foreign row.

## Group activity

Migration 036 creates `group_activity`, `activity_reads`, their indexes and capture
triggers. Apply it before deploying the activity API. There is no history backfill.
Games and ratings remain the source of truth; event rows contain actor, game and
kind plus old/new statuses when relevant, never scores, rating explanations,
replay answers or comment bodies. Blind-rating settings therefore cannot leak
through either the badge, feed or stored activity data.

Game inserts (including Steam import batches), changed scores and posted comments
are captured by database triggers in the write's own transaction. Equal score
upserts, seed reassignment and Steam enrichment stay quiet. Status changes have a
known actor only in the PATCH handler: `statusActivity()` is inserted before the
game UPDATE in the same D1 batch, reading the real old status and skipping equal
values. Capture requires a real group membership and skips personal workspaces.
Deleting a comment cascades its activity away. Group/game deletion cascades events;
leaving a group cascades only that member's read cursor. Activity older than 90 days
is hidden and pruned on that group's next activity insert using an indexed range.

`GET /api/g/:slug/activity` captures the group's latest event id, then groups the
snapshot by actor, kind and fixed ten-minute window. Ratings and additions span
games; comments and status edits stay per game. The newest 40 groups are returned,
with an unread-group count over the entire 90-day feed, including groups beyond
that display limit. Own actions are excluded. Every event/game/cursor join retains
the group predicate; the existing membership boundary returns 404 to outsiders.

`POST /api/g/:slug/activity {throughId}` acknowledges only a validated id from that
group's observed snapshot, or zero for an empty feed. Cursors advance monotonically
with MAX, so an older tab cannot undo a later acknowledgement and events arriving
after a snapshot remain unread. Event ids use AUTOINCREMENT and must never be reused
after pruning. Opening the panel or clicking a game does not silently mark all read.

The bell sits beside the profile, is hidden in personal workspaces, and updates on
open/focus and once a minute while the tab is visible. Background focus requests
are throttled for 15 seconds. Pending fetches are invalidated on workspace changes
and on acknowledgement; polling pauses during an acknowledgement. A delayed reply
from the prior workspace must never repopulate the new workspace's badge or panel.
Single-game items refresh the library and open game details; multi-game summaries
open the Library. Escape and outside clicks close the panel; Escape restores focus
to the bell. Popup positioning clamps both sides inside the mobile viewport.

The harness uses the same activity queries and status helper, with synthetic recent
actions over its existing games. `PORT=4322 node test/harness.mjs` can run beside an
existing harness. Tests cover isolation, privacy, grouping, snapshots, monotonic and
independent cursors, retention, cascades, imports, and idempotent migration replay.

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
`PLAYED` in `stats.js` both list it, and they must agree. In the Library its status
chip deliberately shares the red treatment with `dropped`: both are negative
outcomes, even though the stored meanings remain distinct.

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

## Gotchas in the client worth not rediscovering

- **A valueless `data-` attribute is the empty string, which is falsy.** The group
  switcher's "+ New group" and "Join with a code" items were checked with
  `if (b.dataset.new || b.dataset.joincode)`, which is never true for `<button
  data-new>` — both fell through to `location.hash = '#/g/undefined/queue'` and
  appeared to do nothing at all. Use `'new' in b.dataset`.
- **The group menu anchors LEFT, not right.** A `max-width: 720px` rule set
  `left: auto; right: 0` to keep it on screen, but the switcher sits near the left
  edge of the topbar, so a 260px menu hung ~114px off the left of a 375px phone.
  It is `left: 0` with `max-width: calc(100vw - 64px)` — the switcher's own offset
  plus a margin — so it cannot overflow the other way either.

## Early access on Play next

`#hide-ea` is **on by default**. Play next answers "what should we start", and an
unfinished game is usually the wrong answer however much the group wants it — the
label alone was not enough, because a high-scoring early access title still sat at
the top of the list. It only leaves that list; the game stays in the library, stays
rateable, and the chip still explains why.

## Skipping is not a one-way door

Reported as a bug and it was one: Subnautica 2 showed on Play next with one rating,
and the person who had skipped it could not find it anywhere in Rate. The queue
excludes what you skipped — that is the point of skipping — but with no score of your
own it was in no other list either, so the game was **unreachable and the skip could
never be undone**. `DELETE /skip` had existed since the beginning and nothing in the
UI ever called it.

The Rate tab now has a **Skipped** mode, hidden unless you actually have skips, which
lists them with which kind each was and offers "Put back in my queue". Rating one
works too — `rate.js` has always deleted the skip on rating, so scoring it from there
resolves both at once.

The library payload carries `mySkip` (`'no-opinion' | 'not-played' | null`) for the
**caller only**, alongside the group-visible `notPlayed` list. `skipGame()` sets it
locally as well as posting, or the tab does not appear until a reload and the game
you just skipped is unreachable in the meantime — which is the original bug in
miniature.

Five assertions, including that one member's skip is never reported as another's.

## Finishing the rating queue

HTML, `app.js`, and `styles.css` must revalidate together (`public/_headers`). A
mobile screenshot after this feature shipped showed new completion markup with
old explanatory copy and an enormous unstyled SVG: the script and stylesheet
responses had `max-age=14400` while HTML had `max-age=0`. Revision queries on the
two asset URLs bypass those already-cached copies; `private, no-cache` prevents repeat
mismatches while still allowing ETag/304 reuse. The SVG also has intrinsic width
and height so a missing stylesheet cannot turn it into a viewport-sized spacer.
Plain `no-cache` worked on the Pages host but was rewritten to `max-age=14400`
on the custom domain, so the mutable assets also bypass its shared cache.
Verify the live headers when changing this policy, and keep the revision queries
rather than returning to the older bare cache keys. See `docs/OPERATIONS.md`.

The completed queue celebrates **You're all caught up** with separate rated and
skipped counts. It hides the unanswered-game coverage bar and stale rating question
while keeping Already rated and Skipped reachable. Its primary action opens Play
next, or Library in a personal workspace. The success graphic is decorative, its
brief entrance respects reduced motion, and a truly empty library still uses the
getting-started screen rather than claiming any work has been completed.

## Rating later

**Rate later** is navigation within the active Played or Want-to-play queue. It
advances `state.qIndex`, wrapping at the end, without writing a rating or skip,
changing queue membership, or changing coverage. It is hidden in Already rated and
Skipped, and disabled when fewer than two games remain in the active mode.
Enter on the focused button activates it instead of the queue's save shortcut.

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

`games.started` and `games.finished` are stored as ISO dates. A member's edit is
authoritative and records `source = manual`; accepting a suggestion stores its
source separately so the UI keeps rendering it as an approximation. The same rule
applies to `hours`. `games.finished_estimated` is derived and remains a suggestion.

**Steam cannot tell you when a group started a game.** `GetOwnedGames` returns
`playtime_forever` and `rtime_last_played` and nothing else time-shaped — checked
against the live API, whose per-row keys are exactly `appid, name, playtime_forever,
img_icon_url, playtime_windows/mac/linux/deck_forever, rtime_last_played,
content_descriptorids, playtime_disconnected`. No first-played, no acquired, no
purchase date. There is therefore no automatic *exact* start date. The history card
can offer the earliest synced achievement as proof the group had played by that day,
or the Steam release date as a low-confidence fallback. Both render with `≈` and
their source; the UI never calls either one the group's actual first session.

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

## Complete our history

The Library can ask one missing fact at a time for non-backlog, non-archived games:
first played, total group hours, and last played. A rating, at least one personal
Steam hour, or being the person who added the game moves a prompt earlier because
that member is more likely to remember; it never changes who is allowed to edit.
Someone who marked **I didn't play this** is not prompted for that game.

Only first played is requested while a game is still `playing`. Group hours and
last played would become stale after the next session, so those wait until the game
leaves that status. Automatic suggestions are intentionally bounded:

- first played: earliest synced achievement, otherwise Steam release date;
- hours: the existing minimum-playtime estimate, only with at least two participants;
- last played: the later of Steam's visible last-play estimate and the latest synced
  achievement.

Accepting a suggestion recomputes it on the server and ignores any value supplied by
the browser. The fact, provenance and stale-nudge cleanup are one transactional D1
batch. Manual edits replace the provenance with `manual`. **Remind me next week**
and **I don't know** are per-member states, so one person's dismissal cannot suppress
a question for the rest of the group; filling the shared fact removes it for all.

The card is disabled by default and each member opts in independently from Settings.
`member_preferences` is a side table rather than a membership column, so a missing
row is the safe off state for existing members as well as new ones. The preference
only controls whether the Library fetches and renders the card; it does not delete
history facts, provenance or somebody else's nudge state.

`game_fact_sources` and `history_nudges` arrive in migration 023. Migration 022's
17 owner-approved release-date fallbacks for `g4m1ng` are backfilled as
`release-date`, so they are not retroactively presented as recalled dates.

Migration 025 revisits the weak `g4m1ng` fallbacks after comparing the now-public
2022–2025 Steam Replays, public Community achievement unlock timestamps, and the
synced library. Eight starts move to stronger achievement evidence, two missing
last-played values accept the visible account's Steam timestamp, and The Division
2's impossible post-finish Steam release fallback is removed. It deliberately does
not copy Ama's lifetime hours into `games.hours`: that remains personal playtime,
not evidence of hours played together.

Migration 028 adds `member_preferences` and `group_invites`. Both are additive,
idempotent side tables; no membership, game or rating row is rebuilt.

## The Library's default view

`LIB_DEFAULTS` in `app.js` is the single definition, and the default sort is
**Playing first, Backlog last**. Finished, Sampled, Unfinished and Dropped share the
middle tier and sort together by most recent activity; the same date order applies
inside Playing and Backlog. The date is last played when available, falling back to
first played. Missing dates sink within their tier and fall back to A–Z. This keeps
the games currently in motion visible and makes fresh Steam imports chronological
even though Steam publishes no true first-played field. Explicit choices such as
Best first still sort the whole filtered library exactly as labelled.

The defaults are re-established when you arrive at the Library **from another view**,
and deliberately not on a same-view re-render: the detail dialog re-renders the
current view on save, and having that silently undo your sort would be maddening. The
Reset button appears only when something deviates, so it is a way back rather than a
permanently lit control that usually does nothing.

Workspace entry still prefers Rate while its queue has work. A `/queue` entry with
no unrated games instead opens Library, or Find games if the active library itself is
empty; an explicit later click on the Rate tab still exposes its completed state.
The game detail dialog closes through its X, Escape, or a click on the backdrop.

## "Would you play it again?"

The queue asks two unrelated questions and stores both answers in `ratings.score`.
Which one you are answering depends on `games.status`: a played game asks *how good
was it*, a backlog game asks *how much do you want to play this*. That holds until
the group's history and yours differ — somebody finished a game solo that the group
has never played. Then rating it 9 ("it was great") reads as "keen to play", and
rating it 3 to keep it off Play next corrupts the only quality signal there is.

So the score keeps meaning quality and appetite gets `ratings.replay`
(migration 030): `yes | maybe | no`, three states rather than a second slider,
because the useful distinctions are enthusiasm, indifference and refusal.

**NULL means never asked, and a non-NULL value is also the record that this person
has played the game** — which is why there is no separate "I played this" column.

**The question is only asked where the two answers can differ**: `modeOf(g) ===
'want'`, i.e. the group has not played it. Rating coverage is this app's core
problem, so a second question on every card would be the wrong trade.

**Who has already played it comes from Steam, not from a person.** `playtime` is
already synced for the hours estimate and ownership, so `ownershipForGames()`
returns `playedByGame` off the same rows at a 60-minute floor — the hour
`lib/history.js` already uses before counting somebody as a participant. The
evidence is one-directional: hidden playtime is indistinguishable from never
launching it, so an empty result is silence, and the card offers a manual
**I've played this before** rather than treating it as "you have not". That reveal
is also the whole story for non-Steam games.

**It is spent in exactly one place: chips on Play next.** It changes no ranking and
no coverage denominator. Silently demoting a game somebody has played would be the
removed weighted score again — a number you cannot reconstruct from the column
beside it. Somebody who has "had enough" is not also listed as having played it;
the second chip says that already.

`rate.js` only touches the column when the request carries the key, so an ordinary
save from the Played tab cannot clear an answer by not mentioning it; sending
`null` clears it on purpose. Five assertions, including that one.

## Budget on Play next

A slider capping the price per person, off by default (`BUDGET_STEPS`, last
position = no cap). `games.price` is Steam's own display string for the region the
catalogue was fetched with — `"29,99€"`, or the literal `"Free"` for a free-to-play
app — so `priceCents()` parses it back rather than a second numeric column
disagreeing with the chip beside it. Whichever of `,` and `.` comes last is the
decimal separator, so both locales' formats work.

**A game with no price is excluded when a cap is set, not silently kept.** Listing
it under "up to €30" promises something the data cannot support, which is the same
call invariant 6 makes for an unverified player cap. Both exclusions are counted
back to the user separately — "13 over budget · 7 with no price on file" — because
one is a decision and the other is an admission. Prices are the cached list price
and do not track sales; the note says so.

`priceCents` is defined once in `app.js` and `test/isolation.mjs` reads it out of
the file the way `scripts/validate-palette.mjs` reads `SERIES`, for the same
reason: a second copy of a parser is a second copy that goes stale.

## Rating from the game detail panel

Every other fact on that panel is editable in place; your own score used to be the
exception, and changing it meant closing the dialog and hunting the game down in
the Rate tab's Already rated list — 110 entries for the owner of group 1. Your row
in `.detail-votes` is now the control: the bar becomes a slider in the same
three-column geometry, so it stands exactly where everyone else's bar does.

**This forced a blind-rating fix, and that fix matters more than the feature.** The
panel painted every member's score unconditionally, ignoring `groups.blind_rating`.
That was already a leak while the panel was read-only. Once you can rate from here
it would be a *hole* — you could defeat a group setting by opening a dialog. Other
scores are now hidden until you have voted, and the unrated slider starts neutral
rather than on the group average, on the rate card's own rule: hiding the numbers
while still anchoring the handle on them would defeat the point.

Saving is an explicit button that appears only once the slider differs from your
saved score. Not save-on-release: a rating takes the game out of your queue and
clears any skip, which is too much to happen from a stray drag. And not the
panel's "Save changes", because a score goes to `/rate` while everything else on
that form goes to `PATCH /games/:id`, and one button hitting two endpoints can
half-fail.

Both callers go through `postRating()`. A score is not just a number on a row — it
removes the game from your queue, clears the skip (server-side too, so a stale
local copy strands the card in the Skipped list) and moves your coverage bar. A
second copy of that would eventually forget one step. The panel only reopens itself
after saving when blind rating was hiding something, so an ordinary re-rate does not
throw away your scroll position and reload the comment thread.

## The Rate tab's queue list

Card and queue side by side at ≥1100px, where the list is a standing sticky panel;
below that it stays the `<details>` disclosure it always was, because a phone has
no column to spare. The list is **first in the DOM** so narrow screens get it above
the card as before, and CSS places it in the second column — `syncQueuePane()`
forces `open` on wide screens, where the summary is hidden and a toggle would be a
control that does nothing. A queue of one hides the list entirely, so
`.rate-layout:has(> .rate-list[hidden])` drops the column with it rather than
pinning 300px of nothing beside the card.

Search filters the current mode. **`data-i` stays the index into the unfiltered
queue**, because that is what `state.qIndex` means; renumbering it would send a
filtered click to the wrong game. Typing re-renders the list *only* — going through
`renderQueue()` on every keystroke rebuilds the card and restarts its trailer.

A search finding nothing while the game plainly exists is the obvious trap, since
rated and unrated games live in different tabs and one of them usually holds nearly
everything. So an empty result names the other tabs ("Nothing here. 2 in Already
rated") and switching keeps the term. Shortcuts are safe: `onKey` already bails
when focus is in an `INPUT`, so typing "s" cannot skip the card.

## Going back to the one you just answered

Rating or skipping takes the card off the list it came from, so changing your mind
meant switching tab and hunting the game down — Already rated is 110 entries for
the owner of group 1. The `↩` beside the queue position goes straight to it.

It **navigates rather than undoing**. Both destinations already let you change the
answer — the slider in Already rated opens on your own score, Skipped offers "Put
back in my queue" — and silently reversing a write nobody asked to reverse is a
worse failure than one extra click. It sits by the position indicator rather than
in the action row for the same reason: going back is queue navigation, and a stray
click next to Save should not be able to touch the rating you just gave.

`state.lastAction` records which list the game landed in (`rated` for a score,
`skipped` for either skip, and back to its own mode for an unskip), and the button
hides when the game is not actually there any more or when it is already the card
on screen. One step, not a history stack: going back is not itself something to
undo.

## The two skip keys

The rating card's shortcut legend used to read `S skip · N didn't play`, which made
N look like a clumsier name for the same thing. They are the two *buttons*: **S is
"No opinion"** and **N is "I didn't play this"** — the distinction migration 016
exists to preserve, and only the second leaves your coverage denominator. The
legend now names the buttons, and its two halves hide with them, so `want` mode no
longer advertises a key for a question ("were you there?") it does not ask.

The slider's hint had the same shape of bug and is fixed with it: it read off
`state.rateMode`, so a finished game opened from **Already rated** asked "how much
do you want to play this?". It follows `modeOf(g)` now — the question belongs to
the game, not the tab, and Already rated and Skipped both list the two kinds
together.

## The default workspace

Which workspace a hash-less visit opens. It used to be `state.groups[0]` — first by
name, an arbitrary answer that moves when somebody renames a group. The star in the
workspace switcher sets it; clicking the lit star clears it, so the control is its
own undo. Hidden when you have one workspace, because there is nothing to choose.

**A hash naming a workspace you are in still wins**, so a link somebody sent you
opens what it says rather than being overridden by your default. The star only
decides where you land with nothing in the URL.

It lives on `member_preferences.default_workspace` rather than a per-account table,
for two properties that come free with that shape:

- the composite foreign key cascades from `memberships`, so **leaving a group clears
  the default** instead of leaving a dangling id the boot path has to defend against;
- a partial unique index (`ON member_preferences(steam_id) WHERE default_workspace =
  1`) makes "at most one default per account" a database constraint. That index is
  why `PATCH /api/me` clears the old row *before* setting the new one — the other
  order trips it mid-batch.

The write is `PATCH /api/me`, deliberately **above** the group middleware: the choice
spans every workspace you belong to, so a group-scoped route would have to write
outside its own `group_id`, and the control is account chrome rather than a group
setting. Its membership lookup is the tenancy check and returns **404** for a slug
you are not in, the same 404 an unknown slug gets — otherwise it becomes a probe for
which private workspaces exist. Five assertions cover it, including that one.

## Recommendations, and the co-op filter

"Recommended for us" is the default sort on **Find new games**. The ranking is
`lib/recommend.js` — a pure function, shared with `test/harness.mjs` so the local
ordering is the shipped ordering — behind
`functions/api/g/[slug]/recommend.js`.

Both these catalogue cards and the Add-game Steam search expose an official store
link as a separate `target="_blank"` action with `rel="noopener"`. Do not put it
inside the Add button: nested interactive controls are invalid, and opening a page
for research must never accidentally add the game. Already-added search results
keep the store link active.

**Why it is a separate route and not `sort=fit` on `/api/coop`.** The catalogue
endpoint is deliberately group-blind: no slug, no membership read, nothing
group-scoped, asserted by two tests. Ranking needs the group's ratings, so it has
to sit *below* the tenancy boundary. Bolting it onto `/api/coop` would put library
data behind an endpoint with no tenancy check at all. Both routes select
`CATALOGUE_COLS` and apply the same filters, so the card shape and the eligible set
do not change when you switch sort order.

How it ranks: **a candidate is scored by how much the group liked the games it most
resembles.** Every game is an IDF-weighted vector over its tags, similarity is the
cosine of two such vectors, and a candidate's fit is the similarity-weighted mean of
its `NEIGHBOURS` nearest rated games' scores relative to the group's own average,
shrunk when even the nearest are faint matches. Below `MIN_HISTORY` rated games it
does not pretend — it returns `basis: 'popularity'` and the UI says so.

**This replaced a per-tag average, and the reason is the failure that model could
not fix.** It learned one number per tag and could not use a tag seen fewer than
`TAG_MIN_GAMES` times — precisely the rare, informative ones IDF weights highest.
Barotrauma was ranked on Strategy (−0.45) and Horror (−0.15) and buried at #259
while its real signal, Submarine (idf 5.98) and Underwater (idf 5.29), carried no
preference at all; the group had scored it 7.5. Comparing whole games needs no
threshold — one rated submarine game recognises another — and it now ranks #80.

Measured on group 1, holding each rated game out in turn:

```
                      leave-one-out r      where held-out games land (median)
                                          loved   liked    ok    meh   1st page
  per-tag average   0.193 [-0.02, 0.39]    28%     50%    43%    49%    4 / 52
  nearest games     0.270 [ 0.04, 0.46]    15%     21%    40%    41%    8 / 52
```

The correlations overlap, so that is not the argument. Two things are: this is the
first configuration measured here whose interval **excludes zero**, and the
retrieval order is finally monotonic, where the old model placed "liked" (50%)
*below* "meh" (49%).

`why` names games now, not tags — "Similar to Elden Ring and Monster Hunter: World"
rather than "matches your taste for Survival". That is a better explanation because
it is checkable. `TAG_MIN_GAMES` and the per-tag preferences survive, but **only for
the likes/dislikes summary**; they decide no ranking.

**The cost is `candidates × rated games` cosines**, measured at 17 ms for 303 × 97.
The library cap of 2000 games bounds the worst case at roughly half a second; no
group is close, but that is the number to watch if one gets there.

**A neighbourhood model clusters, so the head of the list is diversified.** Every
game near one beloved cluster scores well, and group 1's top 20 had 7 games whose
nearest rated game was Elden Ring and 5 whose nearest was Big Walk. `DIVERSITY`
applies standard greedy re-selection over the first `DIVERSITY_WINDOW` entries:
mean pairwise similarity inside the top 10 falls 0.105 → 0.086 and inside the top
24 0.084 → 0.073, for a 7% cost in mean top-10 fit. The penalty goes **inside the
displayed fit**, for the third time in this file — diversification reorders by
construction, so leaving it out prints a higher number below a lower one.

### Played ratings are not better evidence than want-to-play ratings

Tested, because it is the obvious thing to assume and it is wrong here. A rating
given in Played mode is a quality judgement; one given in Want-to-play mode is
appetite. Weighting the former up makes the ranking worse at every strength tried:

```
                                 all targets            played targets only
  equal weight (shipped)   0.270 [ 0.06, 0.45]      0.308 [-0.05, 0.58]
  played x2                0.162 [-0.05, 0.36]      0.237 [-0.15, 0.53]
  finished x2, played x1.5  0.227 [-0.01, 0.41]      0.269 [-0.11, 0.58]
  played only              0.120 [-0.07, 0.31]      0.241 [-0.12, 0.53]
```

The right-hand column is the fair test: most of group 1's ratings *are* appetite
ratings (59 of 97), so a model trained on appetite would predict them better by
construction. Restricting the targets to quality judgements removes that advantage
— and equal weight still wins. Only 38 of 97 rated games have a played status, so
down-weighting the rest costs more in evidence volume than it gains in evidence
quality. There is also a conceptual reason not to: for a recommender, "we want to
play this" is not noise, it is the exact decision being predicted.

### The standing check: would it find what they chose?

Re-run against the nearest-games model, the in-catalogue picks all moved up sharply
— Barotrauma #259 → #31, Dune Awakening #176 → #73, Enshrouded #107 → #65, Big Walk
#15 → #6 — but the headline is still **1 of 10 on the first page**, because six of
those ten are not in the catalogue at all. That is the crawler's backlog, not the
ranking's fault. Re-run this check once the tracked-games discovery has caught up;
it is the measurement that actually reflects the product.

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

### It was starving, not misconfigured

Measured in August 2026 and worth not rediscovering. Tags were read from
`coop_apps` alone, so a rated game the crawler had never listed taught the ranking
nothing — **45 of group 1's 103 rated games**, and the most characteristic ones
(Monster Hunter: World, Elden Ring: Shadow of the Erdtree, Ark, The Division 2,
Trine 4 and 5). What survived was thin enough that three casually-rated puzzle
games outvoted the group's actual taste, and the top of the list was party games.

**Use leave-one-out to judge a change here, not your own reading of the top ten.**
Learn preferences from every rated game but one, predict the held-out game's score,
correlate predictions with real scores, and hold the evaluation set fixed so only
the evidence differs. Measured that way the shipped ranking had *no positive
relationship* with what this group liked: r = 0.025 on a snapshot, −0.109 on live
data. Reading both tag homes takes it to 0.253 and 0.144. The sample is ~55 games
and 0.14 is weak — do not oversell it — but the sign is consistent.

**Put an interval on that number before believing a difference in it.** Bootstrapped
over 93 evaluation games, r ≈ 0.19 carries a 95% interval of about **[−0.02, 0.39]**
— so the tuning table this file first recorded (SHRINK 8 → 0.236, TAG_MIN_GAMES 4 →
0.211, candidate-side shrinkage → 0.210, against 0.253) was reading noise as
signal. Those knobs are not measurably worse; they are indistinguishable. Only
differences that clear the interval mean anything, and two do: restricting history
to played games so backlog "how much do you want to play this" scores stop being
read as quality judgements scored **0.005**, and removing IDF costs 0.253 → **0.174**.
The played-only idea is intuitive, wrong on this data, and will occur to somebody
again. `NON_TASTE` is neutral here (0.248 vs 0.253) and stays because it was added
for output quality, which correlation does not measure.

The practical consequence: **judge this ranking on whether its likes are backed by
real evidence, and use the correlation only to catch a change that makes things
clearly worse.** That is how `TAG_MIN_GAMES` moved 3 → 4 — see the constant.

### The check that matters: would it have found what they chose?

Correlation says whether the ordering tracks taste. It does not say whether the
list is *useful*. The sharper test: take the top of Play next — backlog games the
group ranked with its own scores, about as close to a revealed preference as this
data gets — and ask where each would rank in Find games if it were not already in
the library. Hold it out of the history too, or its own rating leaks into the
preferences used to score it. Measured on group 1's top ten:

| | |
|---|---|
| Would have been on the first page | **1** (Big Walk, #17 of 304) |
| In the catalogue but ranked too low | 3 (Dune Awakening #162, Enshrouded #102, Barotrauma #239) |
| **Absent from the catalogue entirely** | **6** |

**The dominant failure is reach, not ranking.** Overcooked, Broforce, Keep Talking
and Nobody Explodes, Lovers in a Dangerous Spacetime, Dark Souls III and Back 4
Blood are not in `coop_apps`, so they could not be recommended to anybody — and 42
of group 1's 97 linked games are in the same position. Discovery was
`globaltopsellers` plus recent releases, and both are biased toward what sells
*now*, which structurally misses co-op staples from 2015–2021. The crawler now has
a third source: games groups actually track. 117 co-op titles across the workspaces
here, absorbed a few an hour through the same vetted `upsert`, so DLC and
expansions are still rejected and the review floor still applies.

**The ranking is genuinely weak too, and worth being honest about.** Holding out
every rated game in turn and recording where it lands:

```
  loved 8.5+     median top 28%   on the first page: 2/6
  liked 7.5-8.4  median top 48%                      1/15
  ok    6.5-7.4  median top 40%                      0/24
  meh   <6.5     median top 46%                      1/7
```

Loved games place better than the rest, but not by much, and only 4 of 52 land on
a first page at all.

One structural cause is visible in the per-tag breakdown and is worth naming,
because it is not a tuning problem: **IDF and `TAG_MIN_GAMES` pull against each
other.** IDF weights a tag by rarity, so the most informative tags are the rare
ones — but a rare tag is exactly what `TAG_MIN_GAMES` refuses to learn a preference
for. Barotrauma's most distinctive tags are Submarine (idf 5.98) and Underwater
(idf 5.29); the model has a preference for neither, so it ranked the game on
Strategy (−0.45) and Horror (−0.15) and buried it at #239 while the group scored it
7.5. Fixing that means a model that can generalise between tags rather than
treating each as independent, which is a redesign, not a constant.

### Everything above was measured on ONE group

`g4m1ng` is the only workspace here with ratings. The others have imported Steam
libraries and rated nothing, so every figure in this section describes one taste
profile. Two consequences worth holding onto:

**The ranking is noise on a thin history, and that is a general finding.** Train on
k of group 1's rated games and predict the rest: r is −0.01 at 10 rated games, −0.03
at 15, −0.01 at 20, 0.01 at 30, 0.07 at 45, 0.12 at 60. `MIN_HISTORY` was **5** — a
group with six ratings was shown a fit column and told it was ranked against what
they like. It is 20 now, and `SETTLED_HISTORY` (45) is the point past which the UI
stops calling the order provisional. Both are one group's curve; re-measure when a
second workspace has a history.

**A null result on group 1's ratings can be range restriction rather than absence.**
They have rated 37 Very Positive games, 11 Overwhelmingly Positive, 8 Mostly
Positive, 6 Mixed and nothing worse — so "Steam's verdict does not predict our
scores, r = 0.019" was measured where the predictor has almost no spread. It is not
evidence that a badly-reviewed game is a fine suggestion. `REVIEW_PRIOR` exists for
that end of the scale and is explicitly a prior, not a fitted parameter.

**`REVIEW_PRIOR` is inside the displayed `fit`, unlike `POP_WEIGHT`.** It is large
enough to reorder the list, so leaving it out of the column printed 0.22 above 0.26
— the precise failure `POP_WEIGHT` is sized to avoid. So the number on the card is
the number that ranked it, the tag chips explain the positive half, and the Steam
verdict beside it explains the rest. An assertion covers the column staying
descending with the prior active.

Tags for library games the catalogue does not list live in `steam_apps.tags`
(migration 031), filled by `scripts/backfill-tags.mjs --library` and kept up by the
crawler four an hour. **Not in `coop_apps`** — that is the browsable co-op
catalogue, and inserting a group's singleplayer and PvP games would change what
everyone else sees. The route prefers the catalogue's copy where both exist, since
that is the row candidates are compared against.

Games already in the library are dropped from the ranking, **except when there is a
search term**: then it is a lookup, and hiding what somebody typed because they
already own it reads as a broken search.

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

The singleplayer exception originally checked only the first six tags and was
introduced after Ghost of Tsushima DIRECTOR'S CUT appeared under the filter.
Outer Wilds exposed the limit: Singleplayer is tenth, with no multiplayer tags.
The exception now checks the full retained list and excludes a singleplayer-tagged
game only when neither its tags nor its Steam modes provide multiplayer evidence.
Modes cannot override the primary PvP exclusion and never establish a player cap.
This remains an exclusion rule, not a requirement to carry a co-op tag.

The parser previously kept 12 tags. On 2026-10-17, live Steam checks found Roadside
Research's Online Co-Op at rank 20, Vampire Survivors' Local Co-Op at 13, and Rise of
the Ronin's Online Co-Op at 16. It now reads the bounded tag block up to 64 tags and
32 KiB, stopping before the tag modal. Steam modes preserve these games when only
older truncated tags are cached. Taste matching still uses only the top 12 tags
for both candidates and rated history, preserving the evidence used for the ranking
measurements above. Replaying the 337 stored tag rows with their available Steam
modes changes only Ghost of Tsushima from excluded to included; the original
singleplayer exception had missed its co-op mode evidence. All six live-page checks
(Outer Wilds, the three late-tag co-op cases, Call to Arms: Panzer Elite, and Ghost
of Tsushima) retain 20 tags and give the intended verdict when combined with cached
modes. The seeded group's 25 rated catalogue matches produce the same taste order,
fit values and preference summary with the old and new recommender. No data
backfill or group-library correction accompanies the
code change; manual additions remain unrestricted.

## "Not interested", and the way back

Find games shows a few hundred catalogue rows, and without a way to say no the ones
a group has already rejected sit at the top of the list forever. `coop_dismissals`
(migration 034) hides them.

**Group-scoped, not personal**, on the same reasoning as `games.archived_at`: Find
games is a shared decision about what to add, so one person saying no hides it for
everybody rather than four people each rejecting the same game separately. That is
only safe because it destroys nothing — the catalogue row is untouched, and undo is
one click from the same screen. `steam_id` records who, so a game does not silently
vanish on the other three with no way to tell whom to argue with, and **any member
can undo**, exactly like restoring an archived game.

`name` is stored rather than joined. The crawler DELETEs `coop_apps` rows that turn
out to be DLC or fall under the review floor, so a dismissal joined against a
vanished row would render as an unlabelled orphan in the very list built for
undoing it. For the same reason there is no foreign key to `coop_apps`.

**The filtering is client-side, and has to be.** The grid is fed by `/api/coop`,
which is deliberately group-blind — teaching it about dismissals would put group
state behind an endpoint with no tenancy check. `renderBrowse()` already filters
owned games this way and reports how many it hid; dismissals join that count. The
route below the boundary only stores and lists.

**Show dismissed** puts them back in the grid, greyed, in the rank they held, with
"Ama said no" and a Put back button where Add and Not interested would be. The Add
button is deliberately absent there: letting one click undo a decision the group
made, without saying that is what happened, is the thing the whole feature exists
to avoid. The toggle only appears once the group has dismissed something, so it is
never a control that does nothing. The undo panel stays too — it lists everything
at once, where the grid only shows what the current page and filters reach.

**Both display toggles repaint, they do not refetch,** and that is a correctness
requirement rather than an optimisation. `renderBrowse()` concatenates when
`browse.page > 0`, so refetching the current page duplicated all 24 cards on every
page after the first — which the old `hide-owned` listener did. `paintBrowse()`
renders from `browse.items` and the stored last response, so a toggle, a dismiss
and an undo all cost nothing and keep every card in its ranked position.

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
wordmark, the group switcher and the tab row cannot share one line. Keep the small
extra margin after that crop: its bright outline reaches the image boundary and the
normal flex gap otherwise looks like an overlap against the group button's border.

Both landing-page Steam links use the same Steam glyph. The top link wraps below the
wordmark on phones, so omitting the glyph there reads as a second, unrelated action
rather than a compact copy of the hero call to action.

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
taken. What *is* refused, on both create and rename, is a name colliding with
another group **the caller is already in**: that is information they already have,
and without the check their group switcher shows two identical entries. Existing
duplicates are labelled with their slug in that switcher until one is renamed.
Renaming never touches the slug, so URLs and invite links already handed out keep
working.

## Conventions

- Comments explain *why*, not *what*. Several exist specifically to stop a future
  editor "simplifying" a security check — leave those.
- Two-space indent, single quotes, semicolons. No TypeScript, no dependencies at
  runtime; `wrangler` is the only devDependency.
- Commit messages: short imperative subject, then a paragraph on the reasoning
  where it isn't obvious.
