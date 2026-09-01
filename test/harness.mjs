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
 *   MARKETING=1 node ...             # member fixture with publishable identities
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { calibrate, globalStats, scoreGame, viability } from '../lib/score.js';
import { recommend } from '../lib/recommend.js';
import { classifyCoop } from '../lib/coop.js';
import { buildHistoryItems } from '../lib/history.js';
import { buildLibraryStats, buildPersonalStats, PLAYED_OUTCOMES } from '../lib/stats.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.join(here, '..');
const PUBLIC = path.join(SITE, 'public');
const SCENARIO = process.env.SCENARIO || 'member';
const MARKETING = process.env.MARKETING === '1';
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

/* Two library titles are spelled differently from their catalogue rows ("Dark &
   Darker" vs "Dark and Darker"), so the name-matching link above misses them. Join
   them by appid instead — otherwise the Early Access label has nothing to mark
   locally, since it comes from the catalogue's tags through that join. */
for (const [lib, cat] of [['Dark & Darker', 'Dark and Darker'],
                          ['No Rest For The Wicked', 'No Rest for the Wicked']]) {
  // db.prepare directly: the `one` helper is declared further down and is still in
  // its temporal dead zone up here.
  const row = db.prepare('SELECT appid FROM coop_apps WHERE name=?').get(cat);
  if (!row) continue;
  const taken = db.prepare('SELECT 1 AS x FROM games WHERE group_id=1 AND steam_appid=?').get(row.appid);
  if (!taken) db.prepare('UPDATE games SET steam_appid=? WHERE group_id=1 AND name=?').run(row.appid, lib);
}

// The legacy spreadsheet predates Steam links for many backlog rows. Keep the
// normal harness faithful to that fixture, but give the first marketing viewport
// a small verified mapping so it does not repeat the generic fallback banner.
// These are public Steam app ids; no production membership or activity data is
// copied into the repository.
if (MARKETING) {
  const marketingApps = [
    ['Dune Awakening', 1172710],
    ['Keep Talking and Nobody Explodes', 341800],
    ['Dark Souls 3', 374320],
    ['Back 4 Blood', 924970],
    ['Last Epoch', 899770],
    ['Pico Park 2', 2644470],
    ['Lovers in a Dangerous Spacetime', 252110],
    ['V-Rising', 1604030],
    ['Overcooked', 448510],
    ['Tribes of Midgard', 858820],
    ['Dungeon Defenders', 65800],
    ['Sea of Thieves', 1172620],
    ['Sea of Thieves: Monkey Island', 31170],
    ['Peak', 3527290],
  ];
  const link = db.prepare('UPDATE games SET steam_appid=? WHERE group_id=1 AND name=?');
  for (const [name, appid] of marketingApps) link.run(appid, name);
}

if (MARKETING) {
  // The generic Terraria banner keeps every unlinked legacy row visually
  // testable. For captures, most linked rows can use Steam's legacy public
  // /apps/<appid>/header.jpg path and show recognisable art without a fixture blob.
  db.exec(`UPDATE games
              SET header_image = 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/'
                               || steam_appid || '/header.jpg'
            WHERE group_id=1 AND steam_appid IS NOT NULL`);
  // Newer Steam assets can use a content-hashed directory instead of the legacy
  // /apps/<appid>/header.jpg shape. Keep the exact cached public URL for the one
  // such title visible in the Library capture.
  db.prepare('UPDATE games SET header_image=? WHERE group_id=1 AND name=?').run(
    'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/3527290/31bac6b2eccf09b368f5e95ce510bae2baf3cfcd/header.jpg',
    'Peak',
  );
  // PEAK is the first unrated played game in the marketing fixture. The generic
  // test trailer and copy above belong to Back 4 Blood; leaving them attached
  // makes the Rate screenshot contradict its own title. Prefer matching static
  // art and concise fixture copy over a misleading video frame.
  db.prepare(`UPDATE games SET trailer_url=NULL, short_description=?
               WHERE group_id=1 AND name='Peak'`).run(
    'Climb a mysterious mountain with friends, helping each other through a route where one mistake can send the whole expedition downhill.',
  );
}

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
  // Genuinely Early Access, so the "Early access" label has something to mark.
  ['Dark and Darker', ['Early Access', 'Dungeon Crawler', 'Multiplayer', 'Loot', 'Medieval', 'Extraction Shooter']],
  ['No Rest for the Wicked', ['Early Access', 'Souls-like', 'Online Co-Op', 'Action RPG', 'Hack and Slash', 'Open World']],
];
{
  const stmt = db.prepare('UPDATE coop_apps SET tags = ?, is_coop = ?, tags_at = 1 WHERE name = ? AND tags IS NULL');
  for (const [name, tags] of FIXTURE_TAGS) {
    // Classified by the shipped rule, so Marvel Rivals lands on the PvP side here
    // exactly as it does in production and the co-op filter has something to hide.
    stmt.run(JSON.stringify(tags), classifyCoop(tags) ? 1 : 0, name);
  }
}

/* A few play dates, so the Library's default playing/recent/backlog order is testable
   locally. Spread across months rather than all today, or every row inside a tier
   sorts equal and the secondary ordering proves nothing. */
db.exec(`UPDATE games SET started = date('now', '-' || (id % 20) || ' months')
          WHERE group_id=1 AND id % 3 = 0`);
db.exec(`UPDATE games SET finished_estimated = date('now', '-' || (id % 9) || ' months')
          WHERE group_id=1 AND id % 6 = 0`);
// A deterministic mix of trustworthy prompts and manual-only gaps for the
// Complete our history card. The route still computes the queue from real rows.
db.exec(`UPDATE games SET started=NULL, release_date='2 Feb, 2021'
          WHERE id = (SELECT id FROM games WHERE group_id=1 AND status='finished' ORDER BY id LIMIT 1)`);
db.exec(`UPDATE games SET hours=NULL, hours_estimated=21.5, hours_participants=3
          WHERE id = (SELECT id FROM games WHERE group_id=1 AND status='finished' ORDER BY id LIMIT 1 OFFSET 1)`);
db.exec(`UPDATE games SET finished=NULL, finished_estimated=date('now','-2 months')
          WHERE id = (SELECT id FROM games WHERE group_id=1 AND status='finished' ORDER BY id LIMIT 1 OFFSET 2)`);

/* Imported spreadsheet notes now live in the comment thread under an `import:<group>`
   identity with no membership — mirror migration 019 so the local thread shows what
   production shows, including the display-name fallback for a non-member author. */
db.exec(`INSERT OR IGNORE INTO users (steam_id, display_name)
         SELECT DISTINCT 'import:' || group_id, 'Imported from the spreadsheet'
           FROM games WHERE notes IS NOT NULL AND TRIM(notes) <> ''`);
db.exec(`INSERT INTO comments (group_id, game_id, steam_id, body, created_at)
         SELECT group_id, id, 'import:' || group_id, TRIM(notes), COALESCE(created_at, unixepoch())
           FROM games WHERE notes IS NOT NULL AND TRIM(notes) <> ''`);

// Attribution and the "failed to finish" status need a row each to be visible.
db.exec(`UPDATE games SET added_by='${ME}'
          WHERE id IN (SELECT id FROM games WHERE group_id=1 ORDER BY id LIMIT 3)`);
db.exec(`UPDATE games SET status='unfinished'
          WHERE id IN (SELECT id FROM games WHERE group_id=1 AND status='finished'
                        ORDER BY id LIMIT 2)`);

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
db.exec(`INSERT INTO group_library_sync (group_id, steam_id, games, played, synced_at) VALUES
  (1,'${ME}',122,98,unixepoch()), (1,'${LEO_ACCOUNT}',455,0,unixepoch())`);

/* The reported case, made visible locally: backlog games the GROUP has never
   played that somebody has already played alone. Without this the replay question
   has no evidence to trigger on in the co-op fixture, since no seeded game carries
   a Steam appid. The appids are synthetic — the harness never calls Steam. */
db.exec(`UPDATE games SET steam_appid=990043 WHERE id=43 AND group_id=1`);   // Dune Awakening
db.exec(`UPDATE games SET steam_appid=990077 WHERE id=77 AND group_id=1`);   // Baldurs Gate 3
db.exec(`INSERT OR REPLACE INTO playtime (steam_id, appid, minutes, fetched_at) VALUES
  ('${ME}',990043,4200,unixepoch()),
  ('seed:1:pat',990077,9000,unixepoch())`);
// One answer already given, so Play next has both chips to render.
db.exec(`INSERT INTO ratings (game_id, steam_id, score, replay) VALUES (77,'seed:1:pat',9,'no')
         ON CONFLICT(game_id, steam_id) DO UPDATE SET replay='no'`);

/* Seeded games carry no price — enrichment writes it in production — so the budget
   filter would have nothing to filter locally. A deterministic spread in Steam's
   own `cc=de` format, including a free game and a seventh left unpriced so the
   "no price on file" path is visible too. */
db.exec(`UPDATE games SET price = CASE id % 7
           WHEN 0 THEN '59,99€' WHEN 1 THEN '39,99€' WHEN 2 THEN '29,99€'
           WHEN 3 THEN '19,99€' WHEN 4 THEN '9,99€'  WHEN 5 THEN 'Free'
           ELSE NULL END
         WHERE group_id=1 AND price IS NULL`);
if (SCENARIO === 'member') {
  // Ama has already claimed their imported identity.
  db.exec(`INSERT INTO memberships (group_id, steam_id, short_name, role) VALUES (1,'${ME}','Ama','owner')`);
  db.exec(`UPDATE ratings SET steam_id='${ME}' WHERE steam_id='seed:1:ama'`);
  db.exec(`DELETE FROM memberships WHERE steam_id='seed:1:ama'`);
  db.exec(`DELETE FROM users WHERE steam_id='seed:1:ama'`);
} else if (SCENARIO === 'claim') {
  db.exec(`INSERT INTO memberships (group_id, steam_id, short_name, role) VALUES (1,'${ME}','Amadeus','owner')`);
}

// Screenshots use the real group's games, statuses and ratings but never publish
// its member identities. This mode is local-only and changes presentation data,
// not the fixture's relationships or score calculations.
if (MARKETING && SCENARIO === 'member') {
  db.exec(`UPDATE groups SET name='Friday Night Crew' WHERE id=1;
           UPDATE users SET display_name='Alex' WHERE steam_id='${ME}';
           UPDATE memberships SET short_name=CASE steam_id
             WHEN '${ME}' THEN 'Alex'
             WHEN 'seed:1:dave' THEN 'Jamie'
             WHEN 'seed:1:leo' THEN 'Robin'
             WHEN 'seed:1:pat' THEN 'Sam'
             ELSE short_name END
           WHERE group_id=1`);
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

  // A real personal workspace beside the co-op fixtures, so every view can be
  // checked in both modes without pretending that "one current member" implies
  // personal intent.
  db.exec(`INSERT INTO groups (id, slug, name, invite_code, max_players)
           VALUES (3,'my-games','My games',NULL,1)`);
  db.exec(`INSERT INTO workspace_settings (group_id, mode) VALUES (3,'personal')`);
  db.exec(`INSERT INTO memberships (group_id, steam_id, short_name, role) VALUES
           (3,'${ME}','Amadeus','owner')`);
  db.exec(`INSERT INTO games
           (id, group_id, name, steam_appid, genre, status, max_players, header_image, release_date, started, finished)
           VALUES
           (910,3,'Stardew Valley',413150,'Simulation','finished',4,NULL,'26 Feb, 2016','2022-03-01','2023-01-15'),
           (911,3,'Portal 2',620,'Puzzle','finished',2,NULL,'19 Apr, 2011','2017-04-01','2017-04-20'),
           (912,3,'Valheim',892970,'Survival','backlog',10,NULL,'2 Feb, 2021',NULL,NULL)`);
  db.exec(`INSERT INTO ratings (game_id, steam_id, score) VALUES
           (910,'${ME}',9.5),(911,'${ME}',9),(912,'${ME}',8.5)`);
  db.exec(`INSERT OR REPLACE INTO playtime (steam_id, appid, minutes, last_played, fetched_at) VALUES
           ('${ME}',413150,7200,1673740800,unixepoch()),
           ('${ME}',620,840,1492646400,unixepoch()),
           ('${ME}',892970,0,NULL,unixepoch())`);
  db.exec(`INSERT OR REPLACE INTO achievement_progress
           (steam_id,appid,achieved,total,unlocked,fetched_at) VALUES
           ('${ME}',413150,28,40,'[{"key":"farm","name":"A Complete Collection","unlocktime":1673654400}]',unixepoch()),
           ('${ME}',620,31,51,'[{"key":"wake","name":"Wake Up Call","unlocktime":1492560000}]',unixepoch())`);
}

const q = (sql, ...a) => db.prepare(sql).all(...a);
const one = (sql, ...a) => db.prepare(sql).get(...a);
let freshCreated = false;
const send = (res, code, data) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
};
const readBody = async (req) => { let b = ''; for await (const c of req) b += c; return b ? JSON.parse(b) : {}; };

function groupCtx(slug) {
  return one(
    `SELECT g.id AS group_id, g.slug, g.name, g.invite_code, g.max_players, g.blind_rating,
            COALESCE(w.mode,'coop') AS workspace_mode,
            m.short_name, m.role, COALESCE(p.history_prompts,0) AS history_prompts
       FROM groups g LEFT JOIN workspace_settings w ON w.group_id=g.id
       JOIN memberships m ON m.group_id=g.id AND m.steam_id=?
       LEFT JOIN member_preferences p ON p.group_id=m.group_id AND p.steam_id=m.steam_id
      WHERE g.slug=?`, ME, slug);
}

function libraryFor(gid, need) {
  // Mirrors the real handler's LEFT JOIN onto the catalogue for Steam's verdict.
  const games = q(
    `SELECT g.*, c.review_hint AS steam_review_hint, c.review_count AS steam_review_count,
            CASE WHEN c.tags LIKE '%"Early Access"%' THEN 1 ELSE 0 END AS early_access
       FROM games g LEFT JOIN coop_apps c ON c.appid = g.steam_appid
      WHERE g.group_id=? ORDER BY g.name COLLATE NOCASE`, gid);
  const ratings = q(
    'SELECT r.game_id, r.steam_id, r.score, r.comment, r.replay FROM ratings r JOIN games g ON g.id=r.game_id WHERE g.group_id=?', gid);
  const members = q(
    `SELECT m.steam_id, m.short_name, m.is_seed, u.avatar, u.display_name
       FROM memberships m JOIN users u ON u.steam_id=m.steam_id
      WHERE m.group_id=? ORDER BY m.short_name COLLATE NOCASE`, gid);
  const ownershipMembers = q(
    `SELECT m.steam_id, m.is_seed, COALESCE(a.steam_id,m.steam_id) AS account,
            s.games AS synced_games, s.synced_at
       FROM memberships m
       LEFT JOIN seed_assignments a ON a.group_id=m.group_id AND a.seed_steam_id=m.steam_id
       LEFT JOIN group_library_sync s
              ON s.group_id=m.group_id AND s.steam_id=COALESCE(a.steam_id,m.steam_id)
      WHERE m.group_id=?`, gid);
  const playRows = q(
    `SELECT p.steam_id, p.appid, p.minutes FROM playtime p
       JOIN games g ON g.steam_appid=p.appid AND g.group_id=?`, gid);
  const owned = new Set(playRows.map((row) => `${row.steam_id}:${row.appid}`));
  // An hour, the same floor lib/ownership.js uses. See PLAYED_MINUTES there.
  const playedApps = new Set(playRows.filter((row) => Number(row.minutes) >= 60)
    .map((row) => `${row.steam_id}:${row.appid}`));
  const factSources = new Map();
  for (const source of q(
    `SELECT f.game_id, f.field, f.source, f.set_by, f.updated_at,
            COALESCE(m.short_name,u.display_name) AS set_by_name
       FROM game_fact_sources f
       LEFT JOIN memberships m ON m.group_id=f.group_id AND m.steam_id=f.set_by
       LEFT JOIN users u ON u.steam_id=f.set_by
      WHERE f.group_id=?`, gid)) {
    if (!factSources.has(source.game_id)) factSources.set(source.game_id, {});
    factSources.get(source.game_id)[source.field] = {
      source: source.source, setBy: source.set_by,
      setByName: source.set_by_name, updatedAt: source.updated_at,
    };
  }
  const cal = calibrate(ratings), glob = globalStats(ratings);
  const byGame = new Map();
  for (const r of ratings) { if (!byGame.has(r.game_id)) byGame.set(r.game_id, []); byGame.get(r.game_id).push(r); }
  const satOut = new Map();
  const mySkips = new Map();
  for (const s2 of q(`SELECT s.game_id, s.steam_id, s.not_played FROM skips s
                        JOIN games g ON g.id=s.game_id WHERE g.group_id=?`, gid)) {
    if (s2.not_played) {
      if (!satOut.has(s2.game_id)) satOut.set(s2.game_id, []);
      satOut.get(s2.game_id).push(s2.steam_id);
    }
    if (s2.steam_id === ME) mySkips.set(s2.game_id, s2.not_played ? 'not-played' : 'no-opinion');
  }
  return {
    ratings, cal, glob, members, byGame,
    games: games.map((g) => {
      const votes = byGame.get(g.id) || [];
      const ownership = Object.fromEntries(ownershipMembers.map((member) => {
        if (!g.steam_appid) return [member.steam_id, null];
        if (owned.has(`${member.account}:${g.steam_appid}`)) return [member.steam_id, true];
        const unresolved = !!member.is_seed && member.account === member.steam_id;
        const fresh = !unresolved && member.synced_games > 0
          && member.synced_at >= (g.enriched_at ?? g.created_at);
        return [member.steam_id, fresh ? false : null];
      }));
      const playedBy = g.steam_appid
        ? ownershipMembers.filter((m) => playedApps.has(`${m.account}:${g.steam_appid}`))
            .map((m) => m.steam_id)
        : [];
      return { ...g, votes: Object.fromEntries(votes.map((v) => [v.steam_id, v.score])),
               comments: [], ...scoreGame(votes), notPlayed: satOut.get(g.id) || [],
               mySkip: mySkips.get(g.id) || null, factSources: factSources.get(g.id) || {},
               replay: Object.fromEntries(votes.filter((v) => v.replay).map((v) => [v.steam_id, v.replay])),
               playedBy, ownership, viability: viability(g, need) };
    }),
  };
}

function historyFor(gid, includeNudges = true, mode = 'coop') {
  const games = q(
    `SELECT g.id, g.name, g.status, g.header_image, g.steam_appid, g.release_date,
            g.started, g.hours, g.hours_estimated, g.hours_participants,
            g.finished, g.finished_estimated, g.archived_at,
            r.score AS my_rating, p.minutes AS my_minutes,
            CASE WHEN g.added_by=?2 THEN 1 ELSE 0 END AS i_added,
            COALESCE(s.not_played,0) AS sat_out
       FROM games g
       LEFT JOIN ratings r ON r.game_id=g.id AND r.steam_id=?2
       LEFT JOIN playtime p ON p.appid=g.steam_appid AND p.steam_id=?2
       LEFT JOIN skips s ON s.game_id=g.id AND s.steam_id=?2
      WHERE g.group_id=?1 AND g.archived_at IS NULL AND g.status<>'backlog'`, gid, ME);
  const achievements = q(
    `WITH accounts(steam_id) AS (
       SELECT steam_id FROM memberships WHERE group_id=?1 AND is_seed=0
       UNION
       SELECT a.steam_id FROM seed_assignments a JOIN memberships m
         ON m.group_id=a.group_id AND m.steam_id=a.seed_steam_id WHERE a.group_id=?1
     )
     SELECT p.appid,p.unlocked FROM achievement_progress p
       JOIN accounts a ON a.steam_id=p.steam_id
       JOIN games g ON g.steam_appid=p.appid AND g.group_id=?1
      WHERE g.archived_at IS NULL`, gid);
  const nudges = includeNudges ? q(
    'SELECT game_id,field,state,snoozed_until FROM history_nudges WHERE group_id=? AND steam_id=?',
    gid, ME) : [];
  const items = buildHistoryItems(games, achievements, nudges, Date.now(), { mode });
  return { total: items.length, items: items.slice(0, 20) };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (SCENARIO === 'anon' && p.startsWith('/api/') && !p.startsWith('/api/auth')) {
    return send(res, 401, { error: 'not signed in' });
  }

  if (p === '/api/me' && req.method === 'PATCH') {
    const b = await readBody(req);
    if (!('defaultGroup' in b)) return send(res, 400, { error: 'nothing to change' });
    if (b.defaultGroup == null) {
      db.prepare('UPDATE member_preferences SET default_workspace=0 WHERE steam_id=?').run(ME);
      return send(res, 200, { ok: true, defaultGroup: null });
    }
    const group = one(
      'SELECT g.id FROM groups g JOIN memberships m ON m.group_id=g.id AND m.steam_id=? WHERE g.slug=?',
      ME, String(b.defaultGroup));
    if (!group) return send(res, 404, { error: 'no such workspace' });
    // Clear before set, exactly like the route: one default row per account.
    db.prepare('UPDATE member_preferences SET default_workspace=0 WHERE steam_id=? AND group_id<>?')
      .run(ME, group.id);
    db.prepare(`INSERT INTO member_preferences (group_id,steam_id,default_workspace) VALUES (?,?,1)
                ON CONFLICT(group_id,steam_id) DO UPDATE SET default_workspace=1`).run(group.id, ME);
    return send(res, 200, { ok: true, defaultGroup: String(b.defaultGroup) });
  }

  if (p === '/api/me') {
    const groups = q(
      `SELECT g.slug, g.name, m.role, m.short_name, COALESCE(w.mode,'coop') AS mode,
              COALESCE(pr.default_workspace,0) AS is_default,
              (SELECT COUNT(*) FROM memberships mm WHERE mm.group_id=g.id) AS members,
              (SELECT COUNT(*) FROM games gg WHERE gg.group_id=g.id) AS games,
              (SELECT COUNT(*) FROM games gg WHERE gg.group_id=g.id
                 AND NOT EXISTS (SELECT 1 FROM ratings r WHERE r.game_id=gg.id AND r.steam_id=?1)
                 AND NOT EXISTS (SELECT 1 FROM skips s WHERE s.game_id=gg.id AND s.steam_id=?1)) AS unrated
         FROM groups g LEFT JOIN workspace_settings w ON w.group_id=g.id
         JOIN memberships m ON m.group_id=g.id
         LEFT JOIN member_preferences pr ON pr.group_id=m.group_id AND pr.steam_id=m.steam_id
        WHERE m.steam_id=?1 ORDER BY g.name COLLATE NOCASE`, ME);
    return send(res, 200, {
      user: { steamId: ME, displayName: 'Amadeus', avatar: null },
      groups: SCENARIO === 'fresh' && !freshCreated ? [] : groups,
      invites: q(
        `SELECT i.id,g.name AS groupName,u.display_name AS inviterName,u.avatar AS inviterAvatar,
                i.created_at AS createdAt
           FROM group_invites i JOIN groups g ON g.id=i.group_id
           JOIN users u ON u.steam_id=i.invited_by
          WHERE i.invited_steam_id=? AND i.status='pending'`, ME),
    });
  }

  if (p === '/api/invites' && req.method === 'GET') {
    return send(res, 200, { invites: q(
      `SELECT i.id,g.name AS groupName,u.display_name AS inviterName,u.avatar AS inviterAvatar,
              i.created_at AS createdAt
         FROM group_invites i JOIN groups g ON g.id=i.group_id
         JOIN users u ON u.steam_id=i.invited_by
        WHERE i.invited_steam_id=? AND i.status='pending'`, ME),
    });
  }
  if (p === '/api/invites' && req.method === 'POST') {
    const b = await readBody(req);
    const invite = one(
      `SELECT i.*,g.slug,g.name FROM group_invites i JOIN groups g ON g.id=i.group_id
        WHERE i.id=? AND i.invited_steam_id=? AND i.status='pending'`, Number(b.id), ME);
    if (!invite) return send(res, 404, { error: 'that invitation is no longer available' });
    if (b.action === 'reject') {
      db.prepare("UPDATE group_invites SET status='rejected',responded_at=unixepoch() WHERE id=?").run(invite.id);
      return send(res, 200, { ok: true, action: 'reject' });
    }
    db.prepare("INSERT OR IGNORE INTO memberships (group_id,steam_id,short_name,role) VALUES (?,?,?,'member')")
      .run(invite.group_id, ME, 'Amadeus');
    db.prepare("UPDATE group_invites SET status='accepted',responded_at=unixepoch() WHERE id=?").run(invite.id);
    return send(res, 200, { ok: true, action: 'accept', slug: invite.slug, name: invite.name });
  }

  if (p === '/api/groups' && req.method === 'POST') {
    const b = await readBody(req);
    const name = String(b.name || '').trim().slice(0, 60);
    const mode = b.mode === 'personal' ? 'personal' : 'coop';
    if (name.length < 2) return send(res, 400, { error: 'give the workspace a name' });
    const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'workspace'}-local`;
    db.prepare('INSERT INTO groups (slug,name,invite_code,max_players,created_by) VALUES (?,?,?,?,?)')
      .run(slug, name, mode === 'personal' ? null : 'LOCALCODE99', mode === 'personal' ? 1 : Number(b.maxPlayers) || 4, ME);
    const gid = one('SELECT id FROM groups WHERE slug=?', slug).id;
    db.prepare("INSERT INTO memberships (group_id,steam_id,short_name,role) VALUES (?,?,?,'owner')")
      .run(gid, ME, 'Amadeus');
    db.prepare('INSERT INTO workspace_settings (group_id,mode) VALUES (?,?)').run(gid, mode);
    freshCreated = true;
    return send(res, 201, { ok: true, slug, name, mode });
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
      rank: (a, b) => (b.review_count ?? -1) - (a.review_count ?? -1),
      name: (a, b) => a.name.localeCompare(b.name),
      new:  (a, b) => (b.release_ts ?? -1) - (a.release_ts ?? -1),
    }[sort] || ((a, b) => (b.review_count ?? -1) - (a.review_count ?? -1)));

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
                     WHERE name LIKE ? ORDER BY review_count DESC LIMIT 8`, `%${term}%`);
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
                 blindRating: !!ctx.blind_rating, mode: ctx.workspace_mode,
                 historyPrompts: !!ctx.history_prompts },
        model: { mean: +L.glob.mean.toFixed(2), sd: +L.glob.sd.toFixed(2) },
      });
    }
    if (sub === '/history' && req.method === 'GET') {
      // Screenshot mode is for the public product tour. Keep the realistic
      // library rows, but omit a member-specific housekeeping prompt from the
      // clean Library composition shown on the landing page and in the README.
      if (MARKETING) return send(res, 200, { total: 0, items: [] });
      return send(res, 200, historyFor(gid, true, ctx.workspace_mode));
    }
    if (sub === '/history' && req.method === 'POST') {
      const b = await readBody(req);
      const gameId = Number(b.gameId);
      const field = String(b.field || '');
      const action = String(b.action || '');
      const column = { started: 'started', finished: 'finished', hours: 'hours' }[field];
      if (!Number.isInteger(gameId) || !column) return send(res, 400, { error: 'bad history field' });
      if (!one('SELECT 1 AS x FROM games WHERE id=? AND group_id=?', gameId, gid)) {
        return send(res, 404, { error: 'no such game' });
      }
      const item = historyFor(gid, false, ctx.workspace_mode).items
        .find((candidate) => candidate.gameId === gameId && candidate.field === field);
      if (!item) return send(res, 409, { error: 'that history field no longer needs a prompt' });
      if (action === 'dismiss' || action === 'snooze') {
        const until = action === 'snooze' ? Math.floor(Date.now() / 1000) + 7 * 86400 : null;
        db.prepare(`INSERT INTO history_nudges
          (group_id,game_id,field,steam_id,state,snoozed_until,updated_at)
          VALUES (?,?,?,?,?,?,unixepoch())
          ON CONFLICT(group_id,game_id,field,steam_id) DO UPDATE SET
            state=excluded.state,snoozed_until=excluded.snoozed_until,updated_at=unixepoch()`)
          .run(gid, gameId, field, ME, action === 'snooze' ? 'snoozed' : 'dismissed', until);
        return send(res, 200, { ok: true, action });
      }
      if (action !== 'accept') return send(res, 400, { error: 'bad history action' });
      if (!item.suggestion) return send(res, 409, { error: 'there is no automatic suggestion' });
      db.prepare(`UPDATE games SET ${column}=? WHERE id=? AND group_id=? AND ${column} IS NULL`)
        .run(item.suggestion.value, gameId, gid);
      db.prepare(`INSERT INTO game_fact_sources (group_id,game_id,field,source,set_by,updated_at)
                  VALUES (?,?,?,?,?,unixepoch())
                  ON CONFLICT(group_id,game_id,field) DO UPDATE SET
                    source=excluded.source,set_by=excluded.set_by,updated_at=unixepoch()`)
        .run(gid, gameId, field, item.suggestion.source, ME);
      db.prepare('DELETE FROM history_nudges WHERE group_id=? AND game_id=? AND field=?')
        .run(gid, gameId, field);
      return send(res, 200, { ok: true, action: 'accept' });
    }
    if (sub === '/playtime' && req.method === 'GET') {
      const rows = q(`SELECT m.steam_id, m.short_name, m.is_seed,
                             COALESCE(a.steam_id, m.steam_id) AS account,
                             s.games, s.played, s.synced_at
                        FROM memberships m
                        LEFT JOIN seed_assignments a
                               ON a.group_id=m.group_id AND a.seed_steam_id=m.steam_id
                        LEFT JOIN group_library_sync s
                               ON s.group_id=m.group_id AND s.steam_id=COALESCE(a.steam_id, m.steam_id)
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
    if (sub === '/invites' && req.method === 'GET') {
      if (ctx.role !== 'owner') return send(res, 403, { error: 'only the group owner can invite people' });
      const term = (url.searchParams.get('q') || '').trim().toLowerCase();
      const pending = q(
        `SELECT i.id,i.invited_steam_id AS steamId,u.display_name AS displayName,u.avatar,
                i.created_at AS createdAt
           FROM group_invites i JOIN users u ON u.steam_id=i.invited_steam_id
          WHERE i.group_id=? AND i.status='pending'`, gid);
      const results = term.length < 2 ? [] : q(
        `SELECT u.steam_id AS steamId,u.display_name AS displayName,u.avatar
           FROM users u WHERE u.steam_id<>?
             AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.group_id=? AND m.steam_id=u.steam_id)
             AND (LOWER(u.display_name) LIKE ? OR u.steam_id LIKE ?) LIMIT 12`,
        ME, gid, `%${term}%`, `%${term}%`).map((player) => ({
          ...player, pending: pending.some((invite) => invite.steamId === player.steamId),
        }));
      return send(res, 200, { pending, results });
    }
    if (sub === '/invites' && req.method === 'POST') {
      if (ctx.role !== 'owner') return send(res, 403, { error: 'only the group owner can invite people' });
      const b = await readBody(req);
      if (!one('SELECT 1 AS x FROM users WHERE steam_id=?', String(b.steamId))) {
        return send(res, 404, { error: 'that player has not signed in yet' });
      }
      db.prepare(`INSERT INTO group_invites (group_id,invited_steam_id,invited_by,status)
                  VALUES (?,?,?,'pending')
                  ON CONFLICT(group_id,invited_steam_id) DO UPDATE SET status='pending',
                    invited_by=excluded.invited_by,created_at=unixepoch(),responded_at=NULL`)
        .run(gid, String(b.steamId), ME);
      return send(res, 201, { ok: true });
    }
    if (sub === '/invites' && req.method === 'DELETE') {
      if (ctx.role !== 'owner') return send(res, 403, { error: 'only the group owner can invite people' });
      const b = await readBody(req);
      db.prepare("UPDATE group_invites SET status='cancelled',responded_at=unixepoch() WHERE id=? AND group_id=?")
        .run(Number(b.id), gid);
      return send(res, 200, { ok: true });
    }
    if (sub === '/steam-import' && req.method === 'POST') {
      const b = await readBody(req);
      if (b.action === 'enrich') return send(res, 200, { processed: 0, enriched: 0, remaining: 0 });
      const samples = [
        { appid: 1145360, name: 'Hades', hours: 42.3, lastPlayed: '2024-06-18', played: true,
          owned: true, wishlisted: false, wishlistedAt: null, image: null, gameType: 'solo' },
        { appid: 504230, name: 'Celeste', hours: 8.7, lastPlayed: '2021-02-11', played: true,
          owned: true, wishlisted: false, wishlistedAt: null, image: null, gameType: 'solo' },
        { appid: 2379780, name: 'Balatro', hours: 0, lastPlayed: null, played: false,
          owned: false, wishlisted: true, wishlistedAt: '2025-03-14', image: null, gameType: 'solo' },
        { appid: 1868140, name: 'DREDGE', hours: 0, lastPlayed: null, played: false,
          owned: true, wishlisted: false, wishlistedAt: null, image: null, gameType: 'solo' },
        { appid: 1497440, name: 'COCOON', hours: 0, lastPlayed: null, played: false,
          owned: false, wishlisted: true, wishlistedAt: '2025-01-03', image: null, gameType: 'solo' },
        { appid: 646570, name: 'Slay the Spire', hours: 0, lastPlayed: null, played: false,
          owned: false, wishlisted: true, wishlistedAt: '2024-11-27', image: null, gameType: 'solo' },
        { appid: 548430, name: 'Deep Rock Galactic', hours: 18.2, lastPlayed: '2025-04-08', played: true,
          owned: true, wishlisted: false, wishlistedAt: null, image: null, gameType: 'coop' },
        { appid: 1172470, name: 'Apex Legends', hours: 6.4, lastPlayed: '2023-09-02', played: true,
          owned: true, wishlisted: false, wishlistedAt: null, image: null, gameType: 'multiplayer' },
      ];
      const missing = samples.filter((game) =>
        !one('SELECT 1 AS x FROM games WHERE group_id=? AND steam_appid=?', gid, game.appid));
      const source = ['owned', 'wishlist'].includes(b.source) ? b.source : 'all';
      const requestedTypes = Array.isArray(b.gameTypes)
        ? new Set(b.gameTypes) : new Set(ctx.workspace_mode === 'personal'
          ? ['coop', 'multiplayer', 'solo'] : ['coop']);
      const visible = missing.filter((game) => {
        const ownedVisible = game.owned && (b.includeUnplayed || game.played);
        if (!requestedTypes.has(game.gameType)) return false;
        if (source === 'owned') return ownedVisible;
        if (source === 'wishlist') return game.wishlisted;
        return game.wishlisted || ownedVisible;
      });
      if (b.action === 'preview') {
        // Two rows makes the real pagination behaviour easy to exercise in the
        // browser harness: load-more rows and a multi-page wishlist both exist.
        const offset = Math.max(0, Math.floor(Number(b.offset) || 0));
        const items = visible.slice(offset, offset + 2);
        return send(res, 200, {
          items, offset, nextOffset: offset + items.length,
          hasMore: offset + items.length < visible.length,
          counts: { owned: 3, wishlisted: 3,
            tracked: q('SELECT id FROM games WHERE group_id=?', gid).length,
            missingTotal: missing.length,
            missingOwned: missing.filter((game) => game.owned).length,
            missingWishlist: missing.filter((game) => game.wishlisted).length,
            matching: visible.length, playtimeReadable: true,
            types: Object.fromEntries(['coop', 'multiplayer', 'solo'].map((type) => [
              type, missing.filter((game) => game.gameType === type).length,
            ])),
            ownedState: 'available', wishlistState: 'available' },
        });
      }
      const appids = new Set((b.appids || []).map(Number));
      const selected = missing.filter((game) => appids.has(game.appid));
      for (const game of selected) {
        db.prepare(`INSERT OR IGNORE INTO games
          (group_id,name,steam_appid,status,hours,finished,added_by,enriched_at)
          VALUES (?,?,?,?,?,?,?,unixepoch())`)
          .run(gid, game.name, game.appid, game.played ? 'sampled' : 'backlog',
            game.played ? game.hours : null, game.played ? game.lastPlayed : null, ME);
      }
      return send(res, 201, { imported: selected.length,
        importedOwned: selected.filter((game) => game.owned).length,
        importedWishlist: selected.filter((game) => game.wishlisted).length,
        importedPlayed: selected.filter((game) => game.played).length,
        names: selected.map((game) => game.name), metadataRemaining: 0 });
    }
    if (sub === '/achievement-scan' && req.method === 'POST') {
      if (ctx.workspace_mode !== 'personal') return send(res, 409, { error: 'personal workspaces only' });
      return send(res, 200, { processed: 0, synced: 0, report: [], nextCursor: 0, hasMore: false });
    }
    if (sub === '/play-night' && req.method === 'POST') {
      const b = await readBody(req);
      const attendees = Array.isArray(b.attendees) ? [...new Set(b.attendees.map(String))] : [];
      const memberIds = new Set(q('SELECT steam_id FROM memberships WHERE group_id=?', gid).map((m) => m.steam_id));
      if (attendees.length < 1 || attendees.some((id) => !memberIds.has(id))) {
        return send(res, 400, { error: 'select at least one member of this workspace' });
      }
      const L = libraryFor(gid, attendees.length);
      const excluded = { earlyAccess: 0, tooFewPlayers: 0, noAttendeeRatings: 0 };
      const games = [];
      for (const g of L.games.filter((game) => !game.archived_at && game.status === 'backlog')) {
        if (b.excludeEarlyAccess !== false && g.early_access) { excluded.earlyAccess++; continue; }
        const fit = viability(g, attendees.length);
        if (fit.ok === false) { excluded.tooFewPlayers++; continue; }
        const votes = attendees.map((id) => g.votes[id]).filter((score) => score != null);
        if (!votes.length) { excluded.noAttendeeRatings++; continue; }
        games.push({ id: g.id, score: votes.reduce((a, n) => a + n, 0) / votes.length,
          votes: votes.length, playerCountVerified: fit.ok != null });
      }
      games.sort((a, b2) => b2.score - a.score || b2.votes - a.votes);
      return send(res, 200, { games, attendees, excluded });
    }

    if (sub.startsWith('/achievements')) {
      const id = req.method === 'GET'
        ? Number(url.searchParams.get('gameId')) : Number((await readBody(req)).gameId);
      const game = one('SELECT id, steam_appid FROM games WHERE id=? AND group_id=?', id, gid);
      if (!game) return send(res, 404, { error: 'no such game' });
      if (!game.steam_appid) return send(res, 200, { supported: false, members: [] });
      if (req.method === 'POST') {
        db.prepare(`INSERT INTO achievement_progress
          (steam_id,appid,achieved,total,unlocked,fetched_at) VALUES (?,?,2,5,?,unixepoch())
          ON CONFLICT(steam_id,appid) DO UPDATE SET
            achieved=2,total=5,unlocked=excluded.unlocked,fetched_at=unixepoch()`)
          .run(ME, game.steam_appid, JSON.stringify([
            { key: 'first', name: 'First steps', unlocktime: Math.floor(Date.now() / 1000) - 86400 },
            { key: 'secret', name: 'A good start', unlocktime: Math.floor(Date.now() / 1000) - 3600 },
          ]));
      }
      const members = q(`SELECT m.steam_id, m.short_name, m.is_seed,
                                COALESCE(a.steam_id,m.steam_id) AS account,
                                p.achieved,p.total,p.unlocked,p.fetched_at
                           FROM memberships m LEFT JOIN seed_assignments a
                             ON a.group_id=m.group_id AND a.seed_steam_id=m.steam_id
                           LEFT JOIN achievement_progress p
                             ON p.steam_id=COALESCE(a.steam_id,m.steam_id) AND p.appid=?
                          WHERE m.group_id=? ORDER BY m.short_name`, game.steam_appid, gid)
        .map((m) => ({ steamId: m.steam_id, name: m.short_name,
          account: !(m.is_seed && m.account === m.steam_id),
          achieved: m.achieved ?? null, total: m.total ?? null, fetchedAt: m.fetched_at ?? null,
          unlocked: m.unlocked ? JSON.parse(m.unlocked) : [] }));
      const eligible = members.filter((m) => m.account);
      const synced = eligible.filter((m) => m.total != null);
      const total = Math.max(0, ...synced.map((m) => m.total));
      const unlocked = new Set(synced.flatMap((m) => m.unlocked.map((a) => a.key)));
      const latest = synced.flatMap((m) => m.unlocked.map((a) => ({
        name: a.name, member: m.name, unlocktime: a.unlocktime,
      }))).sort((a, b2) => b2.unlocktime - a.unlocktime).slice(0, 3);
      return send(res, 200, { supported: total > 0,
        members: members.map(({ unlocked: _unlocked, ...member }) => member),
        relay: { unlocked: unlocked.size, total, synced: synced.length, eligible: eligible.length,
          unanimous: null, nearSweep: [], latest } });
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

      const history = q(`SELECT g.steam_appid AS appid, g.name, AVG(r.score) AS score
                           FROM games g JOIN ratings r ON r.game_id=g.id
                          WHERE g.group_id=? AND g.archived_at IS NULL
                            AND g.steam_appid IS NOT NULL GROUP BY g.id`, gid);
      // Both tag homes, like the route: the catalogue covers only games the crawler
      // has listed, and a group rates plenty it has not.
      const tagsFor = new Map();
      for (const r of q(`SELECT g.steam_appid AS appid, COALESCE(c.tags, s.tags) AS tags
                           FROM games g
                           LEFT JOIN coop_apps  c ON c.appid=g.steam_appid
                           LEFT JOIN steam_apps s ON s.appid=g.steam_appid
                          WHERE g.group_id=? AND g.steam_appid IS NOT NULL
                            AND COALESCE(c.tags, s.tags) IS NOT NULL`, gid)) {
        try {
          const t = JSON.parse(r.tags);
          if (Array.isArray(t)) tagsFor.set(r.appid, t);
        } catch { /* ignore a malformed row */ }
      }

      // A discovery list should not spend its best slots on games you already have,
      // but a search is a lookup and must still find them.
      if (!term) {
        const own = new Set(q('SELECT steam_appid AS appid FROM games WHERE group_id=? AND steam_appid IS NOT NULL', gid)
          .map((r) => r.appid));
        rows = rows.filter((g) => !own.has(g.appid));
      }

      const out = recommend(rows, history, tagsFor);
      return send(res, 200, {
        games: out.games.slice(page * PAGE, page * PAGE + PAGE),
        page, total: out.games.length,
        hasMore: out.games.length > page * PAGE + PAGE,
        basis: out.basis, settled: out.settled,
        ratedGames: out.ratedGames, needed: out.needed,
        likes: out.likes, dislikes: out.dislikes,
      });
    }

    // "Not interested" and its undo list. Group-scoped; see migration 034.
    if (sub === '/dismissals' && req.method === 'GET') {
      return send(res, 200, { dismissals: q(
        `SELECT d.appid, d.name, d.created_at AS at, d.steam_id AS bySteamId,
                COALESCE(m.short_name, u.display_name) AS by
           FROM coop_dismissals d
           LEFT JOIN memberships m ON m.group_id=d.group_id AND m.steam_id=d.steam_id
           LEFT JOIN users u ON u.steam_id=d.steam_id
          WHERE d.group_id=? ORDER BY d.created_at DESC, d.appid DESC`, gid) });
    }
    if (sub === '/dismissals' && req.method === 'POST') {
      const b = await readBody(req);
      const appid = Number(b.appid);
      if (!Number.isInteger(appid) || appid <= 0) return send(res, 400, { error: 'bad appid' });
      const known = one('SELECT name FROM coop_apps WHERE appid=?', appid);
      const label = known?.name || String(b.name || '').trim().slice(0, 200);
      if (!label) return send(res, 400, { error: 'no such game in the catalogue' });
      db.prepare(`INSERT INTO coop_dismissals (group_id,appid,name,steam_id) VALUES (?,?,?,?)
                  ON CONFLICT(group_id,appid) DO UPDATE SET name=excluded.name,
                    steam_id=excluded.steam_id, created_at=unixepoch()`).run(gid, appid, label, ME);
      return send(res, 200, { ok: true, appid, name: label });
    }
    if (sub === '/dismissals' && req.method === 'DELETE') {
      const b = await readBody(req);
      db.prepare('DELETE FROM coop_dismissals WHERE group_id=? AND appid=?').run(gid, Number(b.appid));
      return send(res, 200, { ok: true, appid: Number(b.appid) });
    }

    if (sub.startsWith('/comments')) {
      const inGroup = (id) => one('SELECT id FROM games WHERE id=? AND group_id=?', id, gid);
      if (req.method === 'GET') {
        const id = Number(url.searchParams.get('gameId'));
        if (!inGroup(id)) return send(res, 404, { error: 'no such game' });
        const rows = q(`SELECT c.id, c.steam_id, c.body, c.created_at, m.short_name, u.avatar, u.display_name
                          FROM comments c
                          LEFT JOIN memberships m ON m.group_id=c.group_id AND m.steam_id=c.steam_id
                          LEFT JOIN users u ON u.steam_id=c.steam_id
                         WHERE c.game_id=? AND c.group_id=? ORDER BY c.created_at, c.id`, id, gid);
        return send(res, 200, {
          comments: rows.map((c) => ({
            id: c.id, steamId: c.steam_id,
            // Mirrors the real handler: a comment can outlive its author's
            // membership, or belong to the import identity, which has none.
            name: c.short_name || c.display_name || 'Someone who left',
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
      const prior = one('SELECT hours,started,finished FROM games WHERE id=? AND group_id=?', id, gid);
      if (!prior) return send(res, 404, { error: 'no such game' });
      if ('archived' in b) {
        db.prepare('UPDATE games SET archived_at=? WHERE id=? AND group_id=?')
          .run(b.archived ? Math.floor(Date.now() / 1000) : null, id, gid);
      }
      // Mirrors the real handler, membership check included — otherwise the local
      // detail panel appears to save an adder that the deployed site would refuse.
      if ('added_by' in b) {
        const who = b.added_by === '' ? null : b.added_by;
        if (who !== null && !one('SELECT 1 AS x FROM memberships WHERE group_id=? AND steam_id=?', gid, String(who))) {
          return send(res, 400, { error: 'that person is not in this group' });
        }
        db.prepare('UPDATE games SET added_by=? WHERE id=? AND group_id=?').run(who, id, gid);
      }
      for (const k of ['status', 'genre', 'hours', 'started', 'finished',
                       'max_players', 'min_session_minutes', 'name']) {
        if (!(k in b)) continue;
        const value = b[k] === '' ? null : b[k];
        db.prepare(`UPDATE games SET ${k}=? WHERE id=? AND group_id=?`).run(value, id, gid);
        if (!['hours', 'started', 'finished'].includes(k) || prior[k] === value) continue;
        if (value == null) {
          db.prepare('DELETE FROM game_fact_sources WHERE group_id=? AND game_id=? AND field=?')
            .run(gid, id, k);
        } else {
          db.prepare(`INSERT INTO game_fact_sources (group_id,game_id,field,source,set_by,updated_at)
                      VALUES (?,?,?,'manual',?,unixepoch())
                      ON CONFLICT(group_id,game_id,field) DO UPDATE SET
                        source='manual',set_by=excluded.set_by,updated_at=unixepoch()`)
            .run(gid, id, k, ME);
        }
        db.prepare('DELETE FROM history_nudges WHERE group_id=? AND game_id=? AND field=?')
          .run(gid, id, k);
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
      const payload = await readBody(req);
      const { gameId, score } = payload;
      if (!one('SELECT 1 AS x FROM games WHERE id=? AND group_id=?', gameId, gid)) return send(res, 404, { error: 'no such game' });
      db.prepare(`INSERT INTO ratings (game_id, steam_id, score) VALUES (?,?,?)
                  ON CONFLICT(game_id, steam_id) DO UPDATE SET score=excluded.score`).run(gameId, ME, score);
      // Only when sent, exactly like the route: an ordinary save must not clear it.
      if ('replay' in payload) {
        const replay = payload.replay == null ? null : String(payload.replay);
        if (replay !== null && !['yes', 'maybe', 'no'].includes(replay)) {
          return send(res, 400, { error: 'replay must be yes, maybe or no' });
        }
        db.prepare('UPDATE ratings SET replay=? WHERE game_id=? AND steam_id=?').run(replay, gameId, ME);
      }
      return send(res, 200, { ok: true });
    }
    if (sub === '/skip' && req.method === 'DELETE') {
      const { gameId } = await readBody(req);
      db.prepare(`DELETE FROM skips WHERE game_id=? AND steam_id=?
                   AND game_id IN (SELECT id FROM games WHERE group_id=?)`).run(gameId, ME, gid);
      return send(res, 200, { ok: true });
    }
    if (sub === '/skip' && req.method === 'POST') {
      const { gameId, notPlayed } = await readBody(req);
      if (!one('SELECT 1 AS x FROM games WHERE id=? AND group_id=?', gameId, gid)) return send(res, 404, { error: 'no such game' });
      db.prepare(`INSERT INTO skips (game_id, steam_id, not_played) VALUES (?,?,?)
                  ON CONFLICT(game_id, steam_id) DO UPDATE SET not_played = excluded.not_played`)
        .run(gameId, ME, notPlayed ? 1 : 0);
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
                 blindRating: !!ctx.blind_rating, mode: ctx.workspace_mode,
                 historyPrompts: !!ctx.history_prompts,
                 inviteCode: ctx.role === 'owner' && ctx.workspace_mode === 'coop'
                   ? ctx.invite_code : null },
      });
    }
    // Enough of the members PATCH to exercise the settings panel locally.
    if (sub === '/members' && req.method === 'PATCH') {
      const b = await readBody(req);
      if (b.myName != null) {
        db.prepare('UPDATE memberships SET short_name=? WHERE group_id=? AND steam_id=?')
          .run(String(b.myName).slice(0, 16), gid, ME);
      }
      if (b.historyPrompts != null) {
        db.prepare(`INSERT INTO member_preferences (group_id,steam_id,history_prompts) VALUES (?,?,?)
                    ON CONFLICT(group_id,steam_id) DO UPDATE SET history_prompts=excluded.history_prompts`)
          .run(gid, ME, b.historyPrompts ? 1 : 0);
      }
      if (b.blindRating != null) {
        if (ctx.role !== 'owner') return send(res, 403, { error: 'only the group owner can change blind rating' });
        db.prepare('UPDATE groups SET blind_rating=? WHERE id=?').run(b.blindRating ? 1 : 0, gid);
      }
      if (b.name != null && ctx.role === 'owner') {
        db.prepare('UPDATE groups SET name=? WHERE id=?').run(String(b.name).slice(0, 60), gid);
      }
      if (b.mode != null && ctx.role === 'owner') {
        const mode = String(b.mode);
        const count = one('SELECT COUNT(*) AS n FROM memberships WHERE group_id=?', gid).n;
        if (!['coop', 'personal'].includes(mode) || (mode === 'personal' && count !== 1)) {
          return send(res, 409, { error: 'this workspace cannot use that type' });
        }
        db.prepare(`INSERT INTO workspace_settings (group_id,mode) VALUES (?,?)
                    ON CONFLICT(group_id) DO UPDATE SET mode=excluded.mode`).run(gid, mode);
        db.prepare(`UPDATE groups SET max_players=CASE WHEN ?='personal' THEN 1
                          WHEN max_players<2 THEN 4 ELSE max_players END,
                          invite_code=CASE WHEN ?='personal' THEN NULL ELSE invite_code END
                     WHERE id=?`).run(mode, mode, gid);
      }
      if (b.maxPlayers != null && ctx.role === 'owner') {
        db.prepare('UPDATE groups SET max_players=? WHERE id=?').run(Number(b.maxPlayers), gid);
      }
      return send(res, 200, { ok: true });
    }
    if (sub === '/stats') {
      const L = libraryFor(gid, need);
      const personal = ctx.workspace_mode === 'personal';
      const statsGames = L.games.map((g) => {
        const playtime = personal && g.steam_appid
          ? one('SELECT minutes,last_played FROM playtime WHERE steam_id=? AND appid=?', ME, g.steam_appid)
          : null;
        return { ...g, personal_last_played: playtime?.last_played ?? null,
          effectiveHours: g.hours ?? (playtime?.minutes != null ? playtime.minutes / 60 : null) };
      });
      const played = statsGames.filter((g) => PLAYED_OUTCOMES.has(g.status) && g.n > 0);
      const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);
      return send(res, 200, {
        mode: ctx.workspace_mode,
        totals: {
          games: L.games.length,
          finished: L.games.filter((g) => g.status === 'finished').length,
          backlog: L.games.filter((g) => g.status === 'backlog').length,
          ratings: L.ratings.length,
          hours: Math.round(L.games.reduce((a, g) => {
            const minutes = personal && g.steam_appid
              ? one('SELECT minutes FROM playtime WHERE steam_id=? AND appid=?', ME, g.steam_appid)?.minutes
              : null;
            return a + (g.hours ?? (minutes != null ? minutes / 60 : 0));
          }, 0)),
          unviableBacklog: personal ? 0 : L.games.filter(
            (g) => g.status === 'backlog' && g.max_players != null && g.max_players < need
          ).length,
          groupMean: L.ratings.length ? r2(L.glob.mean) : null, maxPlayers: need,
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
        ...buildLibraryStats(statsGames),
        personalStats: personal ? buildPersonalStats(statsGames, q(
          `SELECT p.appid,p.achieved,p.total,p.unlocked,p.fetched_at
             FROM achievement_progress p JOIN games g ON g.steam_appid=p.appid
            WHERE g.group_id=? AND g.archived_at IS NULL AND p.steam_id=?`, gid, ME)) : null,
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
        arguments: played.filter((g) => g.n >= 2 && g.spread >= 2).sort((a, b) => b.spread - a.spread).slice(0, 10)
          .map((g) => ({ id: g.id, name: g.name, spread: g.spread, votes: g.votes })),
        topRated: played.slice().sort((a, b) => b.raw - a.raw).slice(0, 10)
          .map((g) => ({ id: g.id, name: g.name, raw: g.raw, n: g.n })),
        mostHours: statsGames.map((g) => ({
          id: g.id, name: g.name, hours: g.effectiveHours,
        })).filter((g) => g.hours).sort((a, b) => b.hours - a.hours).slice(0, 8),
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
