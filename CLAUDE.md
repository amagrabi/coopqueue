# CLAUDE.md

Context for Claude Code working in this repo. Read `README.md` first for what
the product does and how to deploy it; this file covers the things that are not
obvious from the code and the state the project is in.

## The name

The product is **CoopQ**, live at **<https://coopqueue.pages.dev>**. The Pages
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

The GitHub repository is **`amagrabi/coopqueue`** (private). The local checkout
directory is still `~/code/g4m1ng` — renaming it would invalidate every git
worktree path under `.claude/worktrees/`, so it is left alone deliberately.

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
npm test                 # 33 tenancy/permission/scoring assertions — ALWAYS run before deploying
npm run test:ui          # renders every screen headless — does NOT run on macOS, see State
npm run db:backup        # wrangler d1 export — D1's free tier has NO automatic backups
node test/harness.mjs    # local UI dev server; SCENARIO=anon|fresh|claim|member

npm run db:migrate -- --file=./migrations/001-coop-apps.sql   # apply one migration
npm run crawl:coop -- --pages 8 --out migrations/002-coop-seed.sql
node scripts/seed-player-caps.mjs --from migrations/002-coop-seed.sql \
                                 --out migrations/003-player-caps.sql

node scripts/validate-palette.mjs      # re-check player-colour separation (invariant 4)

cd crawler && npx wrangler deploy      # the 15-min cron catalogue crawler
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

`SERIES` in `app.js` therefore hands them out in a non-numeric order chosen by
exhaustive search, maximising the worst pairwise CIELAB ΔE across normal,
deuteranopic and protanopic simulation, so that each prefix is the best available
for that group size. Numeric order gave a four-person group blue/orange/aqua/
yellow, where orange vs yellow is ΔE 33.9 normally but **9.2** under
deuteranopia — two people whose columns looked identical to some readers. The
current order scores 25.1 for four. Re-run that search before reordering or adding
hues; do not pick by eye.

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
  only *describes* people on the Stats page — it decides no ranking.
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

## State

**Live at <https://coopqueue.pages.dev>** (Cloudflare account
amadeus.magrabi@googlemail.com, Pages project `coopqueue`, D1 `g4m1ng` =
`f16e7e1e-e2c3-463b-b1e4-158bc961de92`, committed into `wrangler.toml`).
`SESSION_SECRET` and `STEAM_API_KEY` are set on the **production** environment
only; the preview environment has neither, so a preview deploy boots with no
session support. `ALLOWED_STEAM_IDS` is unset, so anyone can sign in and create
their own groups.

A second Worker, **`coopq-crawler`** (`crawler/`), binds the same D1 and keeps the
catalogue fresh on a 15-minute Cron Trigger. It is a Worker and not a Pages
Function because **Pages Functions cannot carry Cron Triggers**. Registering any
cron also requires the account to have a workers.dev subdomain, which is created
by opening the Workers page in the dashboard once — until that happens the script
uploads but the schedule is rejected with error 10063.

Group 1 `g4m1ng` holds 114 games (92 seeded + 22 recommendations) and 232
ratings. **Ama is claimed** by SteamID64 `76561198049961191` (owner, 77 ratings
repointed). Leo (48), Pat (82) and Dave (25) are still unclaimed seeds, but each
now has a `seed_assignments` row (migration 007), so they will be claimed
automatically the first time they sign in — no prompt.

The catalogue holds 337 games with real review counts. The crawler re-ranks only
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

22/22 tenancy assertions pass. `npm run test:ui` does **not** run on macOS: it
imports `playwright`, which is not in `package.json`, and hardcodes a Linux
Chrome path (`/opt/pw-browsers/…`) from the container it was written in.

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
table, and the tenancy boundary is untouched. What is missing is the global side,
one table alongside `steam_apps`: `coop_apps(appid PK, name, popularity_rank,
review_count, release_date, type, coop_categories, verified_max_players)`.

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
UI (**done**) → crawl cron → Steam playtime/achievements → recent-releases button
→ comments. Note the Steam stats step depends on every member setting Steam
privacy → *Game details* to Public; `GetOwnedGames` returns nothing otherwise.

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
3. **Steam playtime + achievement sync.** `IPlayerService/GetOwnedGames` and
   `ISteamUserStats/GetPlayerAchievements`, keyed on the SteamID64s already
   stored. Would make `hours` real instead of hand-typed, and enables a
   "who already owns this" badge.
4. **A weekly nudge** (Discord webhook) listing games with fewer votes than the
   group has members. Rating coverage is the app's core problem — in the original
   spreadsheet it ranged from 89% to 27% per person.
5. **Public read-only group pages.** Also the cheapest growth loop the site has.

## Conventions

- Comments explain *why*, not *what*. Several exist specifically to stop a future
  editor "simplifying" a security check — leave those.
- Two-space indent, single quotes, semicolons. No TypeScript, no dependencies at
  runtime; `wrangler` is the only devDependency.
- Commit messages: short imperative subject, then a paragraph on the reasoning
  where it isn't obvious.
