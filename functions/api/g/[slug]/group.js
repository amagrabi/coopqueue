import { json, bad, body } from '../../../../lib/http.js';

/**
 * Delete the whole group. Owner only, and irreversible.
 *
 * Everything a group owns hangs off groups.id with ON DELETE CASCADE, so one
 * statement takes the memberships, games, ratings, skips, comments and any
 * pre-assigned identities with it. That is the point — a half-deleted group with
 * orphaned ratings would be worse than either outcome.
 *
 * Guarded by a typed confirmation rather than a boolean flag. A `confirm: true`
 * in a JSON body is trivially sent by accident from a stale tab or a retried
 * request; the group's own name is not.
 */
export async function onRequestDelete({ request, env, data }) {
  if (data.group.role !== 'owner') {
    return bad('only the group owner can delete the group', 403);
  }
  const { confirmName } = await body(request);
  if (String(confirmName || '').trim() !== data.group.name) {
    return bad('type the group name exactly to confirm', 400);
  }

  const gid = data.group.group_id;
  const counts = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM games WHERE group_id = ?1) AS games,
            (SELECT COUNT(*) FROM ratings r JOIN games g ON g.id = r.game_id
              WHERE g.group_id = ?1) AS ratings,
            (SELECT COUNT(*) FROM memberships WHERE group_id = ?1) AS members`
  ).bind(gid).first();

  await env.DB.prepare('DELETE FROM groups WHERE id = ?').bind(gid).run();

  return json({ ok: true, deleted: counts });
}
