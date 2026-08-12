/**
 * CoopQueue catalogue crawler — a cron Worker, separate from the Pages project.
 *
 * It has to be a Worker: Pages Functions cannot carry Cron Triggers, so a
 * scheduled job cannot live in functions/. It binds the same D1 database, so
 * there is one catalogue, not two.
 *
 * Why it works in small batches rather than crawling everything at once:
 *
 *  - The Workers free plan allows 50 subrequests per invocation. A full pass is
 *    two Steam calls per game plus a search page — several hundred requests — so
 *    one invocation physically cannot do it. BATCH is sized to stay under the cap
 *    with room to spare.
 *  - Steam's store endpoints throttle at roughly 200 requests / 5 min per IP, and
 *    Workers egress from a shared pool. A small batch every hour sits far
 *    below that, where a burst would risk poisoning the shared address.
 *
 * So the catalogue converges instead of being rebuilt: each run refreshes the
 * stalest rows and pulls one page of discovery. A few hundred games come fully
 * up to date within hours and stay that way.
 *
 * What it never writes: max_players, max_players_src, coop_note. Those are
 * human-verified (invariant 6) and a crawl must not flatten them.
 */
import {
  UA, searchUrl, detailsUrl, reviewsUrl, storeTagsUrl, STORE_HEADERS,
  parseSearchItems, shapeDetails, parseReviews, parseStoreTags, OBVIOUS_NON_GAME,
} from '../lib/coop.js';

/**
 * Total games upserted per run, discovery and refresh together. 3 subrequests each,
 * +2 search pages, +LIBRARY_TAG_BATCH store pages, against a hard cap of 50:
 * 12 x 3 + 2 + 4 = 42, leaving eight spare.
 *
 * Raised 9 -> 12 when the third discovery source landed. Discovery is budgeted
 * first, so with eight candidates queued a batch of 9 left exactly one refresh per
 * run and the catalogue stopped converging; a run measured 23 subrequests against
 * a cap of 50, so the headroom was there.
 */
const BATCH = 12;
/** Library games tagged per run. One store page each, inside the same 50 cap. */
const LIBRARY_TAG_BATCH = 4;
/** Tracked-but-uncatalogued games pulled in per run. 3 subrequests each. */
const TRACKED_DISCOVERY = 3;
/** Search pages to rotate through for discovery, one per run. */
const DISCOVERY_PAGES = 8;
/** Below this many reviews a game is abandoned shovelware; not worth listing. */
const MIN_REVIEWS = 200;

/**
 * A second discovery pass, sorted by release date, with its own much lower floor.
 *
 * The top-sellers pass cannot find new releases, and that is not a tuning problem
 * — a game released this week has almost no reviews yet, so MIN_REVIEWS rejects it
 * by design. Measured against live Steam: "Gears of War: E-Day" sat in the co-op
 * top sellers with 0 reviews. Without this pass the catalogue would only ever
 * learn about a game months after it came out.
 *
 * The floor is not zero, because Steam's co-op category is full of unreleased
 * listings and asset flips. A handful of reviews is enough to show a real game
 * that real people can actually buy.
 */
const NEW_RELEASE_MIN_REVIEWS = 15;
const NEW_RELEASE_PAGES = 2;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data, null, 2), {
    status, headers: { 'content-type': 'application/json' },
  });

const fetchWithTimeout = (url, options = {}) => fetch(url, {
  ...options,
  signal: AbortSignal.timeout(10_000),
}).catch(() => null);

async function getJson(url) {
  const r = await fetchWithTimeout(url, { headers: UA });
  if (!r?.ok) return null;
  return r.json().catch(() => null);
}

/** Store-page HTML, for the tags that exist nowhere in Steam's JSON APIs. */
async function getStoreHtml(url) {
  const r = await fetchWithTimeout(url, { headers: STORE_HEADERS, redirect: 'follow' });
  if (!r?.ok) return null;
  return r.text().catch(() => null);
}

/**
 * One pass: discover from a rotating search page, then refresh the stalest rows.
 * Returns a summary so both cron logs and the manual trigger can report it.
 */
async function crawlOnce(env, { batch = BATCH } = {}) {
  const db = env.DB;
  const out = { discovered: 0, refreshed: 0, rejected: 0, thin: 0, failed: 0, subrequests: 0 };

  // ── discovery: rotate through search pages so new releases get picked up ────
  // The page index rides on the DB rather than in memory, since each invocation
  // is a cold start with no recollection of the last one.
  const cursorRow = await db.prepare(
    "SELECT value FROM crawl_state WHERE key = 'discovery_page'").first();
  const page = Number(cursorRow?.value ?? 0) % DISCOVERY_PAGES;

  // Two passes: what sells, and what just came out. The second exists because the
  // first structurally cannot see new releases — see NEW_RELEASE_MIN_REVIEWS.
  const sellers = await getJson(searchUrl({ start: page * 50, count: 50 }));
  out.subrequests++;
  const newest = await getJson(
    searchUrl({ start: (page % NEW_RELEASE_PAGES) * 50, count: 50, sort: 'Released_DESC' }));
  out.subrequests++;

  const known = new Set(
    (await db.prepare('SELECT appid FROM coop_apps').all()).results?.map((r) => r.appid) ?? []);
  const pick = (json, floor) => parseSearchItems(json)
    .filter((c) => !known.has(c.appid) && !OBVIOUS_NON_GAME.test(c.name))
    .map((c) => ({ ...c, floor }));

  // Leave most of the subrequest budget for refreshing; discovery is the smaller
  // half of the job once the catalogue exists.
  /* A third source, and on measurement the most valuable one: games that groups
     have actually put in a library and the catalogue has never heard of.
     Discovery is otherwise `globaltopsellers` plus recent releases, and both are
     biased toward what is selling *now* — so the catalogue systematically misses
     older co-op staples. Measured against group 1's Play next: six of its top ten
     picks were absent, including Overcooked, Broforce, Dark Souls III and Keep
     Talking and Nobody Explodes, and 42 of its 97 linked games could not have been
     recommended to anybody. Across all groups here it is 117 co-op games.

     They go through the same `upsert` as anything else, so the type check still
     rejects DLC and expansions and the review floor still applies — the lenient
     one, because a game a real group chose to track has passed a filter a search
     page has not. Self-limiting: once the backlog is absorbed this returns nothing. */
  /* A cursor, not just `ORDER BY appid LIMIT 3`, because some of these can never
     succeed: Steam answers `success: false` for a delisted app (Plants vs. Zombies
     GOTY, here), and `upsert` rejects DLC and anything under the review floor. Such
     a row stays absent from `coop_apps` forever, so a plain ordered query would
     re-attempt it every hour and permanently occupy one of the three slots — three
     of them and the pass makes no progress at all, silently.

     The cursor guarantees forward motion and wraps at the end of the list, which
     also gives the failures one retry per lap in case Steam changes its mind. Same
     idiom as `discovery_page` above, for the same reason: a Worker invocation is a
     cold start with no memory of the last one. */
  const trackedFrom = Number(
    (await db.prepare("SELECT value FROM crawl_state WHERE key = 'tracked_cursor'").first())?.value ?? 0);
  const trackedQuery = (after) => db.prepare(
    `SELECT DISTINCT g.steam_appid AS appid FROM games g
      WHERE g.steam_appid IS NOT NULL AND g.archived_at IS NULL
        AND g.steam_appid > ?
        AND NOT EXISTS (SELECT 1 FROM coop_apps c WHERE c.appid = g.steam_appid)
      ORDER BY g.steam_appid LIMIT ?`
  ).bind(after, TRACKED_DISCOVERY).all();
  let tracked = await trackedQuery(trackedFrom);
  if (!(tracked.results || []).length && trackedFrom > 0) tracked = await trackedQuery(0);
  const trackedIds = (tracked.results || []).map((r) => r.appid);
  await db.prepare(
    `INSERT INTO crawl_state (key, value, updated_at) VALUES ('tracked_cursor', ?, unixepoch())
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()`
  ).bind(String(trackedIds.length ? trackedIds[trackedIds.length - 1] : 0)).run();

  const fresh = [...pick(sellers, MIN_REVIEWS).slice(0, 3),
                 ...pick(newest, NEW_RELEASE_MIN_REVIEWS).slice(0, 2),
                 ...trackedIds.map((appid) => ({ appid, floor: NEW_RELEASE_MIN_REVIEWS }))];
  for (const c of fresh) {
    if (await upsert(db, c.appid, out, c.floor)) out.discovered++;
  }

  await db.prepare(
    `INSERT INTO crawl_state (key, value, updated_at) VALUES ('discovery_page', ?, unixepoch())
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()`
  ).bind(String((page + 1) % DISCOVERY_PAGES)).run();

  /* ── refresh: oldest crawled_at first, so the whole table converges ─────────
     Budgeted against ATTEMPTS, not successes. A discovery upsert costs its three
     subrequests whether or not it produces a row, and with three sources feeding
     `fresh` the old `batch - out.discovered` could authorise nine refreshes on top
     of eight failed discoveries — 51 subrequests against a hard cap of 50. */
  const remaining = Math.max(0, batch - fresh.length);
  if (remaining) {
    const stale = await db.prepare(
      'SELECT appid, review_count FROM coop_apps ORDER BY crawled_at ASC LIMIT ?').bind(remaining).all();
    for (const row of stale.results || []) {
      // Refresh judges an existing row by the floor it got in under, or new
      // releases would be added by one pass and deleted by the next.
      const lenient = (row.review_count ?? 0) < MIN_REVIEWS ? NEW_RELEASE_MIN_REVIEWS : MIN_REVIEWS;
      if (await upsert(db, row.appid, out, lenient)) out.refreshed++;
    }
  }

  /* ── library tags: what the catalogue does not cover ──────────────────────
     The recommender learns a group's taste from tags on the games it has rated,
     and those only ever came from `coop_apps`. A rated game the crawler has never
     listed therefore taught it nothing — 45 of group 1's 103 rated games, and the
     most characteristic ones. See migration 031 for the measurement.

     One store page each and no `appdetails` call, so this is the cheapest pass
     here; kept small anyway because BATCH already sizes the run against the
     50-subrequest cap. Rows already tagged in the catalogue are skipped, since the
     route prefers that copy. */
  for (const row of (await db.prepare(
    `SELECT s.appid FROM steam_apps s
      WHERE s.tags IS NULL
        AND EXISTS (SELECT 1 FROM games g WHERE g.steam_appid = s.appid)
        AND NOT EXISTS (SELECT 1 FROM coop_apps c WHERE c.appid = s.appid AND c.tags IS NOT NULL)
      ORDER BY s.appid LIMIT ?`
  ).bind(LIBRARY_TAG_BATCH).all()).results || []) {
    try {
      const parsed = parseStoreTags(await getStoreHtml(storeTagsUrl(row.appid)));
      out.subrequests++;
      // No tag block means an age gate or a delisted app. Leaving it NULL is what
      // makes it eligible again next run; writing [] would retire it forever.
      if (!parsed) continue;
      await db.prepare('UPDATE steam_apps SET tags = ?, tags_at = unixepoch() WHERE appid = ?')
        .bind(JSON.stringify(parsed.tags), row.appid).run();
      out.libraryTagged = (out.libraryTagged || 0) + 1;
    } catch { out.failed++; }
  }

  await db.prepare(
    `INSERT INTO crawl_state (key, value, updated_at) VALUES ('last_run', ?, unixepoch())
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()`
  ).bind(JSON.stringify(out)).run();

  return out;
}

/**
 * Fetch and store one appid. Returns true when a row was written.
 * `floor` is the review count below which the game is not worth listing — lower
 * for a brand-new release than for something that has been out for years.
 */
async function upsert(db, appid, out, floor = MIN_REVIEWS) {
  const details = await getJson(detailsUrl(appid));
  out.subrequests++;
  const shaped = shapeDetails(appid, details);
  if (!shaped) { out.failed++; return false; }
  if (shaped.rejected) {
    out.rejected++;
    // Drop anything that turns out not to be a game, so DLC that slipped in
    // during an earlier crawl gets cleaned up rather than lingering forever.
    await db.prepare('DELETE FROM coop_apps WHERE appid = ?').bind(appid).run();
    return false;
  }

  const reviews = parseReviews(await getJson(reviewsUrl(appid)));
  out.subrequests++;

  const total = reviews?.total ?? 0;
  if (total < floor) {
    out.thin++;
    await db.prepare('DELETE FROM coop_apps WHERE appid = ? AND max_players IS NULL')
      .bind(appid).run();
    return false;
  }

  /* Steam user tags, read off the store page. Steam's own genre is too coarse to
     sort or recommend on — most of a co-op catalogue is simply "Action" — and tags
     appear in no Steam JSON API. SteamSpy publishes them as JSON but had nothing
     for any of the 118 newest rows in this catalogue; see lib/coop.js.

     Deliberately after the review floor: this is a ~200KB page, and a game about to
     be dropped for being too thin should not cost a subrequest to describe. */
  const tags = parseStoreTags(await getStoreHtml(storeTagsUrl(appid)));
  out.subrequests++;
  if (tags) out.tagged = (out.tagged || 0) + 1;

  // popularity_rank is recomputed table-wide after the batch, not here — a rank
  // is a position among all rows and cannot be known from one game.
  await db.prepare(
    `INSERT INTO coop_apps (appid, name, review_count, review_hint, header_image,
                            short_description, genre, price, release_date, release_ts,
                            metacritic, coop_categories, tags, is_coop, tags_at, crawled_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,unixepoch())
     ON CONFLICT(appid) DO UPDATE SET
       name = excluded.name, review_count = excluded.review_count,
       review_hint = excluded.review_hint, header_image = excluded.header_image,
       short_description = excluded.short_description, genre = excluded.genre,
       price = excluded.price, release_date = excluded.release_date,
       release_ts = excluded.release_ts, metacritic = excluded.metacritic,
       coop_categories = excluded.coop_categories,
       -- Keep whatever tags we already had if SteamSpy did not answer this time.
       tags = COALESCE(excluded.tags, coop_apps.tags),
       is_coop = COALESCE(excluded.is_coop, coop_apps.is_coop),
       tags_at = COALESCE(excluded.tags_at, coop_apps.tags_at),
       crawled_at = unixepoch()`
  ).bind(
    appid, shaped.name, total, reviews?.desc ?? null, shaped.header_image,
    shaped.short_description, shaped.genre, shaped.price, shaped.release_date,
    shaped.release_ts, shaped.metacritic, JSON.stringify(shaped.coop_categories || []),
    tags ? JSON.stringify(tags.tags) : null,
    tags ? (tags.isCoop ? 1 : 0) : null,
    tags ? Math.floor(Date.now() / 1000) : null
  ).run();
  return true;
}

/**
 * Renumber popularity_rank across the table from stored review counts.
 *
 * Deliberately does nothing until every row has a review_count. The bulk seed
 * ranked by review count but only stored the score summary, so those rows start
 * NULL — and ranking on COALESCE(review_count, 0) while most rows are NULL
 * collapses the entire catalogue to rank 1 and destroys the ordering the seed
 * got right. The seeded ranks stay authoritative until the incremental refresh
 * has filled in real counts everywhere, then this takes over on its own.
 */
async function reRank(db) {
  const gap = await db.prepare(
    'SELECT COUNT(*) AS n FROM coop_apps WHERE review_count IS NULL').first();
  if ((gap?.n ?? 0) > 0) return { reranked: false, awaitingCounts: gap.n };

  await db.prepare(
    `UPDATE coop_apps SET popularity_rank = (
       SELECT COUNT(*) + 1 FROM coop_apps b WHERE b.review_count > coop_apps.review_count)`
  ).run();
  return { reranked: true };
}

export default {
  async scheduled(event, env, ctx) {
    const out = await crawlOnce(env);
    const rank = await reRank(env.DB);
    console.log('crawl', JSON.stringify({ ...out, ...rank }));
  },

  /**
   * Manual trigger, so a run can be watched instead of waited for. Requires the
   * same CRAWL_TOKEN the deployer set — this endpoint spends Steam quota, and
   * Workers egress from a shared IP pool.
   */
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      const state = await env.DB.prepare('SELECT key, value, updated_at FROM crawl_state').all();
      const counts = await env.DB.prepare(
        `SELECT COUNT(*) AS games, COUNT(max_players) AS verified,
                MIN(crawled_at) AS stalest, MAX(crawled_at) AS freshest FROM coop_apps`).first();
      return json({ ok: true, counts, state: state.results });
    }
    if (url.pathname !== '/run') return json({ error: 'not found' }, 404);
    if (!env.CRAWL_TOKEN || url.searchParams.get('token') !== env.CRAWL_TOKEN) {
      return json({ error: 'unauthorised' }, 401);
    }
    const out = await crawlOnce(env, { batch: Number(url.searchParams.get('batch')) || BATCH });
    const rank = await reRank(env.DB);
    return json({ ...out, ...rank });
  },
};
