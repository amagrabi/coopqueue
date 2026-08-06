import { json, bad, body } from '../../../../lib/http.js';

/**
 * Take over a placeholder member: move every rating and skip from
 * 'seed:<group>:<name>' onto the real Steam account, adopt its display name,
 * then delete the placeholder. Runs once per person per group.
 */
export async function onRequestPost({ request, env, data }) {
  const { seedId } = await body(request);
  const gid = data.group.group_id;

  if (!/^seed:\d+:[a-z0-9_-]+$/i.test(seedId || '')) return bad('bad seed id');

  const seed = await env.DB.prepare(
    'SELECT steam_id, short_name, role FROM memberships WHERE group_id = ? AND steam_id = ? AND is_seed = 1'
  ).bind(gid, seedId).first();
  if (!seed) return bad('that identity has already been claimed', 409);

  const mine = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM ratings r JOIN games g ON g.id = r.game_id
      WHERE g.group_id = ? AND r.steam_id = ?`
  ).bind(gid, data.user.steam_id).first();
  if ((mine?.n ?? 0) > 0) {
    return bad('you already have ratings in this group — claiming would merge two histories', 409);
  }

  // The real membership row exists already (it is how the caller got in here),
  // so the ratings can be repointed without tripping the foreign key.
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE ratings SET steam_id = ? WHERE steam_id = ?
         AND game_id IN (SELECT id FROM games WHERE group_id = ?)`
    ).bind(data.user.steam_id, seedId, gid),
    env.DB.prepare(
      `UPDATE skips SET steam_id = ? WHERE steam_id = ?
         AND game_id IN (SELECT id FROM games WHERE group_id = ?)`
    ).bind(data.user.steam_id, seedId, gid),
    env.DB.prepare('UPDATE games SET added_by = ? WHERE added_by = ? AND group_id = ?')
      .bind(data.user.steam_id, seedId, gid),
    env.DB.prepare('UPDATE memberships SET short_name = ?, role = ? WHERE group_id = ? AND steam_id = ?')
      .bind(seed.short_name, seed.role, gid, data.user.steam_id),
    env.DB.prepare('DELETE FROM memberships WHERE group_id = ? AND steam_id = ?').bind(gid, seedId),
    // The placeholder user row is only ever used by this one group.
    env.DB.prepare('DELETE FROM users WHERE steam_id = ?').bind(seedId),
  ]);

  return json({ ok: true, shortName: seed.short_name });
}

/** Which placeholder identities are still unclaimed in this group. */
export async function onRequestGet({ env, data }) {
  const mine = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM ratings r JOIN games g ON g.id = r.game_id
      WHERE g.group_id = ? AND r.steam_id = ?`
  ).bind(data.group.group_id, data.user.steam_id).first();

  const seeds = await env.DB.prepare(
    'SELECT steam_id, short_name FROM memberships WHERE group_id = ? AND is_seed = 1 ORDER BY short_name'
  ).bind(data.group.group_id).all();

  return json({
    canClaim: (mine?.n ?? 0) === 0,
    unclaimed: (seeds.results || []).map((s) => ({ seedId: s.steam_id, name: s.short_name })),
  });
}
