import { json, bad, body } from '../../../../lib/http.js';

const MAX_BODY = 2000;

/**
 * Comment thread for one game.
 *
 * A new group-scoped WRITE path, which is the single easiest place to reintroduce
 * the cross-group bug invariant 2 exists to prevent: game ids are global and
 * sequential, so every statement here filters on `group_id` as well as the id it
 * was handed. Being a legitimate member of one group must not let you read or
 * write the discussion attached to another group's game 5000.
 *
 * Fetched on demand rather than bundled into the library payload. The library is
 * loaded once and filtered client-side, so shipping every comment for every game
 * would grow that payload for a thread almost nobody has open.
 */

/** Confirm the game is in the caller's group, and return it. */
async function gameInGroup(env, gid, gameId) {
  if (!Number.isInteger(gameId)) return null;
  return env.DB.prepare('SELECT id, name FROM games WHERE id = ? AND group_id = ?')
    .bind(gameId, gid).first();
}

export async function onRequestGet({ request, env, data }) {
  const gameId = Number(new URL(request.url).searchParams.get('gameId'));
  const gid = data.group.group_id;

  // 404 rather than 403 for a game outside the group, matching the tenancy
  // boundary: the reply must not reveal that the id exists somewhere else.
  if (!await gameInGroup(env, gid, gameId)) return bad('no such game', 404);

  const rows = await env.DB.prepare(
    `SELECT c.id, c.steam_id, c.body, c.created_at, m.short_name, u.avatar, u.display_name
       FROM comments c
       LEFT JOIN memberships m ON m.group_id = c.group_id AND m.steam_id = c.steam_id
       LEFT JOIN users u ON u.steam_id = c.steam_id
      WHERE c.game_id = ? AND c.group_id = ?
      ORDER BY c.created_at ASC, c.id ASC`
  ).bind(gameId, gid).all();

  return json({
    comments: (rows.results || []).map((c) => ({
      id: c.id,
      steamId: c.steam_id,
      /* A comment can outlive its author's membership — someone left, or it was
         written by the `import:<group>` identity that carries text migrated out of
         games.notes and deliberately holds no membership. The users row still has a
         display name in both cases, which beats "Someone who left". */
      name: c.short_name || c.display_name || 'Someone who left',
      avatar: c.avatar,
      body: c.body,
      createdAt: c.created_at,
      mine: c.steam_id === data.user.steam_id,
    })),
  });
}

export async function onRequestPost({ request, env, data }) {
  const { gameId, body: text } = await body(request);
  const gid = data.group.group_id;

  const game = await gameInGroup(env, gid, Number(gameId));
  if (!game) return bad('no such game', 404);

  const clean = String(text || '').trim();
  if (!clean) return bad('write something first');
  if (clean.length > MAX_BODY) return bad(`keep it under ${MAX_BODY} characters`);

  const res = await env.DB.prepare(
    'INSERT INTO comments (group_id, game_id, steam_id, body) VALUES (?,?,?,?)'
  ).bind(gid, Number(gameId), data.user.steam_id, clean).run();

  return json({ ok: true, id: res.meta.last_row_id }, 201);
}

/**
 * Delete one comment. Yours, or anyone's if you own the group — an owner needs to
 * be able to clear something out, but a member deleting other people's remarks is
 * not a power a four-person group needs.
 */
export async function onRequestDelete({ request, env, data }) {
  const { id } = await body(request);
  const gid = data.group.group_id;
  if (!Number.isInteger(Number(id))) return bad('bad id');

  const row = await env.DB.prepare('SELECT steam_id FROM comments WHERE id = ? AND group_id = ?')
    .bind(Number(id), gid).first();
  if (!row) return bad('no such comment', 404);

  const isMine = row.steam_id === data.user.steam_id;
  if (!isMine && data.group.role !== 'owner') {
    return bad('you can only delete your own comments', 403);
  }

  await env.DB.prepare('DELETE FROM comments WHERE id = ? AND group_id = ?')
    .bind(Number(id), gid).run();
  return json({ ok: true });
}
