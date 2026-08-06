#!/usr/bin/env node
/**
 * Crawl Steam's online-co-op catalogue into SQL for the coop_apps table.
 *
 *   node scripts/crawl-coop.mjs --pages 8 --out migrations/002-coop-seed.sql
 *   npm run db:migrate -- --file=./migrations/002-coop-seed.sql
 *
 * Why a script that emits SQL rather than an endpoint that writes directly:
 * Steam's store endpoints throttle at roughly 200 requests / 5 min per IP, and
 * Workers egress from a shared pool, so a crawl of any size cannot run inside a
 * request. Emitting a file also means the insert can be read before it is
 * applied, which matters because this is the one table a human curates.
 *
 * Three Steam calls are involved:
 *   - the search endpoint, which gives only a name and a capsule image URL (the
 *     appid has to be dug out of that URL)
 *   - appdetails per candidate, the only way to know whether an entry is a game
 *     at all. The co-op search happily returns DLC, demos and soundtracks — 141
 *     of the first 398 hits on one run — so this filter is not optional.
 *   - appreviews per candidate, for the true review count.
 *
 * That last call is not optional either, and the reason is a trap. Steam's
 * `sort_by=Reviews_DESC` sorts by review *score*, not review volume: it put a
 * 534-review DLC above Stardew Valley's million, and included games with zero
 * reviews. Ranking browse results by that ordering would surface obscurities
 * and bury the games a group has actually heard of. Popularity here therefore
 * means total_reviews, fetched per game, and discovery uses globaltopsellers —
 * which biases the crawl toward games people are actually buying.
 *
 * What it deliberately does NOT set: max_players. Steam exposes no reliable
 * machine-readable co-op player count and its own co-op categories are wrong
 * often enough to be dangerous (invariant 6), so the upsert leaves max_players,
 * max_players_src and coop_note untouched — a human fills those in, and a
 * re-crawl must never flatten that work.
 */
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};

const PAGES = Number(arg('pages', 4));
const OUT = arg('out', 'migrations/002-coop-seed.sql');
const CC = arg('cc', 'de');
const DISCOVER = arg('discover', 'globaltopsellers');
// A game nobody has reviewed is either unreleased or nobody is playing it.
// Either way it does not belong in a list meant to help a group choose.
const MIN_REVIEWS = Number(arg('minReviews', 200));
const PER_PAGE = 50;
const CATEGORY_ONLINE_COOP = 38;

// ~200 requests / 5 min is one per 1.5s. Sit just under it; a crawl that gets
// throttled halfway produces a half-empty catalogue with no error to explain it.
const GAP_MS = 1700;

const UA = { 'user-agent': 'CoopQ (co-op game tracker)' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sq = (v) =>
  v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`;
const num = (v) => (v === null || v === undefined || Number.isNaN(Number(v)) ? 'NULL' : Number(v));

/** Entries that are obviously not games, skipped before spending an appdetails call. */
const OBVIOUS_NON_GAME = /\b(soundtrack|ost|art\s?book|demo|season pass|upgrade pack)\b/i;

const MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
              jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
/**
 * Steam's release_date is a display string ('16 May, 2011'). Sorting it as text
 * is not chronological — it groups by day-of-month — so the browse "Newest" sort
 * needs a real timestamp alongside it. Unparseable values ('Coming soon') are
 * null, which sorts last.
 */
function releaseTs(s) {
  if (!s) return null;
  const t = s.trim();
  let m = /^(\d{1,2})\s+([A-Za-z]{3})[a-z]*,?\s+(\d{4})$/.exec(t);
  if (m && MON[m[2].toLowerCase()] != null) {
    return Math.floor(Date.UTC(+m[3], MON[m[2].toLowerCase()], +m[1]) / 1000);
  }
  m = /^([A-Za-z]{3})[a-z]*\s+(\d{4})$/.exec(t);           // 'Mar 2026'
  if (m && MON[m[1].toLowerCase()] != null) {
    return Math.floor(Date.UTC(+m[2], MON[m[1].toLowerCase()], 1) / 1000);
  }
  m = /^(?:Q[1-4]\s+)?(\d{4})$/.exec(t);                    // 'Q1 2026', '2026'
  if (m) return Math.floor(Date.UTC(+m[1], 0, 1) / 1000);
  return null;
}

async function searchPage(start) {
  const url = 'https://store.steampowered.com/search/results/'
    + `?query&category2=${CATEGORY_ONLINE_COOP}&filter=${DISCOVER}&json=1`
    + `&cc=${CC}&l=english&start=${start}&count=${PER_PAGE}`;
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`search start=${start} failed: HTTP ${r.status}`);
  const j = await r.json();
  return (j.items || []).map((it) => {
    // The search payload carries no appid; it is only present in the capsule URL.
    const m = /\/apps\/(\d+)\//.exec(it.logo || '');
    return m ? { appid: Number(m[1]), name: it.name } : null;
  }).filter(Boolean);
}

async function details(appid) {
  const url = `https://store.steampowered.com/api/appdetails?appids=${appid}&cc=${CC}&l=english`;
  const r = await fetch(url, { headers: UA });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  const entry = j?.[String(appid)];
  if (!entry?.success || !entry.data) return null;
  const d = entry.data;
  if (d.type !== 'game') return { rejected: d.type || 'unknown' };
  return {
    name: d.name,
    header_image: (d.header_image || '').replace(/^http:/, 'https:') || null,
    short_description: (d.short_description || '').replace(/<[^>]*>/g, '').trim() || null,
    genre: d.genres?.[0]?.description || null,
    price: d.is_free ? 'Free' : (d.price_overview?.final_formatted || null),
    release_date: d.release_date?.date || null,
    release_ts: releaseTs(d.release_date?.date),
    metacritic: d.metacritic?.score ?? null,
    coop_categories: (d.categories || [])
      .map((c) => c.description)
      .filter((c) => /co-?op|multi-?player/i.test(c)),
  };
}

/** True popularity. The search endpoint cannot give this; only appreviews can. */
async function reviewCount(appid) {
  const url = `https://store.steampowered.com/appreviews/${appid}`
    + '?json=1&num_per_page=0&language=all&purchase_type=all';
  const r = await fetch(url, { headers: UA });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  const s = j?.query_summary;
  return s ? { total: s.total_reviews ?? 0, desc: s.review_score_desc || null } : null;
}

const rows = [];
const skipped = { nonGame: 0, preFiltered: 0, noData: 0, tooFewReviews: 0, seen: 0 };
const seen = new Set();

for (let page = 0; page < PAGES; page++) {
  const start = page * PER_PAGE;
  let items;
  try { items = await searchPage(start); }
  catch (e) { console.error(`  ${e.message} — stopping here`); break; }
  if (!items.length) { console.log(`  page ${page + 1}: empty, catalogue exhausted`); break; }
  console.log(`page ${page + 1}/${PAGES} — ${items.length} candidates (rank ${start + 1}…)`);

  for (const it of items) {
    if (seen.has(it.appid)) { skipped.seen++; continue; }
    seen.add(it.appid);
    if (OBVIOUS_NON_GAME.test(it.name)) { skipped.preFiltered++; continue; }

    await sleep(GAP_MS);
    const d = await details(it.appid);
    if (!d) { skipped.noData++; continue; }
    if (d.rejected) { skipped.nonGame++; continue; }

    await sleep(GAP_MS);
    const rv = await reviewCount(it.appid);
    const total = rv?.total ?? 0;
    if (total < MIN_REVIEWS) { skipped.tooFewReviews++; continue; }

    rows.push({ appid: it.appid, reviews: total, review_hint: rv?.desc ?? null, ...d });
    if (rows.length % 25 === 0) console.log(`  … ${rows.length} games kept`);
  }
}

// Rank by real popularity, assigned after the fact — the crawl order is only a
// discovery path, never the ranking.
rows.sort((a, b) => b.reviews - a.reviews);
rows.forEach((g, i) => { g.rank = i + 1; });

const sql = `-- CoopQ — global co-op catalogue, crawled from Steam.
-- Generated by scripts/crawl-coop.mjs.
--
-- popularity_rank 1 is the most-REVIEWED online co-op game found, using review
-- counts fetched per game. It is NOT Steam's own sort order: Steam's
-- sort_by=Reviews_DESC ranks by review score, which puts 534-review curiosities
-- and zero-review listings above games with a million reviews.
--
-- ${rows.length} games kept, discovered via ${DISCOVER}, minimum ${MIN_REVIEWS} reviews.
-- Skipped: ${skipped.nonGame} not type 'game', ${skipped.preFiltered} obvious non-games,
-- ${skipped.tooFewReviews} below the review floor, ${skipped.noData} with no store data,
-- ${skipped.seen} duplicates across pages.
--
-- max_players is intentionally absent from the column list: this upsert must
-- never overwrite a player count a human verified. Re-running the crawl only
-- refreshes metadata and popularity.

${rows.map((g) => `INSERT INTO coop_apps
  (appid, name, popularity_rank, review_hint, header_image, short_description, genre,
   price, release_date, release_ts, metacritic, coop_categories, crawled_at)
VALUES (${num(g.appid)}, ${sq(g.name)}, ${num(g.rank)}, ${sq(g.review_hint)},
        ${sq(g.header_image)}, ${sq(g.short_description)}, ${sq(g.genre)}, ${sq(g.price)},
        ${sq(g.release_date)}, ${num(g.release_ts)}, ${num(g.metacritic)},
        ${sq(JSON.stringify(g.coop_categories))}, unixepoch())
ON CONFLICT(appid) DO UPDATE SET
  name = excluded.name, popularity_rank = excluded.popularity_rank,
  review_hint = excluded.review_hint,
  header_image = excluded.header_image, short_description = excluded.short_description,
  genre = excluded.genre, price = excluded.price, release_date = excluded.release_date,
  release_ts = excluded.release_ts,
  metacritic = excluded.metacritic, coop_categories = excluded.coop_categories,
  crawled_at = unixepoch();`).join('\n\n')}
`;

writeFileSync(OUT, sql);
console.log(`\n${rows.length} games -> ${OUT}`);
console.log(`skipped: ${skipped.nonGame} non-game, ${skipped.preFiltered} pre-filtered, ${skipped.tooFewReviews} under ${MIN_REVIEWS} reviews, ${skipped.noData} no data, ${skipped.seen} dupes`);
