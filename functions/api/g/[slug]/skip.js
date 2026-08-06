import { json, bad, body } from '../../../../lib/http.js';

/** The queue: everything in this group I have neither rated nor skipped. */
export async function onRequestGet({ env, data }) {
  const rows = await env.DB.prepare(
    `SELECT g.id FROM games g
      WHERE g.group_id = ?2
        AND g.archived_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM ratings r WHERE r.game_id = g.id AND r.steam_id = ?1)
        AND NOT EXISTS (SELECT 1 FROM skips  s WHERE s.game_id = g.id AND s.steam_id = ?1)
      ORDER BY CASE g.status WHEN 'backlog' THEN 0 ELSE 1 END, g.name COLLATE NOCASE`
  ).bind(data.user.steam_id, data.group.group_id).all();
  return json({ queue: (rows.results || []).map((r) => r.id) });
}

/**
 * Take a game off my queue without faking a score. Two different statements:
 *
 *   notPlayed: false — "no opinion". I was there, I just have nothing to say.
 *   notPlayed: true  — "I didn't play this one". A group of four often plays as
 *                      two or three, and the people who sat it out cannot rate it.
 *
 * Only the second changes anything beyond the queue: it removes the game from that
 * person's coverage denominator, so a 3-of-4 session stops reading as apathy from
 * the fourth. Re-posting updates the flag, so a mis-click is fixable from the UI.
 */
export async function onRequestPost({ request, env, data }) {
  const { gameId, notPlayed } = await body(request);
  const id = Number(gameId);
  if (!Number.isInteger(id)) return bad('bad gameId');

  const exists = await env.DB.prepare('SELECT 1 FROM games WHERE id = ? AND group_id = ?')
    .bind(id, data.group.group_id).first();
  if (!exists) return bad('no such game', 404);

  await env.DB.prepare(
    `INSERT INTO skips (game_id, steam_id, not_played) VALUES (?, ?, ?)
     ON CONFLICT(game_id, steam_id) DO UPDATE SET not_played = excluded.not_played`
  ).bind(id, data.user.steam_id, notPlayed ? 1 : 0).run();
  return json({ ok: true });
}

export async function onRequestDelete({ request, env, data }) {
  const { gameId } = await body(request);
  const id = Number(gameId);
  if (!Number.isInteger(id)) return bad('bad gameId');
  await env.DB.prepare(
    `DELETE FROM skips WHERE game_id = ? AND steam_id = ?
       AND game_id IN (SELECT id FROM games WHERE group_id = ?)`
  ).bind(id, data.user.steam_id, data.group.group_id).run();
  return json({ ok: true });
}
