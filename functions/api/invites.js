import { bad, body, json } from '../../lib/http.js';
import { applySeedAssignment, pendingInvites } from '../../lib/groups.js';

export async function onRequestGet({ env, data }) {
  return json({ invites: await pendingInvites(env.DB, data.user.steam_id) });
}

export async function onRequestPost({ request, env, data }) {
  const input = await body(request);
  const id = Number(input.id);
  const action = String(input.action || '');
  if (!Number.isInteger(id) || id < 1 || !['accept', 'reject'].includes(action)) {
    return bad('choose accept or reject for a valid invitation');
  }
  const invite = await env.DB.prepare(
    `SELECT i.id,i.group_id,g.slug,g.name,COALESCE(w.mode,'coop') AS mode,
            EXISTS(SELECT 1 FROM memberships m
              WHERE m.group_id=i.group_id AND m.steam_id=i.invited_steam_id) AS member
       FROM group_invites i
       JOIN groups g ON g.id=i.group_id
       LEFT JOIN workspace_settings w ON w.group_id=g.id
      WHERE i.id=? AND i.invited_steam_id=? AND i.status='pending'`
  ).bind(id, data.user.steam_id).first();
  if (!invite) return bad('that invitation is no longer available', 404);

  if (action === 'reject') {
    await env.DB.prepare(
      `UPDATE group_invites SET status='rejected',responded_at=unixepoch()
        WHERE id=? AND invited_steam_id=? AND status='pending'`
    ).bind(id, data.user.steam_id).run();
    return json({ ok: true, action });
  }
  if (invite.mode !== 'coop') return bad('that group no longer accepts invitations', 409);

  if (!invite.member) {
    const size = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM memberships WHERE group_id=?'
    ).bind(invite.group_id).first();
    if ((size?.n ?? 0) >= 64) return bad('that group is full', 409);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO memberships (group_id,steam_id,short_name,role)
         VALUES (?,?,?,'member')`
      ).bind(invite.group_id, data.user.steam_id,
        (data.user.display_name || 'Player').slice(0, 16)),
      env.DB.prepare(
        `UPDATE group_invites SET status='accepted',responded_at=unixepoch()
          WHERE id=? AND invited_steam_id=? AND status='pending'`
      ).bind(id, data.user.steam_id),
    ]);
  } else {
    await env.DB.prepare(
      `UPDATE group_invites SET status='accepted',responded_at=unixepoch()
        WHERE id=? AND invited_steam_id=? AND status='pending'`
    ).bind(id, data.user.steam_id).run();
  }

  const claimed = await applySeedAssignment(env.DB, invite.group_id, data.user.steam_id);
  return json({
    ok: true, action, slug: invite.slug, name: invite.name,
    alreadyMember: !!invite.member, claimedAs: claimed || null,
  });
}
