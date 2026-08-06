/**
 * Shared Steam co-op catalogue logic, used by two very different callers:
 * `scripts/crawl-coop.mjs` (Node, emits SQL for a bulk seed) and
 * `crawler/index.js` (a cron Worker that keeps the table fresh incrementally).
 *
 * It lives here so the parsing cannot drift between them — every trap below was
 * paid for once and should not have to be rediscovered:
 *
 *  - The search endpoint returns no appid. It is only present inside the capsule
 *    image URL, so it has to be dug out with a regex.
 *  - `sort_by=Reviews_DESC` sorts by review *score*, not volume. It ranks a
 *    534-review DLC above Stardew Valley's million and includes zero-review
 *    listings, so popularity has to come from appreviews' total_reviews.
 *  - The co-op search is full of DLC, demos and soundtracks — 141 of one run's
 *    first 398 hits — so `type === 'game'` is a mandatory filter.
 *  - release_date is a display string; sorting it as text is not chronological.
 */
export const COOP_CATEGORY_ONLINE = 38;
export const UA = { 'user-agent': 'CoopQ (co-op game tracker)' };

export const searchUrl = ({ start = 0, count = 50, cc = 'de', filter = 'globaltopsellers', sort = null } = {}) =>
  'https://store.steampowered.com/search/results/'
  + `?query&category2=${COOP_CATEGORY_ONLINE}&json=1`
  // `filter` and `sort_by` are alternatives, not companions: top-sellers is a
  // filter, newest is a sort. Passing both makes Steam ignore one silently.
  + (sort ? `&sort_by=${sort}` : `&filter=${filter}`)
  + `&cc=${cc}&l=english&start=${start}&count=${count}`;

export const detailsUrl = (appid, cc = 'de') =>
  `https://store.steampowered.com/api/appdetails?appids=${appid}&cc=${cc}&l=english`;

export const reviewsUrl = (appid) =>
  `https://store.steampowered.com/appreviews/${appid}`
  + '?json=1&num_per_page=0&language=all&purchase_type=all';

const MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
              jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

/**
 * Steam's release_date is a display string ('16 May, 2011'), and ordering it as
 * text sorts on the leading day-of-month — which put 9 Sep 2025, 9 Sep 2024 and
 * 9 Sep 2019 next to each other. Returns epoch seconds, or null for the shapes
 * Steam uses for unreleased games ('Coming soon'), which then sort last.
 */
export function releaseTs(s) {
  if (!s) return null;
  const t = String(s).trim();
  let m = /^(\d{1,2})\s+([A-Za-z]{3})[a-z]*,?\s+(\d{4})$/.exec(t);
  if (m && MON[m[2].toLowerCase()] != null) {
    return Math.floor(Date.UTC(+m[3], MON[m[2].toLowerCase()], +m[1]) / 1000);
  }
  m = /^([A-Za-z]{3})[a-z]*\s+(\d{4})$/.exec(t);            // 'Mar 2026'
  if (m && MON[m[1].toLowerCase()] != null) {
    return Math.floor(Date.UTC(+m[2], MON[m[1].toLowerCase()], 1) / 1000);
  }
  m = /^(?:Q[1-4]\s+)?(\d{4})$/.exec(t);                     // 'Q1 2026', '2026'
  if (m) return Math.floor(Date.UTC(+m[1], 0, 1) / 1000);
  return null;
}

/** Entries not worth an appdetails call. Deliberately narrow — `type` decides. */
export const OBVIOUS_NON_GAME = /\b(soundtrack|ost|art\s?book|demo|season pass|upgrade pack)\b/i;

/** appid + name pairs from a search payload. */
export function parseSearchItems(json) {
  return (json?.items || []).map((it) => {
    const m = /\/apps\/(\d+)\//.exec(it.logo || '');
    return m ? { appid: Number(m[1]), name: it.name } : null;
  }).filter(Boolean);
}

/**
 * Catalogue row from an appdetails payload, or `{ rejected: <type> }` when the
 * entry is not a game. Never returns max_players: Steam has no reliable
 * machine-readable co-op player count and its own categories are wrong often
 * enough to be dangerous, so that column is only ever written by a human.
 */
export function shapeDetails(appid, json) {
  const entry = json?.[String(appid)];
  if (!entry?.success || !entry.data) return null;
  const d = entry.data;
  if (d.type !== 'game') return { rejected: d.type || 'unknown' };
  const https = (u) => (typeof u === 'string' ? u.replace(/^http:\/\//, 'https://') : null);
  return {
    appid,
    name: d.name,
    header_image: https(d.header_image),
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

/** { total, desc } from an appreviews payload — the real popularity signal. */
export function parseReviews(json) {
  const s = json?.query_summary;
  return s ? { total: s.total_reviews ?? 0, desc: s.review_score_desc || null } : null;
}
