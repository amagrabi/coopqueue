import { json, bad, body } from '../../../lib/http.js';
import { myGroups, uniqueSlug, randomToken } from '../../../lib/groups.js';

export async function onRequestGet({ env, data }) {
  return json({ groups: await myGroups(env.DB, data.user.steam_id) });
}

/** Create a group. The creator becomes its owner and first member. */
export async function onRequestPost({ request, env, data }) {
  const { name, maxPlayers } = await body(request);
  const clean = String(name || '').trim().slice(0, 60);
  if (clean.length < 2) return bad('give the group a name of at least 2 characters');

  const cap = Number(maxPlayers);
  if (maxPlayers != null && (!Number.isInteger(cap) || cap < 2 || cap > 64)) {
    return bad('group size must be a whole number between 2 and 64');
  }

  // A soft ceiling so one account cannot fill the free tier on its own.
  const mine = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM memberships WHERE steam_id = ? AND role = 'owner'"
  ).bind(data.user.steam_id).first();
  if ((mine?.n ?? 0) >= 20) return bad('you already own 20 groups', 429);

  const slug = await uniqueSlug(env.DB, clean);
  const res = await env.DB.prepare(
    'INSERT INTO groups (slug, name, invite_code, max_players, created_by) VALUES (?,?,?,?,?)'
  ).bind(slug, clean, randomToken(10), cap || 4, data.user.steam_id).run();

  const groupId = res.meta.last_row_id;
  const shortName = (data.user.display_name || 'Player').slice(0, 16);
  await env.DB.prepare(
    "INSERT INTO memberships (group_id, steam_id, short_name, role) VALUES (?,?,?,'owner')"
  ).bind(groupId, data.user.steam_id, shortName).run();

  return json({ ok: true, slug, name: clean }, 201);
}
