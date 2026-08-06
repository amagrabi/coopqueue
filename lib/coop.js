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

/**
 * Steam user tags for one app, most-voted first.
 *
 * Steam's own `genres` field is far too coarse to be useful — most of a co-op
 * catalogue comes back as "Action" — and tags are not in the appdetails payload at
 * all. They are only on the store page, in the `glance_tags` block, so this reads
 * the HTML.
 *
 * SteamSpy republishes tags as JSON and was the obvious choice, but it was measured
 * and rejected: it had tag data for 219 of the 337 rows in this catalogue and
 * returned `tags: []` for **all 118** of the rest. Those 118 are almost entirely
 * unreleased or newly released games (ARC Raiders, Borderlands 4, Grounded 2,
 * Overwatch) plus free-to-play titles — exactly the rows a "recently released"
 * catalogue keeps acquiring. Steam's own page has tags for every one of them.
 *
 * The cost is one request to the throttled store host per game (~200KB of HTML)
 * instead of one to SteamSpy. The crawler already spends two store requests per
 * game, so this makes three, still far inside its budget.
 */
export const storeTagsUrl = (appid) =>
  `https://store.steampowered.com/app/${appid}/?l=english`;

/** Store pages age-gate without this, and an age gate has no tags on it. */
export const STORE_HEADERS = {
  ...UA,
  cookie: 'birthtime=0; mature_content=1',
  'accept-language': 'en',
};

/* Genres that are PvP by definition. This is the co-op test — see classifyCoop.
   "Team-Based" is deliberately absent: it sits high on plenty of genuine co-op
   shooters, so including it hides the good ones. */
const PVP_GENRE = /\b(PvP|Battle Royale|Competitive|Arena Shooter|e-?Sports|MOBA|Hero Shooter)\b/i;

/** How far down the tag list a PvP genre still means the game is about PvP. */
const PVP_WINDOW = 6;

/**
 * Is this a co-op game, judged from its tags in Steam's order?
 *
 * Decided by EXCLUDING PvP-primary games, not by requiring a co-op tag, and the
 * difference is not a nuance. Measured against 42 games this group demonstrably
 * plays co-operatively:
 *
 *   co-op tag in top 5      wrongly hides 20 of 42   (48%)
 *   co-op tag anywhere      wrongly hides 10 of 42   — Divinity: Original Sin 2,
 *                                                      The Forest, No Man's Sky, Rust
 *   no PvP genre in top N   wrongly hides  2–3       — Apex Legends, Diabotical and
 *                                                      Tetris Effect, all really PvP
 *
 * Requiring a co-op tag cannot be made to work at any rank: 24% of real co-op games
 * carry no co-op tag at all (Stardew Valley among them), because a popular game's
 * tag list is dominated by generic descriptors. An earlier version of this file used
 * the top-5-co-op-tag rule after validating it on four games; it classified
 * Terraria, Elden Ring, Stardew Valley and Baldur's Gate 3 as not co-op.
 *
 * Excluding also fails in the safe direction. A missed PvP game is one extra row in
 * a browse list; a hidden co-op game is invisible unless you already knew to search
 * for it. Steam's own categories cannot help either way — Apex Legends, Euro Truck
 * Simulator 2 and Terraria all report exactly
 * ['Multi-player', 'Co-op', 'Online Co-op'].
 *
 * PVP_WINDOW is 6 because that is where Steam's ordering puts the boundary: it
 * catches Overwatch (Hero Shooter, 2), Rainbow Six (PvP, 2), Apex (Battle Royale, 3),
 * Marvel Rivals (3), PUBG (3), Counter-Strike 2 (Competitive, 4) and THE FINALS
 * (PvP, 6), while leaving Rust (7) and Destiny 2 (9) visible — both of which this
 * group plays co-operatively, and Destiny 2 tags Co-op above PvP anyway.
 */
export function classifyCoop(names) {
  return !names.slice(0, PVP_WINDOW).some((t) => PVP_GENRE.test(t));
}

/**
 * Tags from a store page's `glance_tags` block, most-voted first.
 *
 * Returns null when the block is absent, which is what an age gate or a delisted
 * app serves — a caller must leave the row untagged rather than record "no tags",
 * or the crawler will never retry it.
 */
export function parseStoreTags(html, limit = 12) {
  if (typeof html !== 'string') return null;
  const i = html.indexOf('class="glance_tags popular_tags"');
  if (i < 0) return null;
  // Bounded window: the tag anchors sit together, and `class="app_tag"` also
  // appears elsewhere on the page (the "+" add-a-tag control, the tag modal).
  const names = [...html.slice(i, i + 4000)
    .matchAll(/class="app_tag"[^>]*>\s*([^<]+?)\s*</g)]
    .map((m) => m[1].replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, limit);
  if (!names.length) return null;
  return { tags: names, isCoop: classifyCoop(names) };
}
