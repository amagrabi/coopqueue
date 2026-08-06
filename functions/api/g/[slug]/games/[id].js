import { json, bad, body } from '../../../../../lib/http.js';
import { getAppDetails } from '../../../../../lib/steam.js';

const EDITABLE = ['name', 'genre', 'status', 'max_players', 'coop_note', 'hours', 'started', 'finished', 'notes'];
const STATUSES = ['backlog', 'playing', 'finished', 'dropped', 'sampled'];

/** Game ids are global and guessable, so every statement filters on group_id too. */
export async function onRequestPatch({ params, request, env, data }) {
  const id = Number(params.id);
  if (!Number.isInteger(id)) return bad('bad id');

  const patch = await body(request);
  const sets = [];
  const vals = [];
  for (const k of EDITABLE) {
    if (!(k in patch)) continue;
    if (k === 'status' && !STATUSES.includes(patch[k])) return bad(`status must be one of ${STATUSES.join(', ')}`);
    if (k === 'max_players' && patch[k] !== null && !(Number(patch[k]) >= 0)) return bad('max_players must be >= 0');
    if (k === 'name' && !String(patch[k] ?? '').trim()) return bad('name cannot be empty');
    sets.push(`${k} = ?`);
    vals.push(patch[k] === '' ? null : patch[k]);
  }
  if (!sets.length) return bad('nothing to update');

  vals.push(id, data.group.group_id);
  const res = await env.DB.prepare(`UPDATE games SET ${sets.join(', ')} WHERE id = ? AND group_id = ?`)
    .bind(...vals).run();
  if (!res.meta.changes) return bad('no such game', 404);

  const row = await env.DB.prepare('SELECT * FROM games WHERE id = ? AND group_id = ?')
    .bind(id, data.group.group_id).first();
  return json({ ok: true, game: row });
}

export async function onRequestDelete({ params, env, data }) {
  const id = Number(params.id);
  if (!Number.isInteger(id)) return bad('bad id');
  const res = await env.DB.prepare('DELETE FROM games WHERE id = ? AND group_id = ?')
    .bind(id, data.group.group_id).run();
  if (!res.meta.changes) return bad('no such game', 404);
  return json({ ok: true });
}

/** Link (or relink) a game to a Steam appid to pull in art and a trailer. */
export async function onRequestPut({ params, request, env, data }) {
  const id = Number(params.id);
  const { appid } = await body(request);
  if (!Number.isInteger(id) || !Number.isInteger(Number(appid))) return bad('need a game id and an appid');

  const gid = data.group.group_id;
  const mine = await env.DB.prepare('SELECT 1 FROM games WHERE id = ? AND group_id = ?').bind(id, gid).first();
  if (!mine) return bad('no such game', 404);

  const clash = await env.DB.prepare(
    'SELECT name FROM games WHERE group_id = ? AND steam_appid = ? AND id <> ?'
  ).bind(gid, Number(appid), id).first();
  if (clash) return bad(`${clash.name} is already linked to that Steam app`, 409);

  const meta = await getAppDetails(env.DB, Number(appid));
  if (!meta) return bad('Steam had nothing for that appid', 404);

  await env.DB.prepare(
    `UPDATE games SET steam_appid = ?, header_image = ?, trailer_url = ?, short_description = ?,
                      price = ?, release_date = ?, metacritic = ?, genre = COALESCE(genre, ?),
                      enriched_at = unixepoch()
      WHERE id = ? AND group_id = ?`
  ).bind(meta.appid, meta.header_image, meta.trailer_url, meta.short_description,
         meta.price, meta.release_date, meta.metacritic, meta.genre, id, gid).run();

  const row = await env.DB.prepare('SELECT * FROM games WHERE id = ?').bind(id).first();
  return json({ ok: true, game: row });
}
