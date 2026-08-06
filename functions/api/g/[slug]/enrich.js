import { json, body } from '../../../../lib/http.js';
import { searchStore, getAppDetails } from '../../../../lib/steam.js';

/**
 * Backfill Steam art, trailers and prices for games imported without an appid.
 *
 * Batched small on purpose: Steam's store endpoints throttle at roughly
 * 200 requests / 5 min per IP, and a miss costs two (search + details). The
 * shared steam_apps cache means a second group importing the same title costs
 * one search and zero detail fetches.
 *
 * Only unambiguous name matches link automatically — a wrong appid means the
 * wrong trailer plays in the rating queue, which is worse than no trailer.
 */
const BATCH = 8;

export async function onRequestPost({ request, env, data }) {
  const { force } = await body(request);
  const gid = data.group.group_id;

  const pending = await env.DB.prepare(
    `SELECT id, name FROM games
      WHERE group_id = ? AND steam_appid IS NULL ${force ? '' : 'AND enriched_at IS NULL'}
      ORDER BY CASE status WHEN 'backlog' THEN 0 ELSE 1 END, name COLLATE NOCASE
      LIMIT ?`
  ).bind(gid, BATCH).all();

  const rows = pending.results || [];
  const linked = [];
  const needsReview = [];

  for (const g of rows) {
    const hits = await searchStore(g.name);
    const match = pickMatch(g.name, hits);
    const meta = match ? await getAppDetails(env.DB, match.appid) : null;

    // Already claimed by another row in this group? Leave it for a human.
    const clash = meta
      ? await env.DB.prepare('SELECT 1 FROM games WHERE group_id = ? AND steam_appid = ? AND id <> ?')
          .bind(gid, meta.appid, g.id).first()
      : null;

    if (!meta || clash) {
      // Stamp it so one fruitless name never blocks the rest of the queue.
      await env.DB.prepare('UPDATE games SET enriched_at = unixepoch() WHERE id = ?').bind(g.id).run();
      needsReview.push({ id: g.id, name: g.name, candidates: hits.slice(0, 5) });
      continue;
    }

    await env.DB.prepare(
      `UPDATE games SET steam_appid = ?, header_image = ?, trailer_url = ?, short_description = ?,
                        price = ?, release_date = ?, metacritic = ?, genre = COALESCE(genre, ?),
                        enriched_at = unixepoch()
        WHERE id = ? AND group_id = ?`
    ).bind(meta.appid, meta.header_image, meta.trailer_url, meta.short_description,
           meta.price, meta.release_date, meta.metacritic, meta.genre, g.id, gid).run();

    linked.push({ id: g.id, name: g.name, matched: meta.name, appid: meta.appid });
  }

  const left = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM games
      WHERE group_id = ? AND steam_appid IS NULL ${force ? '' : 'AND enriched_at IS NULL'}`
  ).bind(gid).first();

  return json({ processed: rows.length, linked, needsReview, remaining: left?.n ?? 0 });
}

/** Accept only a confident match — exact, or a single clear front-runner. */
function pickMatch(name, hits) {
  if (!hits.length) return null;
  const norm = (s) =>
    s.toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\b(the|a|an|edition|goty|definitive|remastered)\b/g, '')
      .trim();
  const target = norm(name);

  const exact = hits.find((h) => norm(h.name) === target);
  if (exact) return exact;

  const prefix = hits.filter((h) => norm(h.name).startsWith(target) || target.startsWith(norm(h.name)));
  return prefix.length === 1 ? prefix[0] : null;
}
