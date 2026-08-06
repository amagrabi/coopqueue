import { json, bad, body } from '../../../../lib/http.js';

/** The queue: everything in this group I have neither rated nor skipped. */
export async function onRequestGet({ env, data }) {
  const rows = await env.DB.prepare(
    `SELECT g.id FROM games g
      WHERE g.group_id = ?2
        AND NOT EXISTS (SELECT 1 FROM ratings r WHERE r.game_id = g.id AND r.steam_id = ?1)
        AND NOT EXISTS (SELECT 1 FROM skips  s WHERE s.game_id = g.id AND s.steam_id = ?1)
      ORDER BY CASE g.status WHEN 'backlog' THEN 0 ELSE 1 END, g.name COLLATE NOCASE`
  ).bind(data.user.steam_id, data.group.group_id).all();
  return json({ queue: (rows.results || []).map((r) => r.id) });
}

/** "Seen it, no opinion" — hides it from my queue without faking a score. */
export async function onRequestPost({ request, env, data }) {
  const { gameId } = await body(request);
  const id = Number(gameId);
  if (!Number.isInteger(id)) return bad('bad gameId');

  const exists = await env.DB.prepare('SELECT 1 FROM games WHERE id = ? AND group_id = ?')
    .bind(id, data.group.group_id).first();
  if (!exists) return bad('no such game', 404);

  await env.DB.prepare('INSERT OR IGNORE INTO skips (game_id, steam_id) VALUES (?, ?)')
    .bind(id, data.user.steam_id).run();
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
