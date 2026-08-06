import { json } from '../../../../lib/http.js';
import { calibrate, globalStats, scoreGame } from '../../../../lib/score.js';

const PLAYED = new Set(['finished', 'dropped', 'sampled']);
const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);

export async function onRequestGet({ env, data }) {
  const gid = data.group.group_id;
  const need = data.group.max_players;

  const [gamesRes, ratingsRes, membersRes] = await Promise.all([
    env.DB.prepare('SELECT id, name, genre, status, hours, max_players FROM games WHERE group_id = ?').bind(gid).all(),
    env.DB.prepare(
      `SELECT r.game_id, r.steam_id, r.score FROM ratings r
         JOIN games g ON g.id = r.game_id WHERE g.group_id = ?`
    ).bind(gid).all(),
    env.DB.prepare(
      `SELECT m.steam_id, m.short_name, u.avatar FROM memberships m
         JOIN users u ON u.steam_id = m.steam_id
        WHERE m.group_id = ? ORDER BY m.short_name COLLATE NOCASE`
    ).bind(gid).all(),
  ]);

  const games = gamesRes.results || [];
  const ratings = ratingsRes.results || [];
  const members = membersRes.results || [];
  const cal = calibrate(ratings);
  const glob = globalStats(ratings);

  const byGame = new Map();
  for (const r of ratings) {
    if (!byGame.has(r.game_id)) byGame.set(r.game_id, []);
    byGame.get(r.game_id).push(r);
  }

  const scored = games.map((g) => ({ ...g, ...scoreGame(byGame.get(g.id) || []) }));
  const played = scored.filter((g) => PLAYED.has(g.status) && g.n > 0);

  const people = members.map((u) => {
    const c = cal.get(u.steam_id);
    const mine = ratings.filter((r) => r.steam_id === u.steam_id);
    return {
      steamId: u.steam_id, name: u.short_name, avatar: u.avatar, count: mine.length,
      coverage: games.length ? Math.round((mine.length / games.length) * 100) : 0,
      mean: r2(c?.mean), sd: r2(c?.sd),
      min: mine.length ? Math.min(...mine.map((m) => m.score)) : null,
      max: mine.length ? Math.max(...mine.map((m) => m.score)) : null,
    };
  });

  const genreMap = new Map();
  for (const g of played) {
    if (!g.genre) continue;
    if (!genreMap.has(g.genre)) genreMap.set(g.genre, []);
    genreMap.get(g.genre).push(g.raw);
  }

  return json({
    totals: {
      games: games.length,
      finished: games.filter((g) => g.status === 'finished').length,
      backlog: games.filter((g) => g.status === 'backlog').length,
      ratings: ratings.length,
      hours: Math.round(games.reduce((a, g) => a + (g.hours || 0), 0)),
      unviableBacklog: games.filter(
        (g) => g.status === 'backlog' && g.max_players != null && g.max_players < need
      ).length,
      groupMean: r2(glob.mean),
      maxPlayers: need,
    },
    people,
    genres: [...genreMap.entries()]
      .map(([genre, xs]) => ({ genre, n: xs.length, avg: r2(xs.reduce((a, b) => a + b, 0) / xs.length) }))
      .sort((a, b) => b.avg - a.avg),
    arguments: played
      .filter((g) => g.n >= 3 && g.spread >= 2)
      .sort((a, b) => b.spread - a.spread)
      .slice(0, 10)
      .map((g) => ({
        id: g.id, name: g.name, spread: g.spread,
        votes: Object.fromEntries((byGame.get(g.id) || []).map((v) => [v.steam_id, v.score])),
      })),
    topRated: played.slice().sort((a, b) => b.raw - a.raw).slice(0, 10)
      .map((g) => ({ id: g.id, name: g.name, raw: g.raw, n: g.n })),
    mostHours: games.filter((g) => g.hours).sort((a, b) => b.hours - a.hours).slice(0, 8)
      .map((g) => ({ id: g.id, name: g.name, hours: g.hours })),
  });
}
