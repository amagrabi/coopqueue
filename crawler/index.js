/**
 * CoopQ catalogue crawler — a cron Worker, separate from the Pages project.
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
 *    Workers egress from a shared pool. A small batch every 15 minutes sits far
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
  UA, searchUrl, detailsUrl, reviewsUrl,
  parseSearchItems, shapeDetails, parseReviews, OBVIOUS_NON_GAME,
} from '../lib/coop.js';

/** Games refreshed per run. 2 subrequests each, +1 for discovery. Cap is 50. */
const BATCH = 14;
/** Search pages to rotate through for discovery, one per run. */
const DISCOVERY_PAGES = 8;
/** Below this many reviews a game is unreleased or abandoned; not worth listing. */
const MIN_REVIEWS = 200;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data, null, 2), {
    status, headers: { 'content-type': 'application/json' },
  });

async function getJson(url) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) return null;
  return r.json().catch(() => null);
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

  const search = await getJson(searchUrl({ start: page * 50, count: 50 }));
  out.subrequests++;
  const candidates = parseSearchItems(search);

  if (candidates.length) {
    // Only appids we have never seen are worth spending calls on; the refresh
    // half of this function keeps the ones we already have up to date.
    const known = new Set(
      (await db.prepare('SELECT appid FROM coop_apps').all()).results?.map((r) => r.appid) ?? []);
    const fresh = candidates.filter((c) => !known.has(c.appid) && !OBVIOUS_NON_GAME.test(c.name));
    // Leave most of the subrequest budget for refreshing.
    for (const c of fresh.slice(0, 4)) {
      const added = await upsert(db, c.appid, out);
      if (added) out.discovered++;
    }
  }

  await db.prepare(
    `INSERT INTO crawl_state (key, value, updated_at) VALUES ('discovery_page', ?, unixepoch())
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()`
  ).bind(String((page + 1) % DISCOVERY_PAGES)).run();

  // ── refresh: oldest crawled_at first, so the whole table converges ─────────
  const remaining = Math.max(0, batch - out.discovered);
  if (remaining) {
    const stale = await db.prepare(
      'SELECT appid FROM coop_apps ORDER BY crawled_at ASC LIMIT ?').bind(remaining).all();
    for (const row of stale.results || []) {
      if (await upsert(db, row.appid, out)) out.refreshed++;
    }
  }

  await db.prepare(
    `INSERT INTO crawl_state (key, value, updated_at) VALUES ('last_run', ?, unixepoch())
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()`
  ).bind(JSON.stringify(out)).run();

  return out;
}

/** Fetch and store one appid. Returns true when a row was written. */
async function upsert(db, appid, out) {
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
  if (total < MIN_REVIEWS) {
    out.thin++;
    await db.prepare('DELETE FROM coop_apps WHERE appid = ? AND max_players IS NULL')
      .bind(appid).run();
    return false;
  }

  // popularity_rank is recomputed table-wide after the batch, not here — a rank
  // is a position among all rows and cannot be known from one game.
  await db.prepare(
    `INSERT INTO coop_apps (appid, name, review_count, review_hint, header_image,
                            short_description, genre, price, release_date, release_ts,
                            metacritic, coop_categories, crawled_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,unixepoch())
     ON CONFLICT(appid) DO UPDATE SET
       name = excluded.name, review_count = excluded.review_count,
       review_hint = excluded.review_hint, header_image = excluded.header_image,
       short_description = excluded.short_description, genre = excluded.genre,
       price = excluded.price, release_date = excluded.release_date,
       release_ts = excluded.release_ts, metacritic = excluded.metacritic,
       coop_categories = excluded.coop_categories, crawled_at = unixepoch()`
  ).bind(
    appid, shaped.name, total, reviews?.desc ?? null, shaped.header_image,
    shaped.short_description, shaped.genre, shaped.price, shaped.release_date,
    shaped.release_ts, shaped.metacritic, JSON.stringify(shaped.coop_categories || [])
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
