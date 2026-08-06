import { json, bad, body, cleanScore } from '../../../../lib/http.js';

/** Upsert my rating. Re-rating overwrites; there is no history to keep. */
export async function onRequestPost({ request, env, data }) {
  const { gameId, score, comment } = await body(request);
  const id = Number(gameId);
  if (!Number.isInteger(id)) return bad('bad gameId');

  const s = cleanScore(score);
  if (s === null) return bad('score must be between 1 and 10');

  // Confirms the game exists *and* belongs to this group in one check.
  const exists = await env.DB.prepare('SELECT 1 FROM games WHERE id = ? AND group_id = ?')
    .bind(id, data.group.group_id).first();
  if (!exists) return bad('no such game', 404);

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO ratings (game_id, steam_id, score, comment, updated_at)
       VALUES (?,?,?,?,unixepoch())
       ON CONFLICT(game_id, steam_id)
       DO UPDATE SET score = excluded.score, comment = excluded.comment, updated_at = unixepoch()`
    ).bind(id, data.user.steam_id, s, String(comment || '').trim().slice(0, 500) || null),
    // Rating clears any earlier skip, so the queue count stays honest.
    env.DB.prepare('DELETE FROM skips WHERE game_id = ? AND steam_id = ?').bind(id, data.user.steam_id),
  ]);

  return json({ ok: true, gameId: id, score: s });
}

export async function onRequestDelete({ request, env, data }) {
  const { gameId } = await body(request);
  const id = Number(gameId);
  if (!Number.isInteger(id)) return bad('bad gameId');
  await env.DB.prepare(
    `DELETE FROM ratings WHERE steam_id = ? AND game_id = ?
       AND game_id IN (SELECT id FROM games WHERE group_id = ?)`
  ).bind(data.user.steam_id, id, data.group.group_id).run();
  return json({ ok: true });
}
