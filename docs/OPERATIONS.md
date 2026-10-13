# Operations

Everything about running the deployed instance: what exists in Cloudflare, how to
ship, how to change the database without losing it, and what has actually gone
wrong. `README.md` covers the product and first-time setup; this is the runbook
for an instance that already exists.

The evidence rules and migration checklist for importing a personal Steam library
are in [`PERSONAL_STEAM_HISTORY.md`](PERSONAL_STEAM_HISTORY.md).

---

## What is deployed

| Thing | Name | Notes |
|---|---|---|
| Cloudflare account | `amadeus.magrabi@googlemail.com` | free plan throughout |
| Pages project | `coopqueue` | serves `public/` + `functions/` |
| Live URL | <https://coopqueue.app> | custom domain; production branch is `main` |
| D1 database | `g4m1ng` (`f16e7e1e-e2c3-463b-b1e4-158bc961de92`) | id is committed in `wrangler.toml` |
| Cron Worker | `coopq-crawler` (`crawler/`) | hourly, binds the same D1 |

The D1 database is still called `g4m1ng` and that is deliberate — D1 has no
rename, the name is cosmetic (bindings resolve by `database_id`), and renaming
would mean creating a new database and migrating every row for nothing. Same for
the `g4_session` cookie and for group 1's slug. See the top of `CLAUDE.md`.

**Pages and D1 are independent resources.** The original `g4m1ng` Pages project was
deleted and recreated as `coopqueue` with no effect on the data — row counts were
identical either side.

### Secrets

Set on the **production** environment only:

| Name | Required | Effect if missing |
|---|---|---|
| `SESSION_SECRET` | yes | every request 500s — nobody can sign in |
| `STEAM_API_KEY` | no | no profiles, library/playtime sync, ownership negatives or achievement sync |
| `ALLOWED_STEAM_IDS` | no | unset means anyone may sign in and create groups |

```bash
openssl rand -base64 32 | npx wrangler pages secret put SESSION_SECRET --project-name coopqueue
npx wrangler pages secret put STEAM_API_KEY --project-name coopqueue
npx wrangler pages secret list --project-name coopqueue
```

Rotating `SESSION_SECRET` signs everyone out and loses nothing else — sessions are
signed cookies with no server-side table.

**The preview environment has neither secret.** That is the cause of the deploy trap
below, and it is why a preview deploy boots with no session support at all.

---

## Deploying

```bash
npm test          # 190 assertions — ALWAYS before a deploy
npm run deploy
```

`npm run deploy` pins `--branch main`, which matters more than it looks.

> **`wrangler pages deploy` infers the branch from git.** From any branch other than
> the production one it silently produces a *preview* deploy, against a different set
> of secrets, and reports success. The live site does not change and the preview
> 500s on `SESSION_SECRET`. This has happened twice. The pin makes `npm run deploy`
> correct from any branch, including a git worktree. Use `npm run deploy:preview`
> when a preview is genuinely what you want.

A successful production deploy prints only a `https://<hash>.coopqueue.pages.dev`
URL. A preview also prints a **"Deployment alias URL"** line — if you see that, it
went to preview.

**Deploying never touches data.** `wrangler pages deploy` and `wrangler deploy` ship
code only.

`public/_headers` sets `Cache-Control: no-cache` on HTML and `private, no-cache`
on `app.js` and `styles.css`. The custom domain's four-hour Browser Cache TTL
overrode plain `no-cache` on these assets even though the Pages host respected it;
`private` bypasses that shared cache while preserving browser revalidation.
Browsers can reuse an unchanged file after ETag validation, but must check it on
each visit so a deployment does not combine new markup with old code or styles.
The asset URLs in `index.html` carry a revision query to bypass four-hour browser
copies cached before this policy was introduced. Keep those queries: reverting
to the bare URLs could reach an older cached response. Brand and vendor assets
retain their separate, longer cache policies.

If a fresh deployment looks broken on a returning device, inspect the live
responses for both asset URLs referenced by `index.html`: their `Cache-Control`
must contain both `private` and `no-cache` (order does not matter). A Pages
deployment or CDN purge cannot remove files already cached in somebody's browser.

There is no build step. `public/` is served as-is and `functions/` is bundled by
wrangler. Because nothing type-checks locally, **`npm run deploy` is the first thing
that ever resolves the imports** — a typo'd import name is a deploy-time failure, not
a test failure. `npm test` does not import every route. A quick guard:

```bash
node -e "const fs=require('fs'),path=require('path');let bad=0;
const walk=d=>fs.readdirSync(d,{withFileTypes:true}).forEach(e=>{const p=path.join(d,e.name);
if(e.isDirectory())return walk(p); if(!/\.(js|mjs)$/.test(e.name))return;
for(const m of fs.readFileSync(p,'utf8').matchAll(/from\s+'(\.[^']+)'/g))
if(!fs.existsSync(path.resolve(path.dirname(p),m[1]))){console.log('MISSING',m[1],'in',p);bad++}});
['functions','lib','crawler','scripts','test'].forEach(walk);
console.log(bad?'BROKEN':'imports ok')"
```

### Deploying the crawler

Separate deploy, because it is a separate Worker:

```bash
cd crawler && npx wrangler deploy
cd crawler && npx wrangler tail        # watch cron runs live
```

---

## Changing the database

**`schema.sql` must never be applied to a live database.** It opens with
`DROP TABLE`, so a raw remote execution wipes every group, game and rating. The old
`db:init` shortcut was removed because it made that mistake too easy. The file exists
for fresh installs and for the two test suites, which build from it; the guarded
`npm run setup` only applies it when the remote database has no schema yet.

Anything that has to reach the live database goes in `migrations/` as an **additive,
idempotent** file:

```bash
npm run db:backup                                              # first, always
npm run db:migrate -- --file=./migrations/0NN-what-it-does.sql
```

A new table or column must be added to **both** `schema.sql` (fresh installs and
tests) and a migration (production). They are kept in sync by hand, and the harness
refuses to start when they drift, which is the check that catches it.

**A migration that rebuilds a table must be rehearsed.** Restore a `npm run db:backup`
dump into a local SQLite file with `PRAGMA foreign_keys = ON`, replay the migration,
and compare row counts *and* a checksum of `ratings` either side. Migration 017 is the
worked example: the first draft passed `PRAGMA foreign_key_check` cleanly while having
silently deleted every rating.

Migrations are **not tracked** — there is no applied-migrations table. They are
applied by hand with an explicit `--file`, so renaming or renumbering a file is
safe, and re-running one has to be harmless by construction.

Migration `020-rate-limits.sql` must be applied before deploying code that imports
the root request limiter. It creates one compact row per account and limit category;
without it, authenticated API requests fail closed with a logged 500 instead of
silently running without protection.

Migration `021-session-and-achievements.sql` must likewise be applied before this
feature set is deployed. It adds the achievement cache, the group-specific
library-sync watermark used to prove a negative ownership result, and the retained
legacy session-length column. The current attendee filter does not use session
length. Until a group runs **Sync playtime from Steam** once after this migration,
owned rows can still show positive but every absence remains unknown; that is the
deliberate safe upgrade path.

Migration `024-personal-workspaces.sql` must be applied before deploying the
personal-workspace code. It adds only the idempotent `workspace_settings` table;
existing groups have no row and therefore remain co-op. Workspace type is never
inferred from a one-member count, because every new co-op group starts that way.

### Useful queries

```bash
# ad-hoc read
npx wrangler d1 execute g4m1ng --remote --yes --command "SELECT COUNT(*) FROM games"

# machine-readable — note the preamble
npx wrangler d1 execute g4m1ng --remote --yes --json --command "..."
```

`--json` prints human-readable text *before* the JSON, so every script here slices
from the first `[` rather than parsing the whole stream. And a single `SELECT` of a
wide column across the whole catalogue (e.g. every `tags` value) **exceeds what the
D1 HTTP API will return** and fails with a Cloudflare API error rather than
truncating — chunk on `appid % N`, as `scripts/reclassify-coop.mjs` does.

#### Reads from a restricted coding-agent sandbox

On macOS, Wrangler normally writes logs below `~/Library/Preferences/.wrangler`.
A restricted agent sandbox may be allowed to read the saved OAuth profile but not
write that log directory. Point only the log at a writable temporary path; widening
filesystem access is unnecessary:

```bash
WRANGLER_LOG_PATH=/tmp/coopqueue-wrangler.log \
  npx wrangler d1 execute g4m1ng --remote --yes --json --command "SELECT ..."
```

Wrangler's saved OAuth access token expires. If a non-interactive command asks for
`CLOUDFLARE_API_TOKEN` despite an existing local profile, start `npx wrangler login`
in an interactive PTY with permission to open the system browser, then rerun the
read. Do not print, copy or ask the owner to paste tokens. The browser's final
**Authorize Wrangler** step grants broad account permissions, so an agent must get
the owner's explicit confirmation immediately before accepting it. The SQL used for
an information request should remain a `SELECT`; check Wrangler's result metadata
for `rows_written: 0` before reporting completion.

Personal CSV/JSON exports belong in `local-exports/`, which is gitignored. Give each
file a clear, dated name, verify its row count, and delete it when the owner is done.
Never commit a personal export or put one in `migrations/`.

---

## Backups and recovery

The free plan has **no automatic backups**. Two mechanisms, both free:

**D1 Time Travel** — point-in-time restore for the last 30 days, nothing to
configure. This is the real safety net and it covers the `db:init` catastrophe.

```bash
npx wrangler d1 time-travel info g4m1ng
npx wrangler d1 time-travel restore g4m1ng --timestamp=2026-08-06T12:00:00Z
```

**A full dump**, worth taking before any migration, since Time Travel cannot outlive
its 30-day window:

```bash
npm run db:backup      # writes backup.sql (gitignored)
```

**Restoring that dump needs `PRAGMA foreign_keys = OFF` first**, and this is not
optional. `d1 export` emits tables in `sqlite_master` order, and migration 017
rebuilt `games`, which moved it to the *end* — after `ratings`, `comments` and
`skips`, which reference it and are populated first. Replaying the file as-is dies on
the first `INSERT INTO "ratings"` with `no such table: main.games`. With foreign keys
off it restores completely and `PRAGMA foreign_key_check` comes back clean:

```bash
sqlite3 restored.db "PRAGMA foreign_keys=OFF;" ".read backup.sql" "PRAGMA foreign_key_check;"
```

A backup you have never restored is a guess. Rehearse it after any migration that
recreates a table.

The owner-facing JSON/CSV export beside **Delete group** is a portable copy of that
one group's games, ratings, comments, members and shared-history provenance. It is
useful before deletion, but it is not a database backup: only D1 Time Travel or
`npm run db:backup` can restore the whole instance and its shared Steam/catalogue
caches.

### Migration 023: Complete our history

Apply `migrations/023-history-nudges.sql` before deploying the history route. It
adds the shared fact-provenance table and per-member dismiss/snooze state, then
labels the 17 release-date fallbacks installed by migration 022. It is additive
and idempotent, so the normal migration command can safely be retried:

```bash
npx wrangler d1 execute g4m1ng --remote --file=migrations/023-history-nudges.sql
```

The application reads these tables while loading every group library; deploying
the code first would make that request fail until the migration is applied.

### Migration 028: member preferences and direct invitations

Apply `migrations/028-member-preferences-and-direct-invites.sql` before deploying
the opt-in history setting or direct-invite routes:

```bash
npx wrangler d1 execute g4m1ng --remote \
  --file=migrations/028-member-preferences-and-direct-invites.sql
```

It creates two side tables and one index with `IF NOT EXISTS`, so it is additive
and safe to retry. Missing `member_preferences` rows deliberately mean history
prompts are off. A `group_invites` row never grants access by itself; membership
is inserted only after the named account accepts. The new code joins both tables
during normal page loads, so migrate before deploying.

### Migration 029: default workspace

Apply `migrations/029-default-workspace.sql` before deploying the workspace
switcher's star:

```bash
npx wrangler d1 execute g4m1ng --remote --file=migrations/029-default-workspace.sql
```

`/api/me` joins the new column on every page load, so migrate before deploying.
Unlike 028 this one contains an `ALTER TABLE ADD COLUMN`, which SQLite has no
`IF NOT EXISTS` form for: a retry fails with `duplicate column name:
default_workspace` and changes nothing. That error means it already applied.

### Migration 030: replay appetite

Apply `migrations/030-replay-appetite.sql` before deploying the "would you play it
again" question:

```bash
npx wrangler d1 execute g4m1ng --remote --file=migrations/030-replay-appetite.sql
```

It adds one nullable column to `ratings`. The library route selects it on every
group load, so migrate first. Same retry behaviour as 029: a second run fails with
`duplicate column name: replay` and changes nothing.

Both 029 and 030 are additive column adds — no table rebuild, so none of migration
017's cascade hazards apply. Take `npm run db:backup` first anyway.

### Migrations 031 and 032: tags for library games

`031-steam-app-tags.sql` adds `tags` and `tags_at` to `steam_apps`, which the
recommender now reads alongside `coop_apps`. Apply it before deploying, since the
library route joins the column on every group load.

```bash
npx wrangler d1 execute g4m1ng --remote --file=migrations/031-steam-app-tags.sql
```

`032-library-tags.sql` is the generated backfill — 131 rows, produced by:

```bash
node scripts/backfill-tags.mjs --library --out migrations/032-library-tags.sql
```

That reads one Steam store page per row at ~1.7s spacing, so 135 rows took about
four minutes. It writes **no `is_coop`**: that flag decides what the browsable
catalogue shows and belongs to `coop_apps`. Re-running the generator is safe — it
only picks rows where `tags IS NULL`, and the emitted UPDATEs are idempotent.

Ongoing maintenance needs no manual step: the cron crawler now tags four library
rows per run, on the same "NULL means nobody looked" rule as the catalogue.

### Migration 034: "not interested"

Apply `migrations/034-coop-dismissals.sql` before deploying the Find games dismiss
button:

```bash
npx wrangler d1 execute g4m1ng --remote --file=migrations/034-coop-dismissals.sql
```

One `CREATE TABLE IF NOT EXISTS` plus an index, so it is additive and safe to
retry. The browse view calls `GET /api/g/:slug/dismissals` on entry, so migrate
before deploying or that request 500s and the grid falls back to showing
everything.

---

## Catalogue maintenance

The global catalogue is `coop_apps`, kept fresh by `coopq-crawler` on an hourly
cron: two discovery passes (top sellers, then recent releases) plus a batch of
**9 games** refreshed per run. The batch size is set by the Workers free plan's
**50 subrequests per invocation** — three per game (`appdetails`, `appreviews`,
store page) plus two for discovery.

Popularity is `review_count` from `appreviews`, never Steam's `sort_by=Reviews_DESC`
— that sorts by review *score* and will rank a 534-review DLC above Stardew
Valley's million.

The app orders browse results and thin-history recommendations directly by
`review_count DESC`. `popularity_rank` is legacy seed data; do not recompute it
after a crawl. Ranking every catalogue row with a correlated count is quadratic
and, when run hourly, exceeds D1's 5 million daily free read limit.

### Measuring IGDB player-cap coverage

Do not turn IGDB values into caps until coverage and conflicts have been measured.
Create a confidential Twitch developer app, keep its secret local, then run:

```bash
TWITCH_CLIENT_ID=... TWITCH_CLIENT_SECRET=... npm run measure:caps -- \
  --from migrations/002-coop-seed.sql --out igdb-cap-coverage.json
```

The script respects IGDB's four-request-per-second limit, resolves Steam through
the current `external_game_sources` endpoint, paginates complete result sets, and
reports no match, multiple game matches, missing multiplayer rows, conflicting
caps and unambiguous candidates. It also compares those candidates with
`migrations/003-player-caps.sql`, reporting agreement and conflicts with existing
hand-verified values. It never writes D1 or a migration. Review every candidate
against the human-verified meaning (maximum simultaneous **online co-op** players)
before adding it to `scripts/seed-player-caps.mjs` or generating a migration.

### Tags and the co-op flag

Tags drive both the **Co-op only** filter and the **Recommended for us** sort. They
come from each game's store page HTML (`parseStoreTags`), because they are in no
Steam JSON API and `genres` is useless — 235 of 337 rows are simply "Action".

```bash
# fill in rows the crawler has not reached yet (~1.7s per game)
node scripts/backfill-tags.mjs --out migrations/0NN-tags.sql
node scripts/backfill-tags.mjs --all         # re-read every row
node scripts/backfill-tags.mjs --limit 5 --dry

# re-derive is_coop from tags already stored — no network at all
node scripts/reclassify-coop.mjs --out migrations/0NN-reclassify.sql
```

Run `reclassify` after changing the classification rule; run `backfill` after the
catalogue grows. Both emit a migration rather than writing directly, so the change
is reviewable and repeatable.

### Player caps

`max_players` means max *simultaneous online co-op* players and is **only ever
written by a human** — the crawler deliberately omits it. Steam publishes no
machine-readable co-op cap; its `categories` field is a yes/no that is wrong often
enough to be dangerous. Verified caps live in `scripts/seed-player-caps.mjs`, one
line per game. Currently 55 of 337 rows have one, which is why most catalogue cards
read "player count unverified".

---

## Brand assets

`public/brand/` is generated by `scripts/build-brand.py` (Pillow + numpy), not
hand-drawn — re-run it when the logo changes:

```bash
python3 scripts/build-brand.py path/to/logo.png
```


| File | Use |
|---|---|
| `logo.png` | header lockup, transparent, 448×96 (3× of a 26–30px display height) |
| `icon.png` | controller glyph alone, transparent |
| `favicon-16/32.png`, `apple-touch-icon.png`, `icon-512.png` | tabs and home screens |
| `og.png` | 1200×630 link preview |

Two things are deliberate. The **icons keep a dark field instead of transparency**,
because the three figures inside the controller are white and would vanish against
light browser chrome. And the **lockup is keyed to transparency by a luminance
ramp** rather than a colour match — the source is bright content on a near-black
field (luminance ~17, against ~125 for the darkest part of the gradient), so a ramp
between the two separates them while leaving antialiased edges as partial alpha. It
composites cleanly on both `--plane` and the lighter card surfaces.

The crop finds the lockup by taking the **tallest contiguous band of content**, which
is what excludes a generator watermark — the original source had one in the
bottom-right corner, in its own band 126px below the wordmark. Taking a naive
whole-image bounding box instead lets the watermark set the right edge and leaves
13px of dead space in the logo.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Deploy "succeeds", live site unchanged | preview deploy from a non-`main` branch | `npm run deploy` (pins `--branch main`) |
| Every request 500s, "SESSION_SECRET is not configured" | you are on a preview URL, or the secret is unset | check `wrangler pages secret list`; use the production URL |
| Deploy fails: `No matching export … for import` | no build step, so nothing resolved it earlier | fix the import; run the import guard above |
| Cron uploads but schedule rejected, error `10063` | account has no workers.dev subdomain | open the Workers page in the dashboard once |
| `wrangler d1 execute --local` and `wrangler pages dev` disagree | they key their local SQLite files differently | use `test/harness.mjs` instead |
| Harness refuses to start | `schema.sql` drifted from `migrations/` | add the missing column to `schema.sql` |
| Trailers silent in Chrome | `hls.light.min.js` cannot play Steam's separate audio rendition | keep the **full** `hls.min.js` |
| A game shows the wrong trailer | a bad Steam appid match | relink by pasting the store URL in the Library |
| Achievement progress stays unsynced with a Game details message | Steam exposed the achievement catalogue but hid the account's unlocks; a signed-in Steam page can still see them | set Game details to Public, make sure that game is not individually marked Private, then retry |
| Catalogue browse looks empty | co-op filter plus untagged rows | untagged rows stay visible by design; check `is_coop` |
| `pkill -f harness.mjs` kills your shell | the pattern matches the shell's own command line | `pkill -f "[h]arness.mjs"` |

### A seeded instance cannot be entered through the product

`seed.sql` ships `invite_code = NULL` (joining disabled) and group 1's only owner is
the placeholder `seed:1:ama`, which can never log in. So there is no member who can
rotate the code and no link to join with. The first human has to be let in
out-of-band, once:

```bash
npx wrangler d1 execute g4m1ng --remote --yes --command \
  "UPDATE groups SET invite_code='ABCDEFGHJK' WHERE id=1"
```

Then visit `/?join=ABCDEFGHJK` and claim an identity. Codes use a 32-symbol
alphabet with no `O/0/I/1` so they survive being read aloud, and the validator only
accepts `[A-Z0-9]{6,24}`.

Signing in *without* doing this lands you in the "you're not in a group yet"
onboarding, where creating a group silently makes a **second**, empty one.

### `npm run setup` is only re-runnable up to a point

The seed and recommendations imports are nested inside the "schema did not exist"
branch, so a run that dies after the schema is applied can never offer them again —
the re-run sees existing tables and only offers to wipe. Import them by hand
instead:

```bash
npx wrangler d1 execute g4m1ng --remote --file=./seed.sql
```

---

## Costs

€0/month on the free plan, and the free plan is not a trial and does not sleep.

- Pages: unlimited static requests, **static assets are not metered**
- Functions: 100,000 invocations/day
- D1: 5 GB storage, 5 million reads/day
- Cron Workers: 100,000 invocations/day (this uses 24)

The vendored `hls.min.js` costs nothing at runtime — hls.js pulls video segments
from Steam's CDN straight to the browser, never through a Worker.

A custom domain is free on Cloudflare; you only pay a registrar (~€10/year). That
is also the way to stop the `pages.dev` hostname mattering.
