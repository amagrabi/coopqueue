import { json } from '../../../../lib/http.js';
import { calibrate, globalStats, scoreGame } from '../../../../lib/score.js';

const PLAYED = new Set(['finished', 'unfinished', 'dropped', 'sampled']);
const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);

export async function onRequestGet({ env, data }) {
  const gid = data.group.group_id;
  const need = data.group.max_players;

  const [gamesRes, ratingsRes, membersRes, skipsRes] = await Promise.all([
    // Archived games are out of the stats too: they are no longer part of what
    // the group is choosing between, and leaving them in would quietly inflate
    // coverage denominators and genre averages.
    env.DB.prepare(
      'SELECT id, name, genre, status, hours, max_players FROM games WHERE group_id = ? AND archived_at IS NULL'
    ).bind(gid).all(),
    env.DB.prepare(
      `SELECT r.game_id, r.steam_id, r.score FROM ratings r
         JOIN games g ON g.id = r.game_id
        WHERE g.group_id = ? AND g.archived_at IS NULL`
    ).bind(gid).all(),
    env.DB.prepare(
      `SELECT m.steam_id, m.short_name, u.avatar FROM memberships m
         JOIN users u ON u.steam_id = m.steam_id
        WHERE m.group_id = ? ORDER BY m.short_name COLLATE NOCASE`
    ).bind(gid).all(),
    env.DB.prepare(
      `SELECT s.game_id, s.steam_id, s.not_played FROM skips s
         JOIN games g ON g.id = s.game_id
        WHERE g.group_id = ? AND g.archived_at IS NULL`
    ).bind(gid).all(),
  ]);

  const games = gamesRes.results || [];
  const skips = skipsRes.results || [];
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

  /* Coverage is per person, and so is the denominator. A game somebody sat out is
     one they cannot rate, so it comes out of THEIR total rather than counting
     against them — otherwise a group of four that often plays as three reads as
     three apathetic members. "No opinion" is not the same thing and still counts. */
  const satOut = new Map();
  for (const s of skips) {
    if (!s.not_played) continue;
    satOut.set(s.steam_id, (satOut.get(s.steam_id) || 0) + 1);
  }

  const people = members.map((u) => {
    const c = cal.get(u.steam_id);
    const mine = ratings.filter((r) => r.steam_id === u.steam_id);
    const denom = games.length - (satOut.get(u.steam_id) || 0);
    return {
      steamId: u.steam_id, name: u.short_name, avatar: u.avatar, count: mine.length,
      notPlayed: satOut.get(u.steam_id) || 0,
      coverage: denom > 0 ? Math.round((mine.length / denom) * 100) : 0,
      mean: r2(c?.mean), sd: r2(c?.sd),
      min: mine.length ? Math.min(...mine.map((m) => m.score)) : null,
      max: mine.length ? Math.max(...mine.map((m) => m.score)) : null,
    };
  });

  /* ── who agrees with whom ─────────────────────────────────────────────────
     Mean absolute difference over the games a pair BOTH rated. Pairs need a
     minimum overlap or the answer is noise: two people who overlap on one game
     and happened to agree would otherwise top the list. */
  const MIN_OVERLAP = 5;
  const scoreOf = new Map();          // `${gameId}:${steamId}` -> score
  for (const r of ratings) scoreOf.set(`${r.game_id}:${r.steam_id}`, r.score);

  const pairs = [];
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      const a = members[i], b = members[j];
      let n = 0, sum = 0;
      for (const g of games) {
        const x = scoreOf.get(`${g.id}:${a.steam_id}`);
        const y = scoreOf.get(`${g.id}:${b.steam_id}`);
        if (x == null || y == null) continue;
        n++; sum += Math.abs(x - y);
      }
      if (n >= MIN_OVERLAP) {
        pairs.push({ a: a.short_name, b: b.short_name, aId: a.steam_id, bId: b.steam_id,
                     n, gap: r2(sum / n) });
      }
    }
  }
  pairs.sort((x, y) => x.gap - y.gap);

  /* ── who is furthest from everyone else ───────────────────────────────────
     Compared against the mean of the OTHERS, never the group mean including
     yourself: including your own score damps exactly the disagreement being
     measured, and does so more the fewer people voted. */
  const contrarian = members.map((u) => {
    let n = 0, sum = 0;
    for (const g of games) {
      const mine = scoreOf.get(`${g.id}:${u.steam_id}`);
      if (mine == null) continue;
      const others = (byGame.get(g.id) || []).filter((v) => v.steam_id !== u.steam_id);
      if (others.length < 2) continue;
      const avg = others.reduce((a, v) => a + v.score, 0) / others.length;
      n++; sum += Math.abs(mine - avg);
    }
    return { steamId: u.steam_id, name: u.short_name, n, gap: n ? r2(sum / n) : null };
  }).filter((x) => x.n >= MIN_OVERLAP).sort((a, b) => b.gap - a.gap);

  /* ── the genre each person is out of step on ──────────────────────────────
     Signed, so it says which way: positive means you like the genre more than
     the rest of them do. */
  const MIN_GENRE = 3;
  const offbeat = [];
  for (const u of members) {
    const byGenre = new Map();
    for (const g of games) {
      if (!g.genre) continue;
      const mine = scoreOf.get(`${g.id}:${u.steam_id}`);
      if (mine == null) continue;
      const others = (byGame.get(g.id) || []).filter((v) => v.steam_id !== u.steam_id);
      if (!others.length) continue;
      const avg = others.reduce((a, v) => a + v.score, 0) / others.length;
      if (!byGenre.has(g.genre)) byGenre.set(g.genre, []);
      byGenre.get(g.genre).push(mine - avg);
    }
    let worst = null;
    for (const [genre, diffs] of byGenre) {
      if (diffs.length < MIN_GENRE) continue;
      const d = diffs.reduce((a, b) => a + b, 0) / diffs.length;
      if (!worst || Math.abs(d) > Math.abs(worst.diff)) {
        worst = { genre, diff: r2(d), n: diffs.length };
      }
    }
    if (worst) offbeat.push({ name: u.short_name, steamId: u.steam_id, ...worst });
  }
  offbeat.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));

  /* ── games nobody will commit to ──────────────────────────────────────────
     Skipped means "looked at it, no opinion". A game several people skipped and
     nobody rated is the clearest delete candidate the data can offer. */
  const skipCount = new Map();
  for (const sk of skips) skipCount.set(sk.game_id, (skipCount.get(sk.game_id) || 0) + 1);
  const shrugged = games
    .map((g) => ({ id: g.id, name: g.name, skips: skipCount.get(g.id) || 0, votes: (byGame.get(g.id) || []).length }))
    .filter((g) => g.skips >= 2 && g.votes === 0)
    .sort((a, b) => b.skips - a.skips)
    .slice(0, 8);

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
    tasteTwins: pairs.length ? pairs[0] : null,
    tasteOpposites: pairs.length > 1 ? pairs[pairs.length - 1] : null,
    pairs,
    contrarian,
    offbeat,
    shrugged,
    topRated: played.slice().sort((a, b) => b.raw - a.raw).slice(0, 10)
      .map((g) => ({ id: g.id, name: g.name, raw: g.raw, n: g.n })),
    mostHours: games.filter((g) => g.hours).sort((a, b) => b.hours - a.hours).slice(0, 8)
      .map((g) => ({ id: g.id, name: g.name, hours: g.hours })),
  });
}
