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
import { recommend } from '../lib/recommend.js';
import { classifyCoop } from '../lib/coop.js';

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
  /* Real tag lists, not invented ones: the "Recommended for us" sort ranks on
     tag overlap, so made-up tags would make the local ordering meaningless. The
     last row is deliberately PvP-primary so the co-op filter has something to
     hide — without one, ticking the box looks like it does nothing. */
  db.exec(`INSERT INTO coop_apps (appid, name, popularity_rank, genre, price, release_date, max_players, max_players_src, coop_categories, review_count, tags, is_coop, tags_at) VALUES
    (413150,'Stardew Valley',1,'Simulation','13,99€','26 Feb, 2016',4,'manual','["Online Co-op"]',780000,'["Farming Sim","Pixel Graphics","Multiplayer","Life Sim","RPG","Relaxing"]',1,1),
    (620,'Portal 2',2,'Action','9,99€','19 Apr, 2011',2,'manual','["Online Co-op"]',320000,'["Puzzle","Co-op","First-Person","Comedy","Sci-fi","Singleplayer"]',1,1),
    (892970,'Valheim',3,'Survival','16,79€','2 Feb, 2021',10,'manual','["Online Co-op"]',480000,'["Open World Survival Craft","Survival","Online Co-Op","Open World","Multiplayer","Building"]',1,1),
    (1086940,'Baldur''s Gate 3',4,'RPG','59,99€','3 Aug, 2023',4,'manual','["Online Co-op"]',650000,'["RPG","Character Customization","Choices Matter","Story Rich","Turn-Based Combat","Co-op"]',1,1),
    (548430,'Deep Rock Galactic',5,'Action','27,99€','13 May, 2020',4,'manual','["Online Co-op"]',270000,'["Dwarf","Co-op","PvE","FPS","Procedural Generation","Class-Based"]',1,1),
    (1966720,'Lethal Company',6,'Horror','9,75€','23 Oct, 2023',4,'manual','["Online Co-op"]',400000,'["Horror","Co-op","Comedy","Online Co-Op","Survival Horror","Multiplayer"]',1,1),
    (322330,'Do Not Starve Together',7,'Survival','12,99€','21 Apr, 2016',NULL,NULL,'["Online Co-op"]',240000,'["Survival","Multiplayer","Open World Survival Craft","Co-op","Crafting","Sandbox"]',1,1),
    (105600,'Terraria',8,'Sandbox','9,99€','16 May, 2011',NULL,NULL,'["Online Co-op"]',1030000,'["Open World Survival Craft","Sandbox","Survival","2D","Multiplayer","Adventure"]',1,1),
    (1172470,'Apex Legends',9,'Action','Free','5 Nov, 2020',3,'manual','["Online Co-op"]',760000,'["Free to Play","Battle Royale","Multiplayer","FPS","Shooter","First-Person"]',0,1)`);
}

// Give every group-1 game real Steam metadata, so the rating card can be worked
// on locally whichever game the queue happens to surface first — the layout of
// that card depends entirely on a trailer being present, and seed.sql has none.
db.exec(`UPDATE games SET
    trailer_url = 'https://video.akamai.steamstatic.com/store_trailers/924970/519586/c7aa4fb6d755acacbf63aeb1ac3f4d31eaf084ab/1750596823/hls_264_master.m3u8?t=1670349696',
    header_image = 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/105600/header.jpg',
    short_description = 'Back 4 Blood is a thrilling cooperative first-person shooter from the creators of the critically acclaimed Left 4 Dead franchise. Experience the intense 4 player co-op narrative campaign, competitive multiplayer as human or Ridden, and frenetic gameplay that keeps you in the action.'
  WHERE group_id = 1`);
/* Link the library to the catalogue by name. Real appids, not invented ones: about
   20 of group 1's games are in the crawled catalogue under exactly the same name,
   which is unsurprising — the catalogue is the popular co-op games and this is a
   co-op group's library.

   This is what makes the "Recommended for us" sort testable locally. It ranks on
   tag overlap between rated games and candidates, so with no appid there is no
   catalogue row, no tags, and every candidate scores null — the taste path would
   silently never render and only the popularity fallback would ever be visible.

   `WHERE steam_appid IS NULL` plus the NOT IN guard respect
   UNIQUE (group_id, steam_appid), which forbids two rows sharing an appid. */
db.exec(`UPDATE games SET steam_appid = (SELECT c.appid FROM coop_apps c WHERE c.name = games.name)
          WHERE group_id = 1 AND steam_appid IS NULL
            AND EXISTS (SELECT 1 FROM coop_apps c WHERE c.name = games.name)
            AND (SELECT c.appid FROM coop_apps c WHERE c.name = games.name)
                NOT IN (SELECT steam_appid FROM games WHERE group_id = 1 AND steam_appid IS NOT NULL)`);

// Then one guaranteed link for the rating card: the queue puts backlog games ahead
// of played ones, so plain name order picks the wrong row. 105600 is Terraria, which
// the crawled catalogue contains, so the Steam-verdict chip renders without clicking
// through — a made-up appid joins to nothing and stays silently blank.
db.exec(`UPDATE games SET steam_appid = 105600
          WHERE steam_appid IS NULL
            AND 105600 NOT IN (SELECT steam_appid FROM games
                                WHERE group_id = 1 AND steam_appid IS NOT NULL)
            AND id = (SELECT id FROM games WHERE group_id = 1
                       ORDER BY CASE status WHEN 'backlog' THEN 0 ELSE 1 END,
                                name COLLATE NOCASE LIMIT 1)`);

/* Real tag lists for catalogue rows the crawl has not tagged yet, so the taste
   ranking has something to match on locally. Copied from production rather than
   made up — invented tags would make the local ordering meaningless, which is the
   one thing this fixture exists to let someone check. */
const FIXTURE_TAGS = [
  ['Valheim', ['Open World Survival Craft', 'Survival', 'Online Co-Op', 'Open World', 'Multiplayer', 'Building']],
  ['Grounded', ['Survival', 'Multiplayer', 'Co-op', 'Open World Survival Craft', 'Base-Building', 'Crafting']],
  ['Raft', ['Survival', 'Multiplayer', 'Open World Survival Craft', 'Co-op', 'Crafting', 'Open World']],
  ['Deep Rock Galactic', ['Dwarf', 'Co-op', 'PvE', 'FPS', 'Procedural Generation', 'Class-Based']],
  ['The Ascent', ['Top-Down Shooter', 'Cyberpunk', 'RPG', 'Action', 'Co-op', 'Shooter']],
  ['Satisfactory', ['Base-Building', 'Automation', 'Open World', 'Multiplayer', 'Crafting', 'Co-op']],
  ['Green Hell', ['Open World Survival Craft', 'Survival', 'Multiplayer', 'Online Co-Op', 'Open World', 'Crafting']],
  ['Risk of Rain 2', ['Third-Person Shooter', 'Action Roguelike', 'Multiplayer', 'Co-op', 'Action', 'Rogue-lite']],
  ['Chained Together', ['Co-op', 'Adventure', 'Casual', 'Platformer', 'Puzzle-Platformer', 'Simulation']],
  ['Enshrouded', ['Open World', 'Survival', 'Base-Building', 'Multiplayer', 'Online Co-Op', 'Crafting']],
  ['Palworld', ['Open World', 'Survival', 'Creature Collector', 'Multiplayer', 'Open World Survival Craft', 'Online Co-Op']],
  ['Castle Crashers®', ['2D', 'Online Co-Op', 'Co-op', "Beat 'em up", 'Hack and Slash', 'Funny']],
  ['Age of Empires IV: Anniversary Edition', ['Strategy', 'RTS', 'Base-Building', 'Multiplayer', 'War', 'Singleplayer']],
  ['Sea of Thieves: 2026 Edition', ['Multiplayer', 'Open World', 'Adventure', 'Pirates', 'Co-op', 'Online Co-Op']],
  ['Marvel Rivals', ['Free to Play', 'Multiplayer', 'Hero Shooter', 'Third-Person Shooter', 'Action', 'Shooter']],
];
{
  const stmt = db.prepare('UPDATE coop_apps SET tags = ?, is_coop = ?, tags_at = 1 WHERE name = ? AND tags IS NULL');
  for (const [name, tags] of FIXTURE_TAGS) {
    // Classified by the shipped rule, so Marvel Rivals lands on the PvP side here
    // exactly as it does in production and the co-op filter has something to hide.
    stmt.run(JSON.stringify(tags), classifyCoop(tags) ? 1 : 0, name);
  }
}

// A couple of collectively-shrugged-at games, so the "nobody has an opinion"
// panel has something to show locally.
db.exec(`INSERT OR IGNORE INTO skips (game_id, steam_id)
         SELECT id, 'seed:1:leo' FROM games WHERE group_id=1
          AND id NOT IN (SELECT game_id FROM ratings) LIMIT 3`);
db.exec(`INSERT OR IGNORE INTO skips (game_id, steam_id)
         SELECT id, 'seed:1:pat' FROM games WHERE group_id=1
          AND id NOT IN (SELECT game_id FROM ratings) LIMIT 3`);

// Sync state mirroring the real group: some readable, one with a public library
// but playtime hidden — the case that distinguishes the two Steam privacy switches.
const LEO_ACCOUNT = '76561198119052954';
db.exec(`INSERT INTO users (steam_id, display_name) VALUES ('${LEO_ACCOUNT}','Leo')`);
db.exec(`INSERT INTO seed_assignments (group_id, steam_id, seed_steam_id)
         VALUES (1,'${LEO_ACCOUNT}','seed:1:leo')`);
db.exec(`INSERT INTO playtime_sync (steam_id, games, played, synced_at) VALUES
  ('${ME}',122,98,unixepoch()), ('${LEO_ACCOUNT}',455,0,unixepoch())`);

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
    `SELECT g.id AS group_id, g.slug, g.name, g.invite_code, g.max_players, g.blind_rating,
            m.short_name, m.role
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
    if (url.searchParams.get('coopOnly') !== '0') rows = rows.filter((g) => g.is_coop !== 0);
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
        group: { slug: ctx.slug, name: ctx.name, maxPlayers: need, role: ctx.role,
                 blindRating: !!ctx.blind_rating },
        model: { mean: +L.glob.mean.toFixed(2), sd: +L.glob.sd.toFixed(2) },
      });
    }
    if (sub === '/playtime' && req.method === 'GET') {
      const rows = q(`SELECT m.steam_id, m.short_name, m.is_seed,
                             COALESCE(a.steam_id, m.steam_id) AS account,
                             s.games, s.played, s.synced_at
                        FROM memberships m
                        LEFT JOIN seed_assignments a
                               ON a.group_id=m.group_id AND a.seed_steam_id=m.steam_id
                        LEFT JOIN playtime_sync s ON s.steam_id=COALESCE(a.steam_id, m.steam_id)
                       WHERE m.group_id=? ORDER BY m.short_name COLLATE NOCASE`, gid);
      return send(res, 200, {
        members: rows.map((m) => ({
          steamId: m.steam_id, name: m.short_name,
          seed: !!m.is_seed && m.account === m.steam_id,
          syncedAt: m.synced_at ?? null, owned: m.games ?? null, played: m.played ?? null,
          readable: (!!m.is_seed && m.account === m.steam_id) ? null : (m.played ?? 0) > 0,
          reason: ((!!m.is_seed && m.account === m.steam_id) || (m.played ?? 0) > 0) ? null
            : (m.games ?? 0) > 0 ? 'playtime hidden — untick "Always keep my total playtime private"'
                                 : 'game library hidden — set Game details to Public',
        })),
      });
    }
    if (sub === '/playtime' && req.method === 'POST') {
      return send(res, 200, { ok: true, members: [], gamesEstimated: 0 });
    }

    // Taste ranking. Shares lib/recommend.js with the real route, so the Browse
    // view's "Recommended for us" order can be checked here rather than only
    // against production.
    if (sub.startsWith('/recommend') && req.method === 'GET') {
      const term = (url.searchParams.get('q') || '').trim().toLowerCase();
      const page = Math.max(0, Number(url.searchParams.get('page')) || 0);
      const minPlayers = Math.max(0, Number(url.searchParams.get('minPlayers')) || 0);
      const PAGE = 24;

      let rows = q('SELECT * FROM coop_apps');
      if (term) rows = rows.filter((g) => g.name.toLowerCase().includes(term));
      if (minPlayers) rows = rows.filter((g) => g.max_players != null && g.max_players >= minPlayers);
      if (url.searchParams.get('coopOnly') !== '0') rows = rows.filter((g) => g.is_coop !== 0);

      const history = q(`SELECT g.steam_appid AS appid, AVG(r.score) AS score
                           FROM games g JOIN ratings r ON r.game_id=g.id
                          WHERE g.group_id=? AND g.archived_at IS NULL
                            AND g.steam_appid IS NOT NULL GROUP BY g.id`, gid);
      const tagsFor = new Map();
      for (const r of q(`SELECT c.appid, c.tags FROM coop_apps c
                           JOIN games g ON g.steam_appid=c.appid AND g.group_id=?
                          WHERE c.tags IS NOT NULL`, gid)) {
        try {
          const t = JSON.parse(r.tags);
          if (Array.isArray(t)) tagsFor.set(r.appid, t);
        } catch { /* ignore a malformed row */ }
      }

      const out = recommend(rows, history, tagsFor);
      return send(res, 200, {
        games: out.games.slice(page * PAGE, page * PAGE + PAGE),
        page, total: out.games.length,
        hasMore: out.games.length > page * PAGE + PAGE,
        basis: out.basis, ratedGames: out.ratedGames, needed: out.needed,
        likes: out.likes, dislikes: out.dislikes,
      });
    }

    if (sub.startsWith('/comments')) {
      const inGroup = (id) => one('SELECT id FROM games WHERE id=? AND group_id=?', id, gid);
      if (req.method === 'GET') {
        const id = Number(url.searchParams.get('gameId'));
        if (!inGroup(id)) return send(res, 404, { error: 'no such game' });
        const rows = q(`SELECT c.id, c.steam_id, c.body, c.created_at, m.short_name, u.avatar
                          FROM comments c
                          LEFT JOIN memberships m ON m.group_id=c.group_id AND m.steam_id=c.steam_id
                          LEFT JOIN users u ON u.steam_id=c.steam_id
                         WHERE c.game_id=? AND c.group_id=? ORDER BY c.created_at, c.id`, id, gid);
        return send(res, 200, {
          comments: rows.map((c) => ({
            id: c.id, steamId: c.steam_id, name: c.short_name || 'Someone who left',
            avatar: c.avatar, body: c.body, createdAt: c.created_at, mine: c.steam_id === ME,
          })),
        });
      }
      if (req.method === 'POST') {
        const b = await readBody(req);
        if (!inGroup(Number(b.gameId))) return send(res, 404, { error: 'no such game' });
        const text = String(b.body || '').trim();
        if (!text) return send(res, 400, { error: 'write something first' });
        db.prepare('INSERT INTO comments (group_id, game_id, steam_id, body) VALUES (?,?,?,?)')
          .run(gid, Number(b.gameId), ME, text);
        return send(res, 201, { ok: true });
      }
      if (req.method === 'DELETE') {
        const b = await readBody(req);
        const row = one('SELECT steam_id FROM comments WHERE id=? AND group_id=?', Number(b.id), gid);
        if (!row) return send(res, 404, { error: 'no such comment' });
        if (row.steam_id !== ME && ctx.role !== 'owner') {
          return send(res, 403, { error: 'you can only delete your own comments' });
        }
        db.prepare('DELETE FROM comments WHERE id=? AND group_id=?').run(Number(b.id), gid);
        return send(res, 200, { ok: true });
      }
    }

    const gm2 = sub.match(/^\/games\/(\d+)$/);
    if (gm2 && req.method === 'DELETE') {
      const id = Number(gm2[1]);
      const row = one('SELECT name, archived_at FROM games WHERE id=? AND group_id=?', id, gid);
      if (!row) return send(res, 404, { error: 'no such game' });
      const kept = one('SELECT COUNT(*) AS n FROM ratings WHERE game_id=?', id).n;
      db.prepare('UPDATE games SET archived_at=unixepoch() WHERE id=? AND group_id=?').run(id, gid);
      return send(res, 200, { ok: true, name: row.name, archived: true, keptRatings: kept });
    }
    if (gm2 && req.method === 'PATCH') {
      const id = Number(gm2[1]);
      const b = await readBody(req);
      if ('archived' in b) {
        db.prepare('UPDATE games SET archived_at=? WHERE id=? AND group_id=?')
          .run(b.archived ? Math.floor(Date.now() / 1000) : null, id, gid);
      }
      return send(res, 200, { ok: true });
    }
    if (sub === '/group' && req.method === 'DELETE') {
      if (ctx.role !== 'owner') return send(res, 403, { error: 'only the group owner can delete the group' });
      const b = await readBody(req);
      if (String(b.confirmName || '').trim() !== ctx.name) {
        return send(res, 400, { error: 'type the group name exactly to confirm' });
      }
      const counts = one(`SELECT (SELECT COUNT(*) FROM games WHERE group_id=?1) AS games,
                                 (SELECT COUNT(*) FROM ratings r JOIN games g ON g.id=r.game_id
                                   WHERE g.group_id=?1) AS ratings,
                                 (SELECT COUNT(*) FROM memberships WHERE group_id=?1) AS members`, gid);
      db.prepare('DELETE FROM groups WHERE id=?').run(gid);
      return send(res, 200, { ok: true, deleted: counts });
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
           AND g.archived_at IS NULL
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
                 blindRating: !!ctx.blind_rating,
                 inviteCode: ctx.role === 'owner' ? ctx.invite_code : null },
      });
    }
    // Enough of the members PATCH to exercise the settings panel locally.
    if (sub === '/members' && req.method === 'PATCH') {
      const b = await readBody(req);
      if (b.myName != null) {
        db.prepare('UPDATE memberships SET short_name=? WHERE group_id=? AND steam_id=?')
          .run(String(b.myName).slice(0, 16), gid, ME);
      }
      if (b.blindRating != null) {
        if (ctx.role !== 'owner') return send(res, 403, { error: 'only the group owner can change blind rating' });
        db.prepare('UPDATE groups SET blind_rating=? WHERE id=?').run(b.blindRating ? 1 : 0, gid);
      }
      if (b.name != null && ctx.role === 'owner') {
        db.prepare('UPDATE groups SET name=? WHERE id=?').run(String(b.name).slice(0, 60), gid);
      }
      if (b.maxPlayers != null && ctx.role === 'owner') {
        db.prepare('UPDATE groups SET max_players=? WHERE id=?').run(Number(b.maxPlayers), gid);
      }
      return send(res, 200, { ok: true });
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
        ...(() => {
          // Mirrors the real handler's extra statistics closely enough to render.
          const MIN_OVERLAP = 5, MIN_GENRE = 3;
          const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);
          const scoreOf = new Map();
          for (const r of L.ratings) scoreOf.set(`${r.game_id}:${r.steam_id}`, r.score);
          const pairs = [];
          for (let i = 0; i < L.members.length; i++) for (let j = i + 1; j < L.members.length; j++) {
            const a = L.members[i], b = L.members[j];
            let n = 0, sum = 0;
            for (const g of L.games) {
              const x = scoreOf.get(`${g.id}:${a.steam_id}`), y = scoreOf.get(`${g.id}:${b.steam_id}`);
              if (x == null || y == null) continue;
              n++; sum += Math.abs(x - y);
            }
            if (n >= MIN_OVERLAP) pairs.push({ a: a.short_name, b: b.short_name, n, gap: r2(sum / n) });
          }
          pairs.sort((x, y) => x.gap - y.gap);
          const contrarian = L.members.map((u) => {
            let n = 0, sum = 0;
            for (const g of L.games) {
              const mine = scoreOf.get(`${g.id}:${u.steam_id}`);
              if (mine == null) continue;
              const others = (L.byGame.get(g.id) || []).filter((v) => v.steam_id !== u.steam_id);
              if (others.length < 2) continue;
              const avg = others.reduce((a, v) => a + v.score, 0) / others.length;
              n++; sum += Math.abs(mine - avg);
            }
            return { name: u.short_name, n, gap: n ? r2(sum / n) : null };
          }).filter((x) => x.n >= MIN_OVERLAP).sort((a, b) => b.gap - a.gap);
          const offbeat = [];
          for (const u of L.members) {
            const byGenre = new Map();
            for (const g of L.games) {
              if (!g.genre) continue;
              const mine = scoreOf.get(`${g.id}:${u.steam_id}`);
              if (mine == null) continue;
              const others = (L.byGame.get(g.id) || []).filter((v) => v.steam_id !== u.steam_id);
              if (!others.length) continue;
              const avg = others.reduce((a, v) => a + v.score, 0) / others.length;
              if (!byGenre.has(g.genre)) byGenre.set(g.genre, []);
              byGenre.get(g.genre).push(mine - avg);
            }
            let worst = null;
            for (const [genre, diffs] of byGenre) {
              if (diffs.length < MIN_GENRE) continue;
              const d = diffs.reduce((a, b) => a + b, 0) / diffs.length;
              if (!worst || Math.abs(d) > Math.abs(worst.diff)) worst = { genre, diff: r2(d), n: diffs.length };
            }
            if (worst) offbeat.push({ name: u.short_name, ...worst });
          }
          offbeat.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
          const skipCount = new Map();
          for (const sk of q(`SELECT s.game_id FROM skips s JOIN games g ON g.id=s.game_id
                               WHERE g.group_id=? AND g.archived_at IS NULL`, gid)) {
            skipCount.set(sk.game_id, (skipCount.get(sk.game_id) || 0) + 1);
          }
          const shrugged = L.games
            .map((g) => ({ id: g.id, name: g.name, skips: skipCount.get(g.id) || 0,
                           votes: (L.byGame.get(g.id) || []).length }))
            .filter((g) => g.skips >= 2 && g.votes === 0)
            .sort((a, b) => b.skips - a.skips).slice(0, 8);
          return {
            pairs, contrarian, offbeat, shrugged,
            tasteTwins: pairs[0] || null,
            tasteOpposites: pairs.length > 1 ? pairs[pairs.length - 1] : null,
          };
        })(),
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
