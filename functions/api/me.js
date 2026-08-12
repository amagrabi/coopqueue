import { json, bad, body } from '../../lib/http.js';
import { myGroups, pendingInvites } from '../../lib/groups.js';

export async function onRequestGet(context) {
  const { env, data } = context;
  const [groups, invites] = await Promise.all([
    myGroups(env.DB, data.user.steam_id),
    pendingInvites(env.DB, data.user.steam_id),
  ]);
  // Presence is useful, but it is not part of this response. Sample it hourly and
  // keep the D1 write off the page-load path; Pages binds waitUntil to `context`.
  context.waitUntil(env.DB.prepare(
    `UPDATE users SET last_seen_at = unixepoch()
      WHERE steam_id = ? AND (last_seen_at IS NULL OR last_seen_at < unixepoch() - 3600)`
  ).bind(data.user.steam_id).run().catch((error) => {
    console.error(JSON.stringify({
      event: 'presence_update_failed', error: error instanceof Error ? error.message : String(error),
    }));
  }));

  return json({
    user: {
      steamId: data.user.steam_id,
      displayName: data.user.display_name,
      avatar: data.user.avatar,
    },
    groups,
    invites,
  });
}

/**
 * Account-level preferences. Currently one: which workspace a hash-less visit
 * opens, so signing in stops landing on whichever group happens to sort first.
 *
 * This deliberately sits ABOVE the group middleware rather than on
 * `PATCH /api/g/:slug/members`, for two reasons. The choice spans every workspace
 * the caller belongs to, so a group-scoped route would have to write outside its
 * own group_id — exactly the shape invariant 2 exists to keep rare. And the
 * control lives in the workspace switcher, which is account chrome, not a group
 * setting.
 *
 * The membership lookup is the tenancy check, and its failure is a 404 for the
 * same reason the group middleware returns one: a slug you are not in must be
 * indistinguishable from a slug that does not exist, or this becomes a probe for
 * which private workspaces are real.
 */
export async function onRequestPatch({ request, env, data }) {
  const patch = await body(request);
  if (!('defaultGroup' in patch)) return bad('nothing to change');
  const steamId = data.user.steam_id;

  if (patch.defaultGroup == null) {
    await env.DB.prepare('UPDATE member_preferences SET default_workspace = 0 WHERE steam_id = ?')
      .bind(steamId).run();
    return json({ ok: true, defaultGroup: null });
  }

  const slug = String(patch.defaultGroup);
  const group = await env.DB.prepare(
    `SELECT g.id FROM groups g
       JOIN memberships m ON m.group_id = g.id AND m.steam_id = ?
      WHERE g.slug = ?`
  ).bind(steamId, slug).first();
  if (!group) return bad('no such workspace', 404);

  // Clear first, then set. The partial unique index permits one default row per
  // account, so the opposite order trips it halfway through the batch.
  await env.DB.batch([
    env.DB.prepare('UPDATE member_preferences SET default_workspace = 0 WHERE steam_id = ? AND group_id <> ?')
      .bind(steamId, group.id),
    env.DB.prepare(
      `INSERT INTO member_preferences (group_id, steam_id, default_workspace) VALUES (?,?,1)
       ON CONFLICT(group_id, steam_id) DO UPDATE SET default_workspace = 1`
    ).bind(group.id, steamId),
  ]);

  return json({ ok: true, defaultGroup: slug });
}
