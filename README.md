# CoopQ

A co-op game tracker for groups of friends. Sign in with Steam, create a group,
rate games in a queue with the trailer playing, suggest new ones by pasting a
store link, and settle "what next" with a score that accounts for who actually
bothered to vote — and for whether your whole group can even fit in the lobby.

Multi-tenant: any number of groups, each with its own library, members and
headcount. One person can belong to several.

**Running cost: €0/month** on Cloudflare's free tier, which is not a trial and
does not sleep. Rough headroom is in [Scaling](#scaling-and-what-it-would-cost).

---

## What it does

**Rate.** A queue of everything you personally haven't scored yet, one card at a
time, with the Steam trailer embedded. Keyboard-driven: `1`–`9` (`0` = 10),
`←` `→` to nudge by half a point, `Enter` to save and advance, `S` to skip.
Forty unrated games takes about three minutes.

**Play next.** The backlog ranked, with anything that can't fit your group
pushed into a separate block rather than silently sorted to the bottom.

**Library.** Every game, every score, sortable — including by "most
disagreement" and "fewest votes", which is how you find what needs attention.
Filterable by whose votes a game already has, by group score, and by whether
anyone has logged hours.

**Browse.** The most-reviewed online co-op games on Steam, as a global
catalogue. Pull the ones your group might play into its **pool** — and only
pooled games ever appear in anyone's rating queue. That opt-in step is the whole
point: a catalogue of thousands would otherwise bury the handful of votes that
decide what you actually play. Games whose player cap nobody has verified say so
rather than guessing, and the "only ones we can all play" filter leaves them out
instead of claiming they fit.

**Coverage.** Your own unrated count sits above the rating queue, and the Group
tab ranks everyone by how much of the library they have scored. Rating coverage
is the thing that decides whether any of the scoring means anything, so it is
not hidden in a stats page.

**Stats.** Per-person baselines, genre track record, and a dot plot of your
biggest arguments.

**Group.** Members, invite links you can rotate or disable, and the headcount
that drives the viability check.

### The scoring model

Two corrections, both in [`lib/score.js`](lib/score.js):

1. **Calibration.** Each rating becomes a z-score against that person's own mean
   and spread, so a 7 from a generous rater and a 7 from a harsh one aren't
   treated as the same signal.
2. **Shrinkage.** A 9.0 from one person is weaker evidence than a 7.5 from four,
   so the group score is pulled toward the overall mean by `n / (n + 1.6)`. One
   vote keeps ~38% of its distance from the mean; four keep ~71%.

Set `SHRINKAGE_K = 0` to turn shrinkage off.

### The viability check

Every game carries `max_players` — the maximum *simultaneous online co-op*
count, which is frequently not what a store page advertises. Compared against
the group's own headcount, a game is viable, blocked, or a workaround (couch
co-op that works over Remote Play Together, or one-copy games like Keep Talking
and Nobody Explodes). Steam's own co-op tags are stored as a hint but never
treated as the truth, because they routinely are not.

---

## Accounts and login

**There is no registration.** No email, no password, no confirmation link —
nothing to store and nothing to reset. Everyone signs in with **Steam OpenID**,
which is free, needs no approval from Valve, and is the same "Sign in through
Steam" flow people already know from Humble Bundle and SteamDB.

What actually happens on first sign-in:

1. The person clicks *Sign in through Steam* and lands on Valve's own login
   page. They type their Steam password **on steamcommunity.com**, never here —
   this site never sees a credential of any kind.
2. Steam redirects back with a claim, which the server hands straight back to
   Steam (`mode=check_authentication`). Nothing in that redirect is trusted
   until Valve confirms it. This matters: without the callback check, OpenID is
   trivially forgeable by editing the URL.
3. On success we store one row — their SteamID64, display name and avatar — and
   set a signed session cookie good for 90 days.

That account is just an identity. It grants access to nothing until they either
**create a group** or **join one with an invite link**. Groups are private by
default: a non-member asking for `/api/g/some-group/games` gets a 404, not a
403, so a private group can't even be confirmed to exist by guessing the URL.

So for your four: you sign in, claim the "Ama" identity, create an invite link
on the Group tab, and send it to the other three. They click it, sign in with
Steam, and land straight in the group with the claim prompt waiting.

Using Steam rather than email has one more payoff. Because a SteamID64 is a real
Steam account, the v2 features come almost free: actual playtime per person,
achievement completion, and "who already owns this" all come from Steam's public
Web API keyed on the ID you already have.

If you want the instance private while you try it out, set `ALLOWED_STEAM_IDS`
and only those Steam accounts can sign in at all. Leave it unset to let anyone
create their own groups.

---

## Setup

One command does the whole thing:

```bash
npm install
npm run setup
```

It will open a browser once for the Cloudflare login, then create the Pages
project and the D1 database, write the database id into `wrangler.toml`, apply
the schema, offer to import the 92-game seed data, generate and store
`SESSION_SECRET`, prompt for an optional Steam API key, and deploy. It prints
your live URL at the end.

The script is safe to re-run — every step checks for existing state first, so if
something fails you can fix it and run it again without duplicating anything.
It will never wipe existing data without asking.

You need a free Cloudflare account (no card) and, optionally, a free Steam Web
API key from <https://steamcommunity.com/dev/apikey>. The key is used only for
display names and avatars; skip it and people show up as `Player 1234`.

### Deploying from GitHub instead

For a real product you probably want pushes to deploy themselves. After running
`npm run setup` once, go to Workers & Pages → **g4m1ng** → Settings → Builds,
connect the GitHub repo, set the build command to nothing and the output
directory to `public`. Every push to `main` then deploys, and pull requests get
preview URLs. The D1 binding comes from the committed `wrangler.toml`; secrets
stay in the dashboard.

### Doing it by hand

<details>
<summary>If you would rather run the steps yourself</summary>

```bash
npx wrangler login
npx wrangler pages project create g4m1ng --production-branch main
npx wrangler d1 create g4m1ng            # paste the id into wrangler.toml
npx wrangler d1 execute g4m1ng --remote --file=./schema.sql
npx wrangler d1 execute g4m1ng --remote --file=./seed.sql      # optional
openssl rand -base64 32 | npx wrangler pages secret put SESSION_SECRET --project-name g4m1ng
npx wrangler pages secret put STEAM_API_KEY --project-name g4m1ng
npm run deploy
```

</details>

### After the first deploy

Imported games have names but no Steam links, so the queue has no trailers for
them yet. Sign in, open your group, and:

```bash
curl -X POST https://YOUR-SITE.pages.dev/api/g/g4m1ng/enrich \
     -H "Cookie: g4_session=..."   # copy from browser devtools
```

Eight games per call — Steam throttles at roughly 200 requests per 5 minutes —
and only unambiguous name matches link automatically. Repeat until `remaining`
is 0. Anything in `needsReview` you link by hand: open the game in the Library
and paste its store URL. Being conservative here is deliberate; a wrong appid
means the wrong trailer plays in the queue.

For a custom domain, add it under Workers & Pages → g4m1ng → Custom domains.
Cloudflare charges nothing for the hosting; you just pay a registrar for the
domain (~€10/year).

---

## Local development

```bash
cp .dev.vars.example .dev.vars     # then edit SESSION_SECRET
npm run db:init:local
npm run dev
```

Steam OpenID won't redirect back to `localhost`, so for UI work use the test
harness instead — it serves the real frontend against an in-memory copy of the
schema with auth stubbed:

```bash
node test/harness.mjs                 # signed in, claimed, two groups
SCENARIO=anon  node test/harness.mjs  # landing page
SCENARIO=fresh node test/harness.mjs  # signed in, no groups
SCENARIO=claim node test/harness.mjs  # first run in a group
```

### Tests

```bash
node test/isolation.mjs   # 22 tenancy / permission / scoring assertions
node test/shots.mjs       # renders every screen, fails on any console error
```

`isolation.mjs` imports the **real route handlers** and runs them against a D1
shim over SQLite, so it tests shipped code rather than a reimplementation. It
covers the things that would actually hurt: cross-group reads, cross-group
writes by guessed id, invite-code validation, owner-only actions, and the
last-owner-can't-leave rule.

---

## Layout

```
functions/
  _middleware.js                 who are you — session cookie → users row
  api/
    auth/steam.js                start Steam OpenID (carries an invite code)
    auth/callback.js             verify with Steam, set the signed cookie
    me.js                        current user + their groups
    groups/index.js              GET my groups · POST create one
    groups/join.js               POST an invite code
    steam/search.js              store search for the add-a-game box
    g/[slug]/
      _middleware.js             THE TENANCY BOUNDARY — membership or 404
      games/index.js             GET the group library with scores · POST add
      games/[id].js              PATCH · DELETE · PUT to link a Steam appid
      rate.js  skip.js  stats.js  claim.js  members.js  enrich.js
lib/
  auth.js      HMAC-signed cookie sessions, optional signup allowlist
  groups.js    slugs, invite codes, membership lookup
  score.js     calibration + shrinkage + viability
  steam.js     Steam Web API and store endpoints, cache-first
  http.js      JSON responses, body parsing, score clamping
public/        index.html · app.js · styles.css — no build step
scripts/setup.mjs                one-command Cloudflare provisioning
schema.sql · seed.sql · recommendations.sql
test/          harness.mjs · isolation.mjs · shots.mjs
```

No framework, no bundler. Edit a file, `npm run deploy`, done.

### How tenancy works

Every group-scoped route lives under `functions/api/g/[slug]/`, and
`_middleware.js` there is the only place that decides whether you're allowed in.
It looks up your membership and, failing that, returns **404 rather than 403** —
so the existence of a private group can't be probed by guessing URLs.

Below that boundary, every single statement still filters on
`data.group.group_id`. Game ids are global and sequential, so
`PATCH /api/g/my-group/games/5000` must not touch group 2's game 5000 just
because you're a legitimate member of `my-group`. `test/isolation.mjs` asserts
exactly this for read, rate, patch, delete, and the rating queue.

### Security notes

Sessions are HMAC-SHA256-signed cookies (`HttpOnly`, `Secure`, `SameSite=Lax`,
90-day expiry) with no server-side session table. Steam OpenID responses are
verified by handing every parameter back to Steam with
`mode=check_authentication`; nothing in the callback URL is trusted before that
returns `is_valid:true`. Every database call uses bound parameters. All
user-supplied strings are escaped before reaching the DOM. Invite codes are
10 characters from a 32-symbol alphabet (~50 bits) and can be rotated or
disabled by the owner at any time.

Soft caps exist so one account can't exhaust the free tier: 20 owned groups per
person, 64 members per group, 2000 games per group.

---

## Scaling, and what it would cost

Free tier, per day: **100,000** Function requests, **5 million** D1 rows read,
**100,000** D1 rows written, **5 GB** storage. Static assets and bandwidth are
unmetered.

A rough sense of the shape: one person opening the app and rating twenty games
is on the order of a hundred requests and a few thousand row reads, because the
library loads in one call and everything after that filters client-side. A
hundred active groups is comfortably inside the free tier; a thousand is where
you'd start watching the dashboard. Storage is a non-issue — the whole original
spreadsheet is under 100 KB in D1.

If you outgrow it, **Workers Paid is $5/month** and includes 10 million requests
and 25 billion D1 row reads per month. That is the entire cost step; there is no
tier in between and no per-seat pricing. Realistically the site would need to be
genuinely popular before you'd notice.

**The actual constraint is Steam, not Cloudflare.** The store endpoints throttle
at roughly 200 requests / 5 minutes *per IP*, and Cloudflare Workers egress from
a shared pool. That's why `steam_apps` exists: metadata is cached globally by
appid with a 14-day TTL, so the thousandth group to add Terraria costs zero
Steam requests. Search can't be cached (unbounded query space) and is the thing
that would break first under load. If it does, the fix is a debounce on the
client plus a KV-backed cache of the last N search terms.

Two things to know before opening it up: D1's free tier has **no automatic
backups** (run `wrangler d1 export` on a cron — also free), and there is
currently **no rate limiting** on writes beyond the soft caps. Cloudflare's
Rate Limiting rules are free and would be the first thing to add.

---

## Ideas for v2

- **Steam auto-sync.** You already store SteamID64s, so
  `IPlayerService/GetOwnedGames` and `ISteamUserStats/GetPlayerAchievements`
  would fill in real playtime and achievement completion per person. A
  Cloudflare cron trigger (free) could refresh nightly and auto-detect when the
  group has started something new.
- **"Who owns it"** badges from the same endpoint, so you stop buying a game two
  people already have.
- **Session log** — who played, when, for how long, so `hours` stops depending
  on somebody remembering to type it in.
- **A nudge.** A weekly Discord webhook listing what still has fewer than a full
  set of votes. Given how lopsided rating coverage tends to get, this is
  probably the highest-value addition on the list.
- **Public group pages** — a read-only shareable ranking, which is also the
  cheapest growth loop the site has.
