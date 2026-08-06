import { json, bad, body } from '../../../../lib/http.js';
import { randomToken } from '../../../../lib/groups.js';

export async function onRequestGet({ env, data }) {
  const res = await env.DB.prepare(
    `SELECT m.steam_id, m.short_name, m.role, m.is_seed, u.avatar, u.display_name,
            (SELECT COUNT(*) FROM ratings r
               JOIN games gg ON gg.id = r.game_id
              WHERE r.steam_id = m.steam_id AND gg.group_id = m.group_id) AS ratings
       FROM memberships m
       JOIN users u ON u.steam_id = m.steam_id
      WHERE m.group_id = ?
      ORDER BY m.is_seed, m.short_name COLLATE NOCASE`
  ).bind(data.group.group_id).all();

  return json({
    members: res.results || [],
    group: {
      slug: data.group.slug,
      name: data.group.name,
      maxPlayers: data.group.max_players,
      role: data.group.role,
      blindRating: !!data.group.blind_rating,
      // Only an owner needs the code, and only they can rotate it.
      inviteCode: data.group.role === 'owner' ? data.group.invite_code : null,
    },
  });
}

/**
 * Owner-only group settings, plus one thing any member may do: rename
 * themselves within the group.
 */
export async function onRequestPatch({ request, env, data }) {
  const patch = await body(request);
  const gid = data.group.group_id;
  const isOwner = data.group.role === 'owner';

  if (patch.myName != null) {
    const name = String(patch.myName).trim().slice(0, 16);
    if (name.length < 1) return bad('name cannot be empty');
    await env.DB.prepare('UPDATE memberships SET short_name = ? WHERE group_id = ? AND steam_id = ?')
      .bind(name, gid, data.user.steam_id).run();
  }

  if (patch.name != null) {
    if (!isOwner) return bad('only the group owner can rename the group', 403);
    const name = String(patch.name).trim().slice(0, 60);
    if (name.length < 2) return bad('group name is too short');

    /* Group names are NOT globally unique, and must not be.
     *
     * Rejecting a name because some other group already holds it would turn this
     * endpoint into an oracle for the existence of private groups — the exact
     * thing the 404-not-403 tenancy boundary exists to prevent. You could sit
     * here typing names and learn which ones are taken.
     *
     * The collision that actually hurts is the one within your own group list,
     * where two identically-named groups make the switcher useless (this group
     * shipped with two called "g4m1ng"). That is information the caller already
     * has, so checking it leaks nothing. It is a 409 rather than a silent rename
     * so the owner can pick something else.
     *
     * The slug is deliberately untouched by a rename, so URLs and invite links
     * already handed out keep working.
     */
    const mine = await env.DB.prepare(
      `SELECT g.name FROM groups g
         JOIN memberships m ON m.group_id = g.id AND m.steam_id = ?
        WHERE g.id <> ? AND g.name = ? COLLATE NOCASE`
    ).bind(data.user.steam_id, gid, name).first();
    if (mine) {
      return bad(`you are already in another group called "${mine.name}" — `
               + 'pick something else so you can tell them apart', 409);
    }

    await env.DB.prepare('UPDATE groups SET name = ? WHERE id = ?').bind(name, gid).run();
  }

  if (patch.maxPlayers != null) {
    if (!isOwner) return bad('only the group owner can change the group size', 403);
    const cap = Number(patch.maxPlayers);
    if (!Number.isInteger(cap) || cap < 2 || cap > 64) return bad('group size must be 2–64');
    await env.DB.prepare('UPDATE groups SET max_players = ? WHERE id = ?').bind(cap, gid).run();
  }

  if (patch.blindRating != null) {
    // A group rule, so owner-only: one member rating blind while the others see
    // the numbers achieves nothing, which is why this is not a personal setting.
    if (!isOwner) return bad('only the group owner can change blind rating', 403);
    await env.DB.prepare('UPDATE groups SET blind_rating = ? WHERE id = ?')
      .bind(patch.blindRating ? 1 : 0, gid).run();
  }

  if (patch.invite != null) {
    if (!isOwner) return bad('only the group owner can manage the invite link', 403);
    // 'rotate' issues a fresh code and kills the old link; 'off' disables joining.
    const code = patch.invite === 'off' ? null : randomToken(10);
    await env.DB.prepare('UPDATE groups SET invite_code = ? WHERE id = ?').bind(code, gid).run();
    return json({ ok: true, inviteCode: code });
  }

  return json({ ok: true });
}

/** Remove a member, or leave the group yourself. Ratings go with them. */
export async function onRequestDelete({ request, env, data }) {
  const { steamId } = await body(request);
  const target = String(steamId || data.user.steam_id);
  const gid = data.group.group_id;
  const isSelf = target === data.user.steam_id;

  if (!isSelf && data.group.role !== 'owner') {
    return bad('only the group owner can remove other members', 403);
  }

  if (isSelf && data.group.role === 'owner') {
    const owners = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM memberships WHERE group_id = ? AND role = 'owner' AND is_seed = 0"
    ).bind(gid).first();
    if ((owners?.n ?? 0) <= 1) {
      return bad('you are the only owner — promote someone else or delete the group', 409);
    }
  }

  await env.DB.batch([
    env.DB.prepare(
      'DELETE FROM ratings WHERE steam_id = ? AND game_id IN (SELECT id FROM games WHERE group_id = ?)'
    ).bind(target, gid),
    env.DB.prepare(
      'DELETE FROM skips WHERE steam_id = ? AND game_id IN (SELECT id FROM games WHERE group_id = ?)'
    ).bind(target, gid),
    env.DB.prepare('DELETE FROM memberships WHERE group_id = ? AND steam_id = ?').bind(gid, target),
  ]);

  return json({ ok: true });
}
