import { json } from '../../../../lib/http.js';
import { CATALOGUE_COLS } from '../../coop/index.js';
import { recommend } from '../../../../lib/recommend.js';

/**
 * Catalogue games ranked against what this group has actually liked.
 *
 * This lives *below* the tenancy boundary, unlike `/api/coop`, and that placement
 * is the whole reason it is a separate route rather than a `sort=fit` on the
 * catalogue endpoint. `/api/coop` is deliberately group-blind — it takes no slug,
 * reads no membership and returns nothing group-scoped, which two tests assert.
 * Recommending needs the group's ratings, so it has to sit where a membership
 * check has already happened instead of being bolted onto an endpoint that has no
 * tenancy check at all.
 *
 * The ranking itself is `lib/recommend.js`, shared with the harness. This handler
 * only fetches and paginates.
 */

const PAGE = 24;
const MAX_PAGE = 500;   // a bound so a hand-edited page param cannot walk forever

export async function onRequestGet({ request, env, data }) {
  const gid = data.group.group_id;
  const p = new URL(request.url).searchParams;
  const page = Math.min(MAX_PAGE, Math.max(0, Math.floor(Number(p.get('page')) || 0)));
  const coopOnly = p.get('coopOnly') !== '0';
  const minPlayers = Math.min(64, Math.max(0, Math.floor(Number(p.get('minPlayers')) || 0)));
  const q = (p.get('q') || '').trim().slice(0, 80);

  // Same filters as /api/coop, so switching sort order does not silently change
  // which games are eligible.
  const where = [];
  const args = [];
  if (q) {
    where.push("name LIKE ? ESCAPE '\\'");
    args.push(`%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  }
  if (minPlayers) { where.push('max_players IS NOT NULL AND max_players >= ?'); args.push(minPlayers); }
  if (coopOnly) where.push('(is_coop = 1 OR is_coop IS NULL)');
  const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const [candidates, rated, tagRows] = await Promise.all([
    // Rank on the four fields the algorithm actually reads. Fetch the wide card
    // payload only for the final page, so descriptions and image URLs are not
    // copied through Worker memory for the entire catalogue on every request.
    env.DB.prepare(
      `SELECT appid, popularity_rank, review_count, tags FROM coop_apps ${filter}`
    ).bind(...args).all(),
    // The group's own history. Archived games are excluded: they are no longer what
    // this group is choosing between, so they should not shape its suggestions.
    env.DB.prepare(
      `SELECT g.steam_appid AS appid, AVG(r.score) AS score
         FROM games g JOIN ratings r ON r.game_id = g.id
        WHERE g.group_id = ? AND g.archived_at IS NULL AND g.steam_appid IS NOT NULL
        GROUP BY g.id`
    ).bind(gid).all(),
    /* Tags for the rated games only. Joining through `games` rather than reading
       every tagged row keeps this proportional to the group's library instead of
       the whole catalogue — and it is filtered on group_id, like every other query
       below this boundary. */
    env.DB.prepare(
      `SELECT c.appid, c.tags FROM coop_apps c
         JOIN games g ON g.steam_appid = c.appid AND g.group_id = ?
        WHERE c.tags IS NOT NULL`
    ).bind(gid).all(),
  ]);

  const tagsFor = new Map();
  for (const r of tagRows.results || []) {
    try {
      const t = JSON.parse(r.tags);
      if (Array.isArray(t)) tagsFor.set(r.appid, t);
    } catch { /* a malformed row should cost one game, not the whole ranking */ }
  }

  const out = recommend(candidates.results || [], rated.results || [], tagsFor);
  const slice = out.games.slice(page * PAGE, page * PAGE + PAGE);
  const details = slice.length
    ? await env.DB.prepare(
      `SELECT ${CATALOGUE_COLS} FROM coop_apps WHERE appid IN (${slice.map(() => '?').join(',')})`
    ).bind(...slice.map((g) => g.appid)).all()
    : { results: [] };
  const detailById = new Map((details.results || []).map((g) => [g.appid, g]));
  const games = slice.map((ranked) => ({
    ...detailById.get(ranked.appid), fit: ranked.fit, why: ranked.why,
  }));

  return json({
    games,
    page,
    total: out.games.length,
    hasMore: out.games.length > page * PAGE + PAGE,
    basis: out.basis,
    ratedGames: out.ratedGames,
    needed: out.needed,
    likes: out.likes,
    dislikes: out.dislikes,
  });
}
