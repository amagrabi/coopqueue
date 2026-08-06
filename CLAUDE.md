# CLAUDE.md

Context for Claude Code working in this repo. Read `README.md` first for what
the product does and how to deploy it; this file covers the things that are not
obvious from the code and the state the project is in.

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
npm test                 # 22 tenancy/permission/scoring assertions — ALWAYS run before deploying
npm run test:ui          # renders every screen headless, fails on any console error
npm run db:backup        # wrangler d1 export — D1's free tier has NO automatic backups
node test/harness.mjs    # local UI dev server; SCENARIO=anon|fresh|claim|member
```

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

**4. Colours come from the validated palette in `styles.css`.** The eight
`--series-*` values clear CVD separation, normal-vision separation and 3:1
contrast against the `#1a1a19` surface. Do not pick new ones by eye; if you need
more, re-run a palette validator rather than guessing.

**5. `max_players` means max *simultaneous online co-op* players.** Not the Steam
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
- **Scoring** (`lib/score.js`) does two things: per-person z-score calibration
  (a 7 from a generous rater ≠ a 7 from a harsh one), then shrinkage toward the
  group mean by `n / (n + SHRINKAGE_K)` so thinly-voted games can't top the
  ranking. `SHRINKAGE_K = 0` disables shrinkage.
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
  (the DASH manifest is genuinely segmented `.m4s` chunks). `trailer_url`
  therefore holds an HLS manifest, which only Safari plays in a bare `<video>`.
  `playable()` in `app.js` feature-detects and falls back to the header image.
  Making trailers work in Chrome means adding hls.js — the first runtime
  dependency the project would have.
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

**Live at <https://g4m1ng.pages.dev>** (Cloudflare account
amadeus.magrabi@googlemail.com, D1 `g4m1ng` = `f16e7e1e-e2c3-463b-b1e4-158bc961de92`,
committed into `wrangler.toml`). `SESSION_SECRET` and `STEAM_API_KEY` are set on
the **production** environment only; the preview environment has neither, so a
preview deploy boots with no session support. `ALLOWED_STEAM_IDS` is unset, so
anyone can sign in and create their own groups.

Group 1 `g4m1ng` holds 114 games (92 seeded + 22 recommendations) and 232
ratings, with `invite_code = NULL` — joining is disabled until an owner rotates
it from the Group tab. Ama/Leo/Pat/Dave are still unclaimed seed identities.

Neither `d1 create` parsing nor the `d1 list --json` branch turned out to be the
problem. What actually broke is in the git log for `e06be5f`; the short version
is that no unresolved import can be caught locally (no build step, and
`test/isolation.mjs` does not import `functions/api/steam/search.js`), so
`npm run deploy` is the first thing that ever type-checks the bundle.

22/22 tenancy assertions pass. `npm run test:ui` does **not** run on macOS: it
imports `playwright`, which is not in `package.json`, and hardcodes a Linux
Chrome path (`/opt/pw-browsers/…`) from the container it was written in.

Not yet verified by anyone: the Steam sign-in round-trip, claiming a seed
identity, invite-link creation, and `/enrich`. All four need a real Steam login.

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
