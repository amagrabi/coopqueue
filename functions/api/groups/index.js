import { json, bad, body } from '../../../lib/http.js';
import { myGroups, uniqueSlug, randomToken } from '../../../lib/groups.js';

export async function onRequestGet({ env, data }) {
  return json({ groups: await myGroups(env.DB, data.user.steam_id) });
}

/** Create a group. The creator becomes its owner and first member. */
export async function onRequestPost({ request, env, data }) {
  const { name, maxPlayers, mode: requestedMode } = await body(request);
  const clean = String(name || '').trim().slice(0, 60);
  if (clean.length < 2) return bad('give the group a name of at least 2 characters');

  const mode = requestedMode == null ? 'coop' : String(requestedMode);
  if (!['coop', 'personal'].includes(mode)) return bad('workspace mode must be coop or personal');
  const cap = mode === 'personal' ? 1 : Number(maxPlayers ?? 4);
  if (mode === 'coop' && (!Number.isInteger(cap) || cap < 2 || cap > 64)) {
    return bad('group size must be a whole number between 2 and 64');
  }

  // A soft ceiling so one account cannot fill the free tier on its own.
  const mine = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM memberships WHERE steam_id = ? AND role = 'owner'"
  ).bind(data.user.steam_id).first();
  if ((mine?.n ?? 0) >= 20) return bad('you already own 20 groups', 429);

  const slug = await uniqueSlug(env.DB, clean);
  const shortName = (data.user.display_name || 'Player').slice(0, 16);
  // D1 batches are transactional, so a workspace cannot be left without its
  // owner if recording the explicit mode fails.
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO groups (slug, name, invite_code, max_players, created_by) VALUES (?,?,?,?,?)'
    ).bind(slug, clean, mode === 'personal' ? null : randomToken(10), cap, data.user.steam_id),
    env.DB.prepare(
      `INSERT INTO memberships (group_id, steam_id, short_name, role)
       SELECT id, ?, ?, 'owner' FROM groups WHERE slug = ?`
    ).bind(data.user.steam_id, shortName, slug),
    env.DB.prepare(
      `INSERT INTO workspace_settings (group_id, mode)
       SELECT id, ? FROM groups WHERE slug = ?`
    ).bind(mode, slug),
  ]);

  return json({ ok: true, slug, name: clean, mode }, 201);
}
