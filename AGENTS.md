# AGENTS.md

Entry point for coding agents. Read this, then **`CLAUDE.md`**, which is the long
form: the invariants with the measurements behind them, and every trap already paid
for. `docs/OPERATIONS.md` is the deploy/database runbook. `README.md` is the product.

If you change behaviour, update the corresponding doc in the same commit. Several
comments in this codebase exist specifically to stop a future editor "simplifying" a
security check or a measured constant — leave those in place.

---

## What this is

A multi-tenant co-op game tracker. Cloudflare Pages + Pages Functions + D1
(SQLite), Steam OpenID for identity. **No framework, no bundler, no build step** —
edit a file and deploy. `wrangler` is the only devDependency; `public/vendor/hls.min.js`
is the only vendored runtime dependency.

Live at <https://coopqueue.app>.

## Before you finish

```bash
npm test                 # 183 assertions — MUST pass before any deploy
node test/harness.mjs    # local UI; SCENARIO=anon|fresh|claim|member
npm run deploy           # pins --branch main; see OPERATIONS.md for why
```

There is **no type-checking and no build**, so an unresolved import surfaces only at
deploy time — `npm test` does not import every route. `docs/OPERATIONS.md` has a
one-liner import guard; run it after adding or renaming a module.

**`npm test` does not execute `public/app.js` at all.** Nothing does, outside a
browser, so a renamed variable that leaves a stale reference in a render function is
invisible to the suite — it throws at runtime and silently kills every panel drawn
after it. That has now happened twice, both times only caught by a screenshot. After
touching `app.js`, open the harness and click through **all six views** (`queue`,
`next`, `library`, `browse`, `stats`, `members`) with the console open; anything
logged is a regression, and a half-empty panel is the signature.

`npm run dev` works but Steam OpenID cannot redirect to `localhost`, so use the
harness for anything UI. `npm run test:ui` does **not** run on macOS (imports
`playwright`, which is not in `package.json`, and hardcodes a Linux Chrome path).

## Hard rules

These are the ones that cause real damage. `CLAUDE.md` has the full list of seven
invariants plus the evidence.

1. **`schema.sql` must never touch a live database.** It opens with `DROP TABLE`.
   Applying it to an existing remote database wipes everything; the old remote
   `db:init` shortcut was removed. Changes to a live database
   go in `migrations/` as additive, idempotent files. New columns go in **both**
   `schema.sql` and a migration.

2. **The tenancy boundary is `functions/api/g/[slug]/_middleware.js`**, and it returns
   **404, not 403**, so private groups cannot be discovered by guessing URLs.

3. **Every query below that boundary still filters on `data.group.group_id`.** Game
   ids are global and sequential, so being a member of group A must not let you
   `PATCH /api/g/group-a/games/5000` and hit group B's row. This is the easiest bug
   to reintroduce when adding an endpoint — add a case to `test/isolation.mjs` for
   every new route.

4. **`/api/coop` is deliberately group-blind** — no slug, no membership read, nothing
   group-scoped, asserted by two tests. Anything needing the group's own data goes
   *below* the tenancy boundary instead (that is why `recommend.js` is a separate
   route rather than a `sort=` on the catalogue).

5. **Steam metadata goes through the cache-first helpers in `lib/steam.js`**, never
   a raw route fetch. Full records use `getAppDetails(db, appid)`; the selective
   wishlist preview may use `getAppSummaries(db, appids)` for one bounded batch of
   names and art. Summary rows stay deliberately stale (`fetched_at = 0`) so full
   enrichment still runs. Steam throttles ~200 requests / 5 min per IP and Workers
   share an egress pool.

6. **`max_players` is written only by a human.** It means max *simultaneous online
   co-op* players. Steam publishes no reliable machine-readable cap, so unverified
   caps render as "player count unverified" and the fit filter **excludes** them
   rather than claiming they fit. That is the claim that costs someone money.

7. **Rebuilding a table drops its children.** `DROP TABLE games` fires
   `ON DELETE CASCADE` on ratings, comments and skips, and `PRAGMA
   defer_foreign_keys` does **not** prevent it — only the violation check is
   deferred, the cascade still runs. Any migration that recreates a table must stash
   and restore the children, and must be replayed over a real `db:backup` first with
   row counts compared. See migration 017.

8. **Never hard-delete a game.** Removing sets `games.archived_at`; a real DELETE
   cascades away every rating, and ratings are the one thing here that cannot be
   recreated. Anything counting the library filters on `archived_at IS NULL`.

## Things that are measured, not preferences

Do not "improve" these without redoing the measurement. Each one is written up with
its numbers in `CLAUDE.md`.

- **The co-op classifier excludes PvP genres; it does not require a co-op tag.**
  Requiring one hid 20 of 42 games this group demonstrably plays co-operatively,
  because 24% of real co-op games carry no co-op tag at all. `lib/coop.js`.
- **Tags come from store-page HTML**, not SteamSpy (no data for 118 of 337 rows) and
  not `genres` (235 of 337 are "Action").
- **The player colour order** in `SERIES` (`public/app.js`). Run
  `scripts/validate-palette.mjs`; do not pick by eye. Maximising the colour-blind
  worst case alone picks two reddish hues and reintroduces the original complaint.
- **`POP_WEIGHT = 0.02`** in `lib/recommend.js`. Larger and the popularity tiebreak
  reorders genuine matches, making the displayed fit column non-monotonic.
- **Tag preferences are IDF-weighted, and `NON_TASTE` is a stoplist.** Without both,
  common tags outvote specific ones and shipping-state tags read as taste — real
  output had four driving simulators above a Souls-like for a Souls-like group.
- **`hls.min.js` must stay the FULL build.** The light build parses but cannot play
  Steam's separate audio rendition, so trailers run silently.
- **Scoring is the plain mean.** A calibrated-and-shrunk score existed and was
  removed by the owner on purpose.

## Layout

```
functions/api/          Pages Functions (the API)
  g/[slug]/             everything group-scoped — behind _middleware.js
lib/                    shared pure modules: auth, steam, score, stats, coop, recommend, groups, ownership
public/                 the entire frontend: index.html, app.js, styles.css, brand/
  vendor/hls.min.js     the one vendored dependency
crawler/                the hourly cron Worker (Pages Functions cannot carry crons)
migrations/             additive, idempotent, applied by hand
scripts/                setup, crawl, IGDB measurement, tags, palette validation
test/isolation.mjs      183 assertions against the REAL route handlers
test/harness.mjs        local server; reimplements routes over real lib/ + schema
schema.sql              fresh installs and tests ONLY — never production
```

`lib/` modules are pure and shared between the Functions and the harness on purpose,
so the local ordering is the shipped ordering.

## Conventions

- Comments explain **why**, not what.
- Two-space indent, single quotes, semicolons. No TypeScript.
- Commit messages: short imperative subject, then a paragraph on the reasoning where
  it is not obvious.
- Deliberate-looking oddities usually are: the D1 database is still named `g4m1ng`,
  the cookie is `g4_session`, and group 1's slug is `g4m1ng`. Three unrelated
  identifiers that share an old name. Do not tidy them.

## Verify against reality

The recurring lesson in this project's history is that the docs and the APIs both
lie, and small samples mislead. Claims that were wrong until measured: Steam's
review sort order, hls.js light-build audio support, `canPlayType` for HLS, the
colour palette's colour-blind separation, a co-op classifier validated on four
games, and a "tiebreak" large enough to reorder real results.

Tests confirm a ranking is self-consistent. They cannot tell you it is **useless** —
check output against real data after touching anything that ranks or classifies.
