import { json } from '../../../lib/http.js';

/**
 * Browse the global co-op catalogue.
 *
 * Deliberately knows nothing about groups. It takes no group slug, reads no
 * membership and returns no group data, so it cannot leak one group's pool to
 * another — the tenancy boundary stays the only code that reasons about who may
 * see what. The client already holds its own pool in state.games and marks
 * "already added" by comparing steam_appid locally.
 *
 * Signing in is still required: functions/_middleware.js gates every /api/ route
 * that is not in its PUBLIC list, so an anonymous caller never reaches this.
 */
const PAGE = 24;
/** Shared with the group-scoped recommender so both return identical card shapes. */
export const CATALOGUE_COLS = `appid, name, popularity_rank, review_hint, review_count,
    header_image, short_description, genre, price, release_date, release_ts, metacritic,
    tags, is_coop, max_players, max_players_src, coop_note`;
const MAX_PAGE = 500;   // a bound so a hand-edited page param cannot walk forever

export async function onRequestGet({ request, env }) {
  const p = new URL(request.url).searchParams;
  const q = (p.get('q') || '').trim().slice(0, 80);
  const sort = p.get('sort') || 'rank';
  const page = Math.min(MAX_PAGE, Math.max(0, Number(p.get('page')) || 0));
  const minPlayers = Math.max(0, Number(p.get('minPlayers')) || 0);
  // Default ON. Every row here arrived through Steam's co-op category, but that
  // category is applied loosely enough to include Counter-Strike and Apex Legends,
  // so the flag from parseTags — which excludes PvP genres rather than requiring a
  // co-op tag, for reasons measured there — is what actually filters.
  const coopOnly = p.get('coopOnly') !== '0';

  const where = [];
  const args = [];
  if (q) {
    where.push('name LIKE ?');
    args.push(`%${q.replace(/[%_]/g, (c) => `\\${c}`)}%`);
  }
  // A player-count filter can only ever match games somebody verified. Unknown
  // caps are excluded rather than assumed to fit — guessing here is exactly what
  // invariant 6 forbids, and "it fits" is the claim people act on.
  if (minPlayers) {
    where.push('max_players IS NOT NULL AND max_players >= ?');
    args.push(minPlayers);
  }
  if (coopOnly) {
    // is_coop IS NULL means the tags have not been fetched yet; those are kept
    // rather than hidden, or a freshly crawled catalogue would look empty.
    where.push('(is_coop = 1 OR is_coop IS NULL)');
  }
  const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const order = {
    rank: 'popularity_rank ASC',
    name: 'name COLLATE NOCASE ASC',
    // release_date is a display string ('9 Sep, 2025'); ordering it as text
    // groups by day-of-month instead of by date. release_ts is the real thing.
    new:  'release_ts DESC',
  }[sort] || 'popularity_rank ASC';

  const COLS = CATALOGUE_COLS;

  const total = await env.DB.prepare(`SELECT COUNT(*) AS n FROM coop_apps ${filter}`)
    .bind(...args).first();

  const rows = await env.DB.prepare(
    `SELECT ${COLS} FROM coop_apps ${filter} ORDER BY ${order} LIMIT ? OFFSET ?`
  ).bind(...args, PAGE + 1, page * PAGE).all();

  const found = rows.results || [];
  return json({
    games: found.slice(0, PAGE),
    page,
    hasMore: found.length > PAGE,
    total: total?.n ?? 0,
  });
}
