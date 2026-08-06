import { json, bad, body } from '../../../lib/http.js';
import { applySeedAssignment } from '../../../lib/groups.js';

/** Join a group with an invite code. Idempotent: re-joining is a no-op. */
export async function onRequestPost({ request, env, data }) {
  const { code } = await body(request);
  const clean = String(code || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{6,24}$/.test(clean)) return bad('that does not look like an invite code');

  const group = await env.DB.prepare(
    'SELECT id, slug, name FROM groups WHERE invite_code = ?'
  ).bind(clean).first();
  // Same message either way — a wrong code should not reveal whether it exists.
  if (!group) return bad('that invite code is not valid any more', 404);

  const already = await env.DB.prepare(
    'SELECT 1 FROM memberships WHERE group_id = ? AND steam_id = ?'
  ).bind(group.id, data.user.steam_id).first();

  if (!already) {
    const size = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM memberships WHERE group_id = ?'
    ).bind(group.id).first();
    if ((size?.n ?? 0) >= 64) return bad('that group is full', 409);

    await env.DB.prepare(
      "INSERT INTO memberships (group_id, steam_id, short_name, role) VALUES (?,?,?,'member')"
    ).bind(group.id, data.user.steam_id, (data.user.display_name || 'Player').slice(0, 16)).run();
  }

  // Strictly after the membership insert: repointing ratings onto an account with
  // no membership row trips D1's foreign keys. A no-op unless the owner
  // pre-assigned this SteamID64 an identity, in which case the person skips the
  // "which one are you?" prompt entirely.
  const claimed = await applySeedAssignment(env.DB, group.id, data.user.steam_id);

  return json({
    ok: true, slug: group.slug, name: group.name,
    alreadyMember: !!already,
    claimedAs: claimed || null,
  });
}
