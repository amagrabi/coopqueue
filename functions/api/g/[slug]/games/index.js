import { json, bad, body } from '../../../../../lib/http.js';
import { globalStats, scoreGame, viability } from '../../../../../lib/score.js';
import { getAppDetails, parseAppId, searchStore } from '../../../../../lib/steam.js';

/**
 * The whole group library with scores already computed. At a few hundred games
 * this is tens of KB, so the client fetches once and every view filters the
 * same in-memory list.
 */
export async function onRequestGet({ env, data }) {
  const gid = data.group.group_id;

  const [gamesRes, ratingsRes, membersRes, notPlayedRes] = await Promise.all([
    // LEFT JOIN the global catalogue for Steam's own review verdict and count.
    // Left, not inner: a hand-added game may have no catalogue row, and it must
    // still appear. The group's own columns win — a group can correct a player
    // count locally without the catalogue overwriting it.
    env.DB.prepare(
      /* early_access is computed rather than shipped as raw tags: the flag is one
         bit per game and the tag array is a few hundred bytes, across a library
         fetched on every load. Exact-string LIKE against the JSON array, which is
         safe because tags are stored as Steam's own names. */
      `SELECT g.*, c.review_hint AS steam_review_hint, c.review_count AS steam_review_count,
              CASE WHEN c.tags LIKE '%"Early Access"%' THEN 1 ELSE 0 END AS early_access
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
    // Who sat a game out. Needed client-side for coverage — a game you did not
    // play is not one you failed to rate — so it travels with the library rather
    // than costing a second round trip.
    env.DB.prepare(
      `SELECT s.game_id, s.steam_id FROM skips s
         JOIN games g ON g.id = s.game_id
        WHERE g.group_id = ? AND s.not_played = 1`
    ).bind(gid).all(),
  ]);

  const ratings = ratingsRes.results || [];
  // No calibrate() here: the library shows the plain average. Per-person baselines
  // are only used to *describe* raters on the Stats page, which computes its own.
  const glob = globalStats(ratings);

  const byGame = new Map();
  for (const r of ratings) {
    if (!byGame.has(r.game_id)) byGame.set(r.game_id, []);
    byGame.get(r.game_id).push(r);
  }

  const satOut = new Map();
  for (const s of notPlayedRes.results || []) {
    if (!satOut.has(s.game_id)) satOut.set(s.game_id, []);
    satOut.get(s.game_id).push(s.steam_id);
  }

  const need = data.group.max_players;
  const games = (gamesRes.results || []).map((g) => {
    const votes = byGame.get(g.id) || [];
    return {
      ...g,
      votes: Object.fromEntries(votes.map((v) => [v.steam_id, v.score])),
      comments: votes.filter((v) => v.comment).map((v) => ({ steamId: v.steam_id, comment: v.comment })),
      ...scoreGame(votes),
      notPlayed: satOut.get(g.id) || [],
      viability: viability(g, need),
    };
  });

  return json({
    games,
    members: membersRes.results || [],
    group: {
      slug: data.group.slug, name: data.group.name, maxPlayers: need, role: data.group.role,
      blindRating: !!data.group.blind_rating,
    },
    model: { mean: Math.round(glob.mean * 100) / 100, sd: Math.round(glob.sd * 100) / 100 },
  });
}

/** Add a game from a Steam URL, a bare appid, a plain name, or by hand. */
export async function onRequestPost({ request, env, data }) {
  const { input, maxPlayers, status, manual, name, genre } = await body(request);
  const gid = data.group.group_id;

  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM games WHERE group_id = ?').bind(gid).first();
  if ((count?.n ?? 0) >= 2000) return bad('this group has hit the 2000-game limit', 429);

  /* ── added by hand, no Steam page ─────────────────────────────────────────
     Not every game a group plays is on Steam. Valorant lives in Riot's client,
     Rocket League left Steam for Epic in 2020, and one entry in the original
     spreadsheet was "Schach" — German for chess. Forcing those through the Steam
     matcher either fails or, worse, links something that merely sounds similar.

     steam_appid stays NULL, which viability() and the enrich queue both already
     understand, and enriched_at is stamped so /enrich does not keep trying to
     guess a match for a game that deliberately has none. It can still be linked
     later by pasting a store URL from the Library. */
  if (manual) {
    const clean = String(name || '').trim();
    if (clean.length < 2) return bad('give the game a name');
    if (clean.length > 120) return bad('that name is too long');

    const dupe = await env.DB.prepare(
      'SELECT id FROM games WHERE group_id = ? AND name = ? COLLATE NOCASE').bind(gid, clean).first();
    if (dupe) return bad(`${clean} is already on your list`, 409);

    const res = await env.DB.prepare(
      `INSERT INTO games (group_id, name, genre, status, max_players, added_by, enriched_at)
       VALUES (?,?,?,?,?,?,unixepoch())`
    ).bind(gid, clean, genre?.trim() || null, status || 'backlog',
           Number.isFinite(Number(maxPlayers)) && Number(maxPlayers) > 0 ? Number(maxPlayers) : null,
           data.user.steam_id).run();

    return json({ ok: true, id: res.meta.last_row_id, name: clean, manual: true }, 201);
  }

  if (!input || !String(input).trim()) return bad('give me a Steam link, an appid, or a game name');

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
