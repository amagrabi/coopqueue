import { json, bad, body } from '../../../../../lib/http.js';
import { calibrate, globalStats, scoreGame, viability } from '../../../../../lib/score.js';
import { getAppDetails, parseAppId, searchStore } from '../../../../../lib/steam.js';

/**
 * The whole group library with scores already computed. At a few hundred games
 * this is tens of KB, so the client fetches once and every view filters the
 * same in-memory list.
 */
export async function onRequestGet({ env, data }) {
  const gid = data.group.group_id;

  const [gamesRes, ratingsRes, membersRes] = await Promise.all([
    // LEFT JOIN the global catalogue for Steam's own review verdict and count.
    // Left, not inner: a hand-added game may have no catalogue row, and it must
    // still appear. The group's own columns win — a group can correct a player
    // count locally without the catalogue overwriting it.
    env.DB.prepare(
      `SELECT g.*, c.review_hint AS steam_review_hint, c.review_count AS steam_review_count
         FROM games g LEFT JOIN coop_apps c ON c.appid = g.steam_appid
        WHERE g.group_id = ? ORDER BY g.name COLLATE NOCASE`
    ).bind(gid).all(),
    env.DB.prepare(
      `SELECT r.game_id, r.steam_id, r.score, r.comment
         FROM ratings r JOIN games g ON g.id = r.game_id
        WHERE g.group_id = ?`
    ).bind(gid).all(),
    env.DB.prepare(
      `SELECT m.steam_id, m.short_name, m.is_seed, u.avatar, u.display_name
         FROM memberships m JOIN users u ON u.steam_id = m.steam_id
        WHERE m.group_id = ?
        ORDER BY m.short_name COLLATE NOCASE`
    ).bind(gid).all(),
  ]);

  const ratings = ratingsRes.results || [];
  const cal = calibrate(ratings);
  const glob = globalStats(ratings);

  const byGame = new Map();
  for (const r of ratings) {
    if (!byGame.has(r.game_id)) byGame.set(r.game_id, []);
    byGame.get(r.game_id).push(r);
  }

  const need = data.group.max_players;
  const games = (gamesRes.results || []).map((g) => {
    const votes = byGame.get(g.id) || [];
    return {
      ...g,
      votes: Object.fromEntries(votes.map((v) => [v.steam_id, v.score])),
      comments: votes.filter((v) => v.comment).map((v) => ({ steamId: v.steam_id, comment: v.comment })),
      ...scoreGame(votes),
      viability: viability(g, need),
    };
  });

  return json({
    games,
    members: membersRes.results || [],
    group: { slug: data.group.slug, name: data.group.name, maxPlayers: need, role: data.group.role },
    model: { mean: Math.round(glob.mean * 100) / 100, sd: Math.round(glob.sd * 100) / 100 },
  });
}

/** Add a game from a Steam URL, a bare appid, or a plain name. */
export async function onRequestPost({ request, env, data }) {
  const { input, maxPlayers, status } = await body(request);
  if (!input || !String(input).trim()) return bad('give me a Steam link, an appid, or a game name');

  const gid = data.group.group_id;

  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM games WHERE group_id = ?').bind(gid).first();
  if ((count?.n ?? 0) >= 2000) return bad('this group has hit the 2000-game limit', 429);

  let appid = parseAppId(input);
  if (!appid) {
    const hits = await searchStore(String(input).trim());
    if (!hits.length) return bad(`nothing on Steam matches "${input}"`, 404);
    appid = hits[0].appid;
  }

  const dupe = await env.DB.prepare('SELECT id, name FROM games WHERE group_id = ? AND steam_appid = ?')
    .bind(gid, appid).first();
  if (dupe) return bad(`${dupe.name} is already on your list`, 409);

  const meta = await getAppDetails(env.DB, appid);
  if (!meta) return bad('Steam had nothing for that appid', 404);

  const res = await env.DB.prepare(
    `INSERT INTO games (group_id, name, steam_appid, genre, status, max_players, header_image,
                        trailer_url, short_description, price, release_date, metacritic,
                        added_by, enriched_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,unixepoch())`
  ).bind(
    gid, meta.name, appid, meta.genre, status || 'backlog',
    maxPlayers ?? null, meta.header_image, meta.trailer_url,
    meta.short_description, meta.price, meta.release_date, meta.metacritic,
    data.user.steam_id
  ).run();

  return json({ ok: true, id: res.meta.last_row_id, name: meta.name }, 201);
}
