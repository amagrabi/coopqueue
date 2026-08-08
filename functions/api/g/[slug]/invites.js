import { bad, body, json } from '../../../../lib/http.js';

const escapeLike = (value) => value.replace(/[\\%_]/g, '\\$&');

function ownerOnly(data) {
  if (data.group.role !== 'owner') return bad('only the group owner can invite people', 403);
  if (data.group.workspace_mode === 'personal') {
    return bad('personal workspaces cannot invite other players', 409);
  }
  return null;
}

export async function onRequestGet({ request, env, data }) {
  const blocked = ownerOnly(data);
  if (blocked) return blocked;
  const gid = data.group.group_id;
  const pendingResult = await env.DB.prepare(
    `SELECT i.id, i.invited_steam_id AS steam_id, i.created_at,
            u.display_name, u.avatar
       FROM group_invites i
       JOIN users u ON u.steam_id = i.invited_steam_id
      WHERE i.group_id = ? AND i.status = 'pending'
      ORDER BY i.created_at DESC, i.id DESC`
  ).bind(gid).all();
  const pending = (pendingResult.results || []).map((invite) => ({
    id: invite.id,
    steamId: invite.steam_id,
    displayName: invite.display_name,
    avatar: invite.avatar,
    createdAt: invite.created_at,
  }));

  const q = new URL(request.url).searchParams.get('q')?.trim().slice(0, 80) || '';
  if (q.length < 2) return json({ pending, results: [] });
  const escaped = escapeLike(q);
  const result = await env.DB.prepare(
    `SELECT u.steam_id, u.display_name, u.avatar,
            CASE WHEN i.status = 'pending' THEN 1 ELSE 0 END AS pending
       FROM users u
       LEFT JOIN group_invites i
         ON i.group_id = ?1 AND i.invited_steam_id = u.steam_id
      WHERE u.steam_id <> ?2
        AND u.steam_id NOT LIKE 'seed:%' AND u.steam_id NOT LIKE 'import:%'
        AND NOT EXISTS (
          SELECT 1 FROM memberships m
           WHERE m.group_id = ?1 AND m.steam_id = u.steam_id
        )
        AND (u.display_name LIKE ?3 ESCAPE '\\' COLLATE NOCASE
             OR u.steam_id LIKE ?3 ESCAPE '\\')
      ORDER BY CASE WHEN u.display_name = ?4 COLLATE NOCASE OR u.steam_id = ?4 THEN 0
                    WHEN u.display_name LIKE ?5 ESCAPE '\\' COLLATE NOCASE
                      OR u.steam_id LIKE ?5 ESCAPE '\\' THEN 1 ELSE 2 END,
               COALESCE(u.last_seen_at,0) DESC, u.display_name COLLATE NOCASE
      LIMIT 12`
  ).bind(gid, data.user.steam_id, `%${escaped}%`, q, `${escaped}%`).all();
  return json({
    pending,
    results: (result.results || []).map((user) => ({
      steamId: user.steam_id,
      displayName: user.display_name || `Steam ${user.steam_id}`,
      avatar: user.avatar,
      pending: !!user.pending,
    })),
  });
}

export async function onRequestPost({ request, env, data }) {
  const blocked = ownerOnly(data);
  if (blocked) return blocked;
  const input = await body(request);
  const steamId = String(input.steamId || '').trim();
  if (!/^\d{16,20}$/.test(steamId) || steamId === data.user.steam_id) {
    return bad('choose another registered player');
  }
  const gid = data.group.group_id;
  const target = await env.DB.prepare(
    `SELECT u.steam_id,
            EXISTS(SELECT 1 FROM memberships m WHERE m.group_id=? AND m.steam_id=u.steam_id) AS member,
            (SELECT status FROM group_invites i
              WHERE i.group_id=? AND i.invited_steam_id=u.steam_id) AS invite_status
       FROM users u WHERE u.steam_id=?`
  ).bind(gid, gid, steamId).first();
  if (!target) return bad('that player has not signed in to CoopQueue yet', 404);
  if (target.member) return bad('that player is already in this group', 409);
  if (target.invite_status === 'pending') return bad('that invitation is already waiting', 409);

  await env.DB.prepare(
    `INSERT INTO group_invites (group_id,invited_steam_id,invited_by,status)
     VALUES (?,?,?,'pending')
     ON CONFLICT(group_id,invited_steam_id) DO UPDATE SET
       invited_by=excluded.invited_by,status='pending',created_at=unixepoch(),responded_at=NULL`
  ).bind(gid, steamId, data.user.steam_id).run();
  return json({ ok: true }, 201);
}

export async function onRequestDelete({ request, env, data }) {
  const blocked = ownerOnly(data);
  if (blocked) return blocked;
  const input = await body(request);
  const id = Number(input.id);
  if (!Number.isInteger(id) || id < 1) return bad('invalid invitation');
  const result = await env.DB.prepare(
    `UPDATE group_invites SET status='cancelled', responded_at=unixepoch()
      WHERE id=? AND group_id=? AND status='pending'`
  ).bind(id, data.group.group_id).run();
  if (!Number(result?.meta?.changes ?? result?.changes ?? 0)) return bad('invitation not found', 404);
  return json({ ok: true });
}
