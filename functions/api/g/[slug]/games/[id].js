import { json, bad, body } from '../../../../../lib/http.js';
import { getAppDetails } from '../../../../../lib/steam.js';

const EDITABLE = ['name', 'genre', 'status', 'max_players', 'coop_note', 'hours', 'started', 'finished', 'notes'];
const STATUSES = ['backlog', 'playing', 'finished', 'unfinished', 'dropped', 'sampled'];

/** Game ids are global and guessable, so every statement filters on group_id too. */
export async function onRequestPatch({ params, request, env, data }) {
  const id = Number(params.id);
  if (!Number.isInteger(id)) return bad('bad id');

  const patch = await body(request);
  const sets = [];
  const vals = [];

  // Archive state is a boolean over the wire and a timestamp in the column, so it
  // cannot ride along in EDITABLE with the plain passthrough fields.
  if ('archived' in patch) {
    sets.push('archived_at = ?');
    vals.push(patch.archived ? Math.floor(Date.now() / 1000) : null);
  }

  /* Who added the game. Recorded automatically on new adds, but almost every game
     in an imported library predates that, so it can be set by hand.

     Not in EDITABLE because it needs a lookup: an arbitrary SteamID64 would let a
     member write a foreign account into their group's rows, and `added_by` is
     rendered as a name. Only members of THIS group, or null for "we don't know". */
  if ('added_by' in patch) {
    const who = patch.added_by === '' ? null : patch.added_by;
    if (who !== null) {
      const member = await env.DB.prepare(
        'SELECT 1 FROM memberships WHERE group_id = ? AND steam_id = ?'
      ).bind(data.group.group_id, String(who)).first();
      if (!member) return bad('that person is not in this group', 400);
    }
    sets.push('added_by = ?');
    vals.push(who);
  }
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

/**
 * "Remove" a game — which archives it rather than deleting it.
 *
 * Any member can do this, and that is only safe because it destroys nothing. A
 * real DELETE cascades away every rating anyone ever gave the game, and ratings
 * are the one thing in here that cannot be recreated; making tidying-up a
 * destructive act any of four people can take is a bad trade. Archiving drops it
 * out of the queue, Play next, coverage and the default Library view, and
 * restoring brings the whole history back untouched.
 *
 * There is deliberately no hard-delete endpoint. If a group truly wants the data
 * gone, deleting the group does that and says so.
 */
export async function onRequestDelete({ params, env, data }) {
  const id = Number(params.id);
  if (!Number.isInteger(id)) return bad('bad id');

  const gid = data.group.group_id;
  const game = await env.DB.prepare(
    `SELECT g.name, g.archived_at,
            (SELECT COUNT(*) FROM ratings r WHERE r.game_id = g.id) AS ratings
       FROM games g WHERE g.id = ? AND g.group_id = ?`
  ).bind(id, gid).first();
  if (!game) return bad('no such game', 404);
  if (game.archived_at) return json({ ok: true, name: game.name, alreadyArchived: true });

  await env.DB.prepare('UPDATE games SET archived_at = unixepoch() WHERE id = ? AND group_id = ?')
    .bind(id, gid).run();
  return json({ ok: true, name: game.name, archived: true, keptRatings: game.ratings });
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
