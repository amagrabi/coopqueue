import { json, bad, body } from '../../../../lib/http.js';

/**
 * "Not interested" — catalogue games this group has rejected, and the way back.
 *
 * Group-scoped rather than personal (see migration 034): Find games is a shared
 * decision, so one person saying no hides it for everyone, `steam_id` records who,
 * and anybody can undo it. Safe only because it destroys nothing — the catalogue
 * row is untouched and the game returns intact.
 *
 * The filtering itself happens in the browser, not here, and deliberately: the
 * grid is fed by `/api/coop`, which is group-blind by design and must stay that
 * way. This route only stores and returns the list. See renderBrowse().
 */

/** A cap, so one group cannot turn this into unbounded storage. */
const MAX_DISMISSALS = 2000;

export async function onRequestGet({ env, data }) {
  const rows = await env.DB.prepare(
    `SELECT d.appid, d.name, d.steam_id, d.created_at,
            COALESCE(m.short_name, u.display_name) AS by_name
       FROM coop_dismissals d
       LEFT JOIN memberships m ON m.group_id = d.group_id AND m.steam_id = d.steam_id
       LEFT JOIN users u ON u.steam_id = d.steam_id
      WHERE d.group_id = ?
      ORDER BY d.created_at DESC, d.appid DESC`
  ).bind(data.group.group_id).all();

  return json({
    dismissals: (rows.results || []).map((r) => ({
      appid: r.appid,
      name: r.name,
      // Null when the account was removed. The UI says "someone" rather than
      // inventing a name, the same way `added_by` does.
      by: r.by_name || null,
      bySteamId: r.steam_id || null,
      at: r.created_at,
    })),
  });
}

export async function onRequestPost({ request, env, data }) {
  const { appid, name } = await body(request);
  const id = Number(appid);
  if (!Number.isInteger(id) || id <= 0) return bad('bad appid');

  const gid = data.group.group_id;
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM coop_dismissals WHERE group_id = ?')
    .bind(gid).first();
  if ((count?.n ?? 0) >= MAX_DISMISSALS) {
    return bad(`this group has hit the ${MAX_DISMISSALS}-dismissal limit`, 429);
  }

  /* The name comes from the catalogue where it exists, and only falls back to what
     the browser sent when it does not. The client is not a trustworthy source for
     a value other members will read, but a catalogue row can genuinely be missing
     — the crawler deletes rejected ones — so a fallback beats refusing. */
  const known = await env.DB.prepare('SELECT name FROM coop_apps WHERE appid = ?').bind(id).first();
  const label = known?.name || String(name || '').trim().slice(0, 200);
  if (!label) return bad('no such game in the catalogue');

  await env.DB.prepare(
    `INSERT INTO coop_dismissals (group_id, appid, name, steam_id) VALUES (?,?,?,?)
     ON CONFLICT(group_id, appid)
     DO UPDATE SET name = excluded.name, steam_id = excluded.steam_id, created_at = unixepoch()`
  ).bind(gid, id, label, data.user.steam_id).run();

  return json({ ok: true, appid: id, name: label });
}

export async function onRequestDelete({ request, env, data }) {
  const { appid } = await body(request);
  const id = Number(appid);
  if (!Number.isInteger(id)) return bad('bad appid');
  // Anybody in the group may undo, exactly like restoring an archived game: the
  // hide is a shared decision and reversing it costs nothing.
  await env.DB.prepare('DELETE FROM coop_dismissals WHERE group_id = ? AND appid = ?')
    .bind(data.group.group_id, id).run();
  return json({ ok: true, appid: id });
}
