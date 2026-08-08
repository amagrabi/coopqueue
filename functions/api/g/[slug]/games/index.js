import { json, bad, body } from '../../../../../lib/http.js';
import { globalStats, scoreGame, viability } from '../../../../../lib/score.js';
import { getAppDetails, parseAppId, searchStore } from '../../../../../lib/steam.js';
import { ownershipForGames } from '../../../../../lib/ownership.js';
import { completionEvidence } from '../../../../../lib/completion.js';

const STATUSES = new Set(['backlog', 'playing', 'finished', 'unfinished', 'dropped', 'sampled']);

function cleanGameInput(status, maxPlayers, genre) {
  const cleanStatus = status || 'backlog';
  if (!STATUSES.has(cleanStatus)) return { error: 'invalid game status' };
  const players = maxPlayers == null || maxPlayers === '' ? null : Number(maxPlayers);
  if (players !== null && (!Number.isInteger(players) || players < 0 || players > 64)) {
    return { error: 'max players must be a whole number from 0 to 64' };
  }
  const cleanGenre = genre == null ? null : String(genre).trim();
  if (cleanGenre && cleanGenre.length > 80) return { error: 'genre must be under 80 characters' };
  return { status: cleanStatus, maxPlayers: players, genre: cleanGenre || null };
}

/**
 * The whole group library with scores already computed. At a few hundred games
 * this is tens of KB, so the client fetches once and every view filters the
 * same in-memory list.
 */
export async function onRequestGet({ env, data }) {
  const gid = data.group.group_id;

  const [gamesRes, ratingsRes, membersRes, notPlayedRes, factSourcesRes, achievementsRes] = await Promise.all([
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
      `SELECT m.steam_id, m.short_name, m.is_seed, u.avatar, u.display_name,
              COALESCE(a.steam_id, m.steam_id) AS account,
              s.games AS synced_games, s.synced_at
         FROM memberships m JOIN users u ON u.steam_id = m.steam_id
         LEFT JOIN seed_assignments a
                ON a.group_id = m.group_id AND a.seed_steam_id = m.steam_id
         LEFT JOIN group_library_sync s
                ON s.group_id = m.group_id AND s.steam_id = COALESCE(a.steam_id, m.steam_id)
        WHERE m.group_id = ?
        ORDER BY m.short_name COLLATE NOCASE`
    ).bind(gid).all(),
    /* Every skip in the group, for two different jobs. `not_played = 1` rows are
       group-visible — a game you did not play is not one you failed to rate, so
       coverage needs them. The caller's own rows, of either kind, are what makes a
       skipped game reachable again: without them the Rate tab cannot show you what
       you skipped, and a skip becomes a one-way door. Few rows either way, so this
       travels with the library rather than costing a second round trip. */
    env.DB.prepare(
      `SELECT s.game_id, s.steam_id, s.not_played FROM skips s
         JOIN games g ON g.id = s.game_id
        WHERE g.group_id = ?`
    ).bind(gid).all(),
    env.DB.prepare(
      `SELECT f.game_id, f.field, f.source, f.set_by, f.updated_at,
              COALESCE(m.short_name, u.display_name) AS set_by_name
         FROM game_fact_sources f
         LEFT JOIN memberships m
                ON m.group_id = f.group_id AND m.steam_id = f.set_by
         LEFT JOIN users u ON u.steam_id = f.set_by
        WHERE f.group_id = ?`
    ).bind(gid).all(),
    // Personal completion is an estimate belonging to the signed-in account.
    // Keep the join group-scoped and never expose another member's unlock list.
    env.DB.prepare(
      `SELECT p.appid,p.unlocked FROM achievement_progress p
         JOIN games g ON g.steam_appid=p.appid
        WHERE g.group_id=? AND g.archived_at IS NULL AND p.steam_id=?`
    ).bind(gid, data.user.steam_id).all(),
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
  const mine = new Map();
  for (const s of notPlayedRes.results || []) {
    if (s.not_played) {
      if (!satOut.has(s.game_id)) satOut.set(s.game_id, []);
      satOut.get(s.game_id).push(s.steam_id);
    }
    if (s.steam_id === data.user.steam_id) {
      mine.set(s.game_id, s.not_played ? 'not-played' : 'no-opinion');
    }
  }

  const factSources = new Map();
  for (const source of factSourcesRes.results || []) {
    if (!factSources.has(source.game_id)) factSources.set(source.game_id, {});
    factSources.get(source.game_id)[source.field] = {
      source: source.source,
      setBy: source.set_by,
      setByName: source.set_by_name,
      updatedAt: source.updated_at,
    };
  }

  const need = data.group.max_players;
  const gameRows = gamesRes.results || [];
  const memberRows = membersRes.results || [];
  const completionByApp = new Map();
  if (data.group.workspace_mode === 'personal') {
    for (const row of achievementsRes.results || []) {
      let unlocked;
      try { unlocked = JSON.parse(row.unlocked || '[]'); } catch { unlocked = []; }
      const evidence = completionEvidence(row.appid, unlocked);
      if (evidence) completionByApp.set(Number(row.appid), evidence);
    }
  }
  const ownership = await ownershipForGames(env.DB, gid, gameRows, memberRows);
  const games = gameRows.map((g) => {
    const votes = byGame.get(g.id) || [];
    const completionSuggestion = g.status === 'sampled'
      ? completionByApp.get(Number(g.steam_appid)) || null
      : null;
    return {
      ...g,
      votes: Object.fromEntries(votes.map((v) => [v.steam_id, v.score])),
      comments: votes.filter((v) => v.comment).map((v) => ({ steamId: v.steam_id, comment: v.comment })),
      ...scoreGame(votes),
      notPlayed: satOut.get(g.id) || [],
      mySkip: mine.get(g.id) || null,
      factSources: factSources.get(g.id) || {},
      ownership: ownership.byGame.get(g.id) || {},
      completionSuggestion,
      viability: viability(g, need),
    };
  });

  return json({
    games,
    // Account and sync watermarks are inputs to the three-state ownership
    // inference, not frontend data. Steam IDs already identify the members.
    members: memberRows.map(({ account, synced_games, synced_at, ...member }) => member),
    group: {
      slug: data.group.slug, name: data.group.name, maxPlayers: need, role: data.group.role,
      blindRating: !!data.group.blind_rating, mode: data.group.workspace_mode,
      historyPrompts: !!data.group.history_prompts,
    },
    model: { mean: Math.round(glob.mean * 100) / 100, sd: Math.round(glob.sd * 100) / 100 },
  });
}

/** Add a game from a Steam URL, a bare appid, a plain name, or by hand. */
export async function onRequestPost({ request, env, data }) {
  const { input, maxPlayers, status, manual, name, genre } = await body(request);
  const gid = data.group.group_id;
  const cleanInput = cleanGameInput(status, maxPlayers, genre);
  if (cleanInput.error) return bad(cleanInput.error);

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
    ).bind(gid, clean, cleanInput.genre, cleanInput.status, cleanInput.maxPlayers,
           data.user.steam_id).run();

    return json({ ok: true, id: res.meta.last_row_id, name: clean, manual: true }, 201);
  }

  if (!input || !String(input).trim()) return bad('give me a Steam link, an appid, or a game name');
  if (String(input).length > 500) return bad('that Steam search is too long');

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
    gid, meta.name, appid, meta.genre, cleanInput.status,
    cleanInput.maxPlayers, meta.header_image, meta.trailer_url,
    meta.short_description, meta.price, meta.release_date, meta.metacritic,
    data.user.steam_id
  ).run();

  return json({ ok: true, id: res.meta.last_row_id, name: meta.name }, 201);
}
