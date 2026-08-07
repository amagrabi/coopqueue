import { json, bad, body } from '../../../../lib/http.js';
import { applySeedAssignment, claimSeedIdentity } from '../../../../lib/groups.js';

/**
 * Take over a placeholder member: move every rating and skip from
 * 'seed:<group>:<name>' onto the real Steam account, adopt its display name,
 * then delete the placeholder. Runs once per person per group.
 */
export async function onRequestPost({ request, env, data }) {
  const { seedId } = await body(request);
  const gid = data.group.group_id;

  if (!/^seed:\d+:[a-z0-9_-]+$/i.test(seedId || '')) return bad('bad seed id');

  // The repoint itself lives in lib/groups.js because the pre-assignment path
  // performs exactly the same steps, and the order is foreign-key sensitive.
  const already = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM ratings r JOIN games g ON g.id = r.game_id
      WHERE g.group_id = ? AND r.steam_id = ?`
  ).bind(gid, data.user.steam_id).first();
  if ((already?.n ?? 0) > 0) {
    return bad('you already have ratings in this group — claiming would merge two histories', 409);
  }

  const shortName = await claimSeedIdentity(env.DB, gid, data.user.steam_id, seedId);
  if (!shortName) return bad('that identity has already been claimed', 409);

  return json({ ok: true, shortName });
}

/** Which placeholder identities are still unclaimed in this group. */
export async function onRequestGet({ env, data }) {
  // Idempotent, and a no-op unless this person was pre-assigned an identity that
  // is still unclaimed. Doing it here means it also catches somebody who joined
  // before the owner set the assignment up.
  await applySeedAssignment(env.DB, data.group.group_id, data.user.steam_id);

  const mine = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM ratings r JOIN games g ON g.id = r.game_id
      WHERE g.group_id = ? AND r.steam_id = ?`
  ).bind(data.group.group_id, data.user.steam_id).first();

  const seeds = await env.DB.prepare(
    `SELECT m.steam_id, m.short_name,
            (SELECT COUNT(*) FROM ratings r JOIN games g ON g.id = r.game_id
              WHERE r.steam_id = m.steam_id AND g.group_id = m.group_id) AS ratings
       FROM memberships m
      WHERE m.group_id = ? AND m.is_seed = 1
      ORDER BY m.short_name`
  ).bind(data.group.group_id).all();

  return json({
    canClaim: (mine?.n ?? 0) === 0,
    unclaimed: (seeds.results || []).map((s) => ({
      seedId: s.steam_id,
      name: s.short_name,
      ratings: s.ratings || 0,
    })),
  });
}
