/**
 * Test harness: serves the real static frontend and reimplements the
 * group-scoped API on top of the real lib/ modules and the real schema+seed.
 * Exercises scoring, viability, tenancy and the whole UI without needing
 * Cloudflare's local D1 emulation.
 *
 *   node test/harness.mjs            # signed in as a claimed member of g4m1ng
 *   SCENARIO=fresh node ...          # signed in, no groups (onboarding)
 *   SCENARIO=claim node ...          # in the group, nothing claimed yet
 *   SCENARIO=anon  node ...          # signed out (landing page)
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { calibrate, globalStats, scoreGame, viability } from '../lib/score.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.join(here, '..');
const PUBLIC = path.join(SITE, 'public');
const SCENARIO = process.env.SCENARIO || 'member';
const ME = '76561198000000001';
const OTHER = '76561198000000009'; // a second account, in a different group only

const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys = ON');
db.exec(fs.readFileSync(path.join(SITE, 'schema.sql'), 'utf8'));
db.exec(fs.readFileSync(path.join(SITE, 'seed.sql'), 'utf8'));

db.exec(`INSERT INTO users (steam_id, display_name, avatar) VALUES
  ('${ME}','Amadeus',NULL), ('${OTHER}','Someone Else',NULL)`);

// The global catalogue, so the Browse view has something to show. Uses the real
// crawl output when it has been generated, otherwise a handful of rows — enough
// to exercise pooling, the verified/unverified split and the "fits us" filter.
const crawled = path.join(SITE, 'migrations', '002-coop-seed.sql');
if (fs.existsSync(crawled)) {
  db.exec(fs.readFileSync(crawled, 'utf8'));
} else {
  db.exec(`INSERT INTO coop_apps (appid, name, popularity_rank, genre, price, release_date, max_players, max_players_src, coop_categories) VALUES
    (413150,'Stardew Valley',1,'Simulation','13,99€','26 Feb, 2016',4,'manual','["Online Co-op"]'),
    (620,'Portal 2',2,'Action','9,99€','19 Apr, 2011',2,'manual','["Online Co-op"]'),
    (892970,'Valheim',3,'Survival','16,79€','2 Feb, 2021',10,'manual','["Online Co-op"]'),
    (1086940,'Baldur''s Gate 3',4,'RPG','59,99€','3 Aug, 2023',4,'manual','["Online Co-op"]'),
    (548430,'Deep Rock Galactic',5,'Action','27,99€','13 May, 2020',4,'manual','["Online Co-op"]'),
    (1966720,'Lethal Company',6,'Horror','9,75€','23 Oct, 2023',4,'manual','["Online Co-op"]'),
    (322330,'Do Not Starve Together',7,'Survival','12,99€','21 Apr, 2016',NULL,NULL,'["Online Co-op"]'),
    (105600,'Terraria',8,'Sandbox','9,99€','16 May, 2011',NULL,NULL,'["Online Co-op"]')`);
}

// Give every group-1 game real Steam metadata, so the rating card can be worked
// on locally whichever game the queue happens to surface first — the layout of
// that card depends entirely on a trailer being present, and seed.sql has none.
db.exec(`UPDATE games SET
    trailer_url = 'https://video.akamai.steamstatic.com/store_trailers/924970/519586/c7aa4fb6d755acacbf63aeb1ac3f4d31eaf084ab/1750596823/hls_264_master.m3u8?t=1670349696',
    header_image = 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/105600/header.jpg',
    short_description = 'Back 4 Blood is a thrilling cooperative first-person shooter from the creators of the critically acclaimed Left 4 Dead franchise. Experience the intense 4 player co-op narrative campaign, competitive multiplayer as human or Ridden, and frenetic gameplay that keeps you in the action.'
  WHERE group_id = 1`);
// steam_appid on one row only: UNIQUE (group_id, steam_appid) forbids sharing an
// appid. 105600 is Terraria, which the crawled catalogue actually contains, so the
// LEFT JOIN onto coop_apps has something to match and the Steam-verdict chip
// renders — with a made-up appid it silently stays blank.
// Targets the game the queue surfaces first — the queue puts backlog games ahead
// of played ones, so plain name order picks the wrong row — making the chip
// visible without clicking through. 105600 is Terraria, which the crawled
// catalogue contains — a made-up appid joins to nothing and stays silently blank.
db.exec(`UPDATE games SET steam_appid = 105600
          WHERE id = (SELECT id FROM games WHERE group_id = 1
                       ORDER BY CASE status WHEN 'backlog' THEN 0 ELSE 1 END,
                                name COLLATE NOCASE LIMIT 1)`);

if (SCENARIO === 'member') {
  // Ama has already claimed their imported identity.
  db.exec(`INSERT INTO memberships (group_id, steam_id, short_name, role) VALUES (1,'${ME}','Ama','owner')`);
  db.exec(`UPDATE ratings SET steam_id='${ME}' WHERE steam_id='seed:1:ama'`);
  db.exec(`DELETE FROM memberships WHERE steam_id='seed:1:ama'`);
  db.exec(`DELETE FROM users WHERE steam_id='seed:1:ama'`);
} else if (SCENARIO === 'claim') {
  db.exec(`INSERT INTO memberships (group_id, steam_id, short_name, role) VALUES (1,'${ME}','Amadeus','owner')`);
}
// A second group the test user also belongs to, to exercise the switcher.
if (SCENARIO === 'member') {
  db.exec(`INSERT INTO groups (id, slug, name, invite_code, max_players)
           VALUES (2,'tuesday-trio','Tuesday Trio','TRIOCODE99',3)`);
  db.exec(`INSERT INTO memberships (group_id, steam_id, short_name, role) VALUES
           (2,'${ME}','Amadeus','member'), (2,'${OTHER}','Sam','owner')`);
  db.exec(`INSERT INTO games (id, group_id, name, genre, status, max_players) VALUES
           (900,2,'Trine 2','Puzzle','backlog',3),
           (901,2,'Secret Trio Game','Shooter','finished',3)`);
  db.exec(`INSERT INTO ratings (game_id, steam_id, score) VALUES (901,'${OTHER}',9)`);
}

const q = (sql, ...a) => db.prepare(sql).all(...a);
const one = (sql, ...a) => db.prepare(sql).get(...a);
const send = (res, code, data) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
};
const readBody = async (req) => { let b = ''; for await (const c of req) b += c; return b ? JSON.parse(b) : {}; };

function groupCtx(slug) {
  return one(
    `SELECT g.id AS group_id, g.slug, g.name, g.invite_code, g.max_players, m.short_name, m.role
       FROM groups g JOIN memberships m ON m.group_id=g.id AND m.steam_id=?
      WHERE g.slug=?`, ME, slug);
}

function libraryFor(gid, need) {
  // Mirrors the real handler's LEFT JOIN onto the catalogue for Steam's verdict.
  const games = q(
    `SELECT g.*, c.review_hint AS steam_review_hint, c.review_count AS steam_review_count
       FROM games g LEFT JOIN coop_apps c ON c.appid = g.steam_appid
      WHERE g.group_id=? ORDER BY g.name COLLATE NOCASE`, gid);
  const ratings = q(
    'SELECT r.game_id, r.steam_id, r.score, r.comment FROM ratings r JOIN games g ON g.id=r.game_id WHERE g.group_id=?', gid);
  const members = q(
    `SELECT m.steam_id, m.short_name, m.is_seed, u.avatar, u.display_name
       FROM memberships m JOIN users u ON u.steam_id=m.steam_id
      WHERE m.group_id=? ORDER BY m.short_name COLLATE NOCASE`, gid);
  const cal = calibrate(ratings), glob = globalStats(ratings);
  const byGame = new Map();
  for (const r of ratings) { if (!byGame.has(r.game_id)) byGame.set(r.game_id, []); byGame.get(r.game_id).push(r); }
  return {
    ratings, cal, glob, members, byGame,
    games: games.map((g) => {
      const votes = byGame.get(g.id) || [];
      return { ...g, votes: Object.fromEntries(votes.map((v) => [v.steam_id, v.score])),
               comments: [], ...scoreGame(votes), viability: viability(g, need) };
    }),
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (SCENARIO === 'anon' && p.startsWith('/api/') && !p.startsWith('/api/auth')) {
    return send(res, 401, { error: 'not signed in' });
  }

  if (p === '/api/me') {
    const groups = q(
      `SELECT g.slug, g.name, m.role, m.short_name,
              (SELECT COUNT(*) FROM memberships mm WHERE mm.group_id=g.id) AS members,
              (SELECT COUNT(*) FROM games gg WHERE gg.group_id=g.id) AS games,
              (SELECT COUNT(*) FROM games gg WHERE gg.group_id=g.id
                 AND NOT EXISTS (SELECT 1 FROM ratings r WHERE r.game_id=gg.id AND r.steam_id=?1)
                 AND NOT EXISTS (SELECT 1 FROM skips s WHERE s.game_id=gg.id AND s.steam_id=?1)) AS unrated
         FROM groups g JOIN memberships m ON m.group_id=g.id
        WHERE m.steam_id=?1 ORDER BY g.name COLLATE NOCASE`, ME);
    return send(res, 200, {
      user: { steamId: ME, displayName: 'Amadeus', avatar: null },
      groups: SCENARIO === 'fresh' ? [] : groups,
    });
  }

  // The global catalogue. Group-blind, exactly like the real handler — the
  // Browse view works out "already in your pool" client-side.
  if (p === '/api/coop') {
    const term = (url.searchParams.get('q') || '').trim().toLowerCase();
    const sort = url.searchParams.get('sort') || 'rank';
    const page = Math.max(0, Number(url.searchParams.get('page')) || 0);
    const minPlayers = Math.max(0, Number(url.searchParams.get('minPlayers')) || 0);
    const PAGE = 24;

    let rows = q('SELECT * FROM coop_apps');
    if (term) rows = rows.filter((g) => g.name.toLowerCase().includes(term));
    if (minPlayers) rows = rows.filter((g) => g.max_players != null && g.max_players >= minPlayers);
    rows.sort({
      rank: (a, b) => (a.popularity_rank ?? 1e9) - (b.popularity_rank ?? 1e9),
      name: (a, b) => a.name.localeCompare(b.name),
      new:  (a, b) => (b.release_ts ?? -1) - (a.release_ts ?? -1),
    }[sort] || ((a, b) => (a.popularity_rank ?? 1e9) - (b.popularity_rank ?? 1e9)));

    const slice = rows.slice(page * PAGE, page * PAGE + PAGE + 1);
    return send(res, 200, {
      games: slice.slice(0, PAGE), page, hasMore: slice.length > PAGE, total: rows.length,
    });
  }

  // Steam search, stubbed from the catalogue so the add dialog is testable —
  // including its "already in your library" flag, which needs a hit whose appid
  // the group already has.
  if (p === '/api/steam/search') {
    const term = (url.searchParams.get('q') || '').trim().toLowerCase();
    if (term.length < 2) return send(res, 200, { results: [] });
    const rows = q(`SELECT appid, name, header_image, price, release_date FROM coop_apps
                     WHERE name LIKE ? ORDER BY popularity_rank LIMIT 8`, `%${term}%`);
    return send(res, 200, {
      results: rows.map((r) => ({
        appid: r.appid, name: r.name, image: r.header_image,
        price: r.price, release: r.release_date,
      })),
    });
  }

  const gm = p.match(/^\/api\/g\/([^/]+)(\/.*)?$/);
  if (gm) {
    const ctx = groupCtx(decodeURIComponent(gm[1]));
    if (!ctx) return send(res, 404, { error: 'no such group' });
    const sub = gm[2] || '';
    const gid = ctx.group_id, need = ctx.max_players;

    if (sub === '/games' && req.method === 'GET') {
      const L = libraryFor(gid, need);
      return send(res, 200, {
        games: L.games, members: L.members,
        group: { slug: ctx.slug, name: ctx.name, maxPlayers: need, role: ctx.role },
        model: { mean: +L.glob.mean.toFixed(2), sd: +L.glob.sd.toFixed(2) },
      });
    }
    if (sub === '/games' && req.method === 'POST') {
      const b = await readBody(req);
      if (!b.manual) return send(res, 400, { error: 'the harness only implements manual adds' });
      const name = String(b.name || '').trim();
      if (name.length < 2) return send(res, 400, { error: 'give the game a name' });
      if (one('SELECT 1 FROM games WHERE group_id=? AND name=? COLLATE NOCASE', gid, name)) {
        return send(res, 409, { error: `${name} is already on your list` });
      }
      db.prepare(`INSERT INTO games (group_id, name, genre, status, max_players, enriched_at)
                  VALUES (?,?,?,'backlog',?,unixepoch())`)
        .run(gid, name, b.genre || null, b.maxPlayers || null);
      return send(res, 201, { ok: true, name, manual: true });
    }
    if (sub === '/skip' && req.method === 'GET') {
      return send(res, 200, { queue: q(
        `SELECT g.id FROM games g WHERE g.group_id=?2
           AND NOT EXISTS (SELECT 1 FROM ratings r WHERE r.game_id=g.id AND r.steam_id=?1)
           AND NOT EXISTS (SELECT 1 FROM skips s WHERE s.game_id=g.id AND s.steam_id=?1)
         ORDER BY CASE g.status WHEN 'backlog' THEN 0 ELSE 1 END, g.name COLLATE NOCASE`,
        ME, gid).map((r) => r.id) });
    }
    if (sub === '/claim' && req.method === 'GET') {
      const mine = one(
        'SELECT COUNT(*) AS n FROM ratings r JOIN games g ON g.id=r.game_id WHERE g.group_id=? AND r.steam_id=?', gid, ME);
      return send(res, 200, {
        canClaim: mine.n === 0,
        unclaimed: q('SELECT steam_id, short_name FROM memberships WHERE group_id=? AND is_seed=1 ORDER BY short_name', gid)
          .map((s) => ({ seedId: s.steam_id, name: s.short_name })),
      });
    }
    if (sub === '/claim' && req.method === 'POST') {
      const { seedId } = await readBody(req);
      const seed = one('SELECT short_name FROM memberships WHERE group_id=? AND steam_id=? AND is_seed=1', gid, seedId);
      if (!seed) return send(res, 409, { error: 'already claimed' });
      db.prepare('UPDATE ratings SET steam_id=? WHERE steam_id=? AND game_id IN (SELECT id FROM games WHERE group_id=?)').run(ME, seedId, gid);
      db.prepare('UPDATE memberships SET short_name=? WHERE group_id=? AND steam_id=?').run(seed.short_name, gid, ME);
      db.prepare('DELETE FROM memberships WHERE group_id=? AND steam_id=?').run(gid, seedId);
      db.prepare('DELETE FROM users WHERE steam_id=?').run(seedId);
      return send(res, 200, { ok: true, shortName: seed.short_name });
    }
    if (sub === '/rate' && req.method === 'POST') {
      const { gameId, score } = await readBody(req);
      if (!one('SELECT 1 AS x FROM games WHERE id=? AND group_id=?', gameId, gid)) return send(res, 404, { error: 'no such game' });
      db.prepare(`INSERT INTO ratings (game_id, steam_id, score) VALUES (?,?,?)
                  ON CONFLICT(game_id, steam_id) DO UPDATE SET score=excluded.score`).run(gameId, ME, score);
      return send(res, 200, { ok: true });
    }
    if (sub === '/skip' && req.method === 'POST') {
      const { gameId } = await readBody(req);
      if (!one('SELECT 1 AS x FROM games WHERE id=? AND group_id=?', gameId, gid)) return send(res, 404, { error: 'no such game' });
      db.prepare('INSERT OR IGNORE INTO skips (game_id, steam_id) VALUES (?,?)').run(gameId, ME);
      return send(res, 200, { ok: true });
    }
    if (sub === '/members' && req.method === 'GET') {
      return send(res, 200, {
        members: q(
          `SELECT m.steam_id, m.short_name, m.role, m.is_seed, u.avatar, u.display_name,
                  (SELECT COUNT(*) FROM ratings r JOIN games gg ON gg.id=r.game_id
                    WHERE r.steam_id=m.steam_id AND gg.group_id=m.group_id) AS ratings
             FROM memberships m JOIN users u ON u.steam_id=m.steam_id
            WHERE m.group_id=? ORDER BY m.is_seed, m.short_name COLLATE NOCASE`, gid),
        group: { slug: ctx.slug, name: ctx.name, maxPlayers: need, role: ctx.role,
                 inviteCode: ctx.role === 'owner' ? ctx.invite_code : null },
      });
    }
    if (sub === '/stats') {
      const L = libraryFor(gid, need);
      const PLAYED = new Set(['finished', 'dropped', 'sampled']);
      const played = L.games.filter((g) => PLAYED.has(g.status) && g.n > 0);
      const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);
      const gmap = new Map();
      for (const g of played) { if (!g.genre) continue; if (!gmap.has(g.genre)) gmap.set(g.genre, []); gmap.get(g.genre).push(g.raw); }
      return send(res, 200, {
        totals: {
          games: L.games.length,
          finished: L.games.filter((g) => g.status === 'finished').length,
          backlog: L.games.filter((g) => g.status === 'backlog').length,
          ratings: L.ratings.length,
          hours: Math.round(L.games.reduce((a, g) => a + (g.hours || 0), 0)),
          unviableBacklog: L.games.filter((g) => g.status === 'backlog' && g.max_players != null && g.max_players < need).length,
          groupMean: r2(L.glob.mean), maxPlayers: need,
        },
        people: L.members.map((u) => {
          const c = L.cal.get(u.steam_id);
          const mine = L.ratings.filter((r) => r.steam_id === u.steam_id);
          return { steamId: u.steam_id, name: u.short_name, avatar: null, count: mine.length,
            coverage: L.games.length ? Math.round((mine.length / L.games.length) * 100) : 0,
            mean: r2(c?.mean), sd: r2(c?.sd),
            min: mine.length ? Math.min(...mine.map((m) => m.score)) : null,
            max: mine.length ? Math.max(...mine.map((m) => m.score)) : null };
        }),
        genres: [...gmap.entries()].map(([genre, xs]) => ({ genre, n: xs.length, avg: r2(xs.reduce((a, b) => a + b, 0) / xs.length) })).sort((a, b) => b.avg - a.avg),
        arguments: played.filter((g) => g.n >= 3 && g.spread >= 2).sort((a, b) => b.spread - a.spread).slice(0, 10)
          .map((g) => ({ id: g.id, name: g.name, spread: g.spread, votes: g.votes })),
        topRated: played.slice().sort((a, b) => b.raw - a.raw).slice(0, 10)
          .map((g) => ({ id: g.id, name: g.name, raw: g.raw, n: g.n })),
        mostHours: L.games.filter((g) => g.hours).sort((a, b) => b.hours - a.hours).slice(0, 8)
          .map((g) => ({ id: g.id, name: g.name, hours: g.hours })),
      });
    }
    return send(res, 200, { ok: true });
  }

  if (p.startsWith('/api/')) return send(res, 200, { ok: true, results: [], groups: [] });

  const file = path.join(PUBLIC, p === '/' ? 'index.html' : p);
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file)) { res.writeHead(404); return res.end('nope'); }
  res.writeHead(200, { 'content-type': { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' }[path.extname(file)] || 'text/plain' });
  res.end(fs.readFileSync(file));
});

server.listen(4321, () => console.log(`harness on http://127.0.0.1:4321  (scenario: ${SCENARIO})`));
