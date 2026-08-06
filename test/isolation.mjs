/**
 * Tenancy tests. These run the REAL route handlers against an in-memory
 * database with a fake D1 shim, so the assertions cover the shipped code
 * rather than a reimplementation of it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const here = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.join(here, '..');

/* ── a minimal D1 shim over node:sqlite ─────────────────────────────────── */
function makeDB(sqlite) {
  const prepare = (sql) => {
    let bound = [];
    const api = {
      bind: (...a) => { bound = a; return api; },
      async first() { const r = sqlite.prepare(sql).get(...bound); return r ?? null; },
      async all() { return { results: sqlite.prepare(sql).all(...bound) }; },
      async run() {
        const r = sqlite.prepare(sql).run(...bound);
        return { meta: { last_row_id: Number(r.lastInsertRowid), changes: Number(r.changes) } };
      },
      _exec() { return sqlite.prepare(sql).run(...bound); },
    };
    return api;
  };
  return { prepare, async batch(stmts) { return stmts.map((s) => s._exec()); } };
}

const sqlite = new DatabaseSync(':memory:');
sqlite.exec('PRAGMA foreign_keys = ON');
sqlite.exec(fs.readFileSync(path.join(SITE, 'schema.sql'), 'utf8'));
sqlite.exec(fs.readFileSync(path.join(SITE, 'seed.sql'), 'utf8'));

const ALICE = '76561198000000001';
const MALLORY = '76561198000000002';
sqlite.exec(`INSERT INTO users (steam_id, display_name) VALUES ('${ALICE}','Alice'),('${MALLORY}','Mallory')`);
sqlite.exec(`INSERT INTO memberships (group_id, steam_id, short_name, role) VALUES (1,'${ALICE}','Ama','owner')`);
sqlite.exec(`INSERT INTO groups (id, slug, name, invite_code, max_players) VALUES (2,'mallorys','Mallorys Crew','MALLORY123',4)`);
sqlite.exec(`INSERT INTO memberships (group_id, steam_id, short_name, role) VALUES (2,'${MALLORY}','Mallory','owner')`);

const DB = makeDB(sqlite);
const env = { DB, SESSION_SECRET: 'test', STEAM_API_KEY: '' };

const [gamesRoute, gameIdRoute, rateRoute, groupMw, joinRoute, groupsRoute, membersRoute, groupRoute,
       commentsRoute] = await Promise.all([
  import(path.join(SITE, 'functions/api/g/[slug]/games/index.js')),
  import(path.join(SITE, 'functions/api/g/[slug]/games/[id].js')),
  import(path.join(SITE, 'functions/api/g/[slug]/rate.js')),
  import(path.join(SITE, 'functions/api/g/[slug]/_middleware.js')),
  import(path.join(SITE, 'functions/api/groups/join.js')),
  import(path.join(SITE, 'functions/api/groups/index.js')),
  import(path.join(SITE, 'functions/api/g/[slug]/members.js')),
  import(path.join(SITE, 'functions/api/g/[slug]/group.js')),
  import(path.join(SITE, 'functions/api/g/[slug]/comments.js')),
]);

const user = (id) => sqlite.prepare('SELECT * FROM users WHERE steam_id=?').get(id);
const ctxFor = async (steamId, slug) => {
  const data = { user: user(steamId), steamId };
  let passed = false;
  const out = await groupMw.onRequest({ env, params: { slug }, data, next: async () => { passed = true; return null; } });
  return { passed, out, data };
};
const req = (body) => new Request('https://x/', { method: 'POST', body: JSON.stringify(body) });

let pass = 0, fail = 0;
const check = async (name, fn) => {
  try {
    const ok = await fn();
    if (ok === true) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}  -> ${ok}`); }
  } catch (e) { fail++; console.log(`  ERROR ${name}  -> ${e.message}`); }
};

console.log('\nTenancy');

await check('member reaches their own group', async () => {
  const { passed } = await ctxFor(ALICE, 'g4m1ng');
  return passed || 'middleware blocked a legitimate member';
});

await check("non-member gets 404 (not 403) for someone else's group", async () => {
  const { passed, out } = await ctxFor(MALLORY, 'g4m1ng');
  if (passed) return 'middleware LET A NON-MEMBER THROUGH';
  return out.status === 404 || `expected 404, got ${out.status}`;
});

await check('unknown slug is 404', async () => {
  const { out } = await ctxFor(ALICE, 'does-not-exist');
  return out.status === 404 || `got ${out.status}`;
});

await check("group library contains only that group's games", async () => {
  const { data } = await ctxFor(ALICE, 'g4m1ng');
  const body = await (await gamesRoute.onRequestGet({ env, data })).json();
  const ids = body.games.map((g) => g.id);
  const foreign = sqlite.prepare('SELECT id FROM games WHERE group_id<>1').all().map((r) => r.id);
  return !ids.some((i) => foreign.includes(i)) || 'leaked a foreign game';
});

console.log('\nCross-group writes');

// Give Mallory's group a game, then have Alice try to touch it by id.
sqlite.exec(`INSERT INTO games (id, group_id, name, status) VALUES (5000,2,'Mallory Secret','backlog')`);

await check('cannot rate a game in a group you are not in', async () => {
  const { data } = await ctxFor(ALICE, 'g4m1ng');
  const r = await rateRoute.onRequestPost({ request: req({ gameId: 5000, score: 9 }), env, data });
  if (r.status === 200) return 'RATED A FOREIGN GAME';
  const leaked = sqlite.prepare('SELECT COUNT(*) AS n FROM ratings WHERE game_id=5000').get().n;
  return (r.status === 404 && leaked === 0) || `status ${r.status}, rows ${leaked}`;
});

await check('cannot PATCH a game in another group', async () => {
  const { data } = await ctxFor(ALICE, 'g4m1ng');
  const r = await gameIdRoute.onRequestPatch({ params: { id: '5000' }, request: req({ name: 'pwned' }), env, data });
  const row = sqlite.prepare('SELECT name FROM games WHERE id=5000').get();
  return (r.status === 404 && row.name === 'Mallory Secret') || `status ${r.status}, name now ${row.name}`;
});

await check('cannot DELETE a game in another group', async () => {
  const { data } = await ctxFor(ALICE, 'g4m1ng');
  const r = await gameIdRoute.onRequestDelete({ params: { id: '5000' }, env, data });
  const still = sqlite.prepare('SELECT COUNT(*) AS n FROM games WHERE id=5000').get().n;
  return (r.status === 404 && still === 1) || `status ${r.status}, rows ${still}`;
});

await check('queue never offers another group\'s games', async () => {
  const skip = await import(path.join(SITE, 'functions/api/g/[slug]/skip.js'));
  const { data } = await ctxFor(ALICE, 'g4m1ng');
  const body = await (await skip.onRequestGet({ env, data })).json();
  return !body.queue.includes(5000) || 'foreign game appeared in the queue';
});

console.log('\nInvites & membership');

await check('a wrong invite code is rejected', async () => {
  const r = await joinRoute.onRequestPost({ request: req({ code: 'NOPENOPE99' }), env, data: { user: user(MALLORY) } });
  return r.status === 404 || `got ${r.status}`;
});

await check('joining is impossible while the invite code is NULL', async () => {
  const r = await joinRoute.onRequestPost({ request: req({ code: 'ANYTHING99' }), env, data: { user: user(MALLORY) } });
  return r.status === 404 || `got ${r.status}`;
});

await check('a valid invite code joins the group', async () => {
  sqlite.exec(`UPDATE groups SET invite_code='GOODCODE99' WHERE id=1`);
  const r2 = await joinRoute.onRequestPost({ request: req({ code: 'goodcode99' }), env, data: { user: user(MALLORY) } });
  const joined = sqlite.prepare('SELECT COUNT(*) AS n FROM memberships WHERE group_id=1 AND steam_id=?').get(MALLORY).n;
  return (r2.status === 200 && joined === 1) || `status ${r2.status}, membership ${joined}`;
});

await check('joining twice does not duplicate the membership', async () => {
  await joinRoute.onRequestPost({ request: req({ code: 'GOODCODE99' }), env, data: { user: user(MALLORY) } });
  const n = sqlite.prepare('SELECT COUNT(*) AS n FROM memberships WHERE group_id=1 AND steam_id=?').get(MALLORY).n;
  return n === 1 || `${n} membership rows`;
});

await check('a plain member cannot rename the group or rotate the invite', async () => {
  const { data } = await ctxFor(MALLORY, 'g4m1ng');
  const r = await membersRoute.onRequestPatch({
    request: new Request('https://x/', { method: 'PATCH', body: JSON.stringify({ name: 'Hijacked' }) }), env, data });
  const name = sqlite.prepare('SELECT name FROM groups WHERE id=1').get().name;
  const r2 = await membersRoute.onRequestPatch({
    request: new Request('https://x/', { method: 'PATCH', body: JSON.stringify({ invite: 'rotate' }) }), env, data });
  return (r.status === 403 && r2.status === 403 && name === 'g4m1ng') || `${r.status}/${r2.status}, name ${name}`;
});

await check('a plain member CAN rename themselves', async () => {
  const { data } = await ctxFor(MALLORY, 'g4m1ng');
  const r = await membersRoute.onRequestPatch({
    request: new Request('https://x/', { method: 'PATCH', body: JSON.stringify({ myName: 'Mal' }) }), env, data });
  const n = sqlite.prepare('SELECT short_name FROM memberships WHERE group_id=1 AND steam_id=?').get(MALLORY).short_name;
  return (r.status === 200 && n === 'Mal') || `status ${r.status}, name ${n}`;
});

await check('a member cannot remove another member', async () => {
  const { data } = await ctxFor(MALLORY, 'g4m1ng');
  const r = await membersRoute.onRequestDelete({
    request: new Request('https://x/', { method: 'DELETE', body: JSON.stringify({ steamId: ALICE }) }), env, data });
  const still = sqlite.prepare('SELECT COUNT(*) AS n FROM memberships WHERE group_id=1 AND steam_id=?').get(ALICE).n;
  return (r.status === 403 && still === 1) || `status ${r.status}, rows ${still}`;
});

await check('the only owner cannot leave and orphan the group', async () => {
  const { data } = await ctxFor(ALICE, 'g4m1ng');
  const r = await membersRoute.onRequestDelete({
    request: new Request('https://x/', { method: 'DELETE', body: JSON.stringify({}) }), env, data });
  return r.status === 409 || `got ${r.status}`;
});

console.log('\nGroup creation');

await check('creating a group makes you its owner with a unique slug', async () => {
  const before = sqlite.prepare('SELECT COUNT(*) AS n FROM groups').get().n;
  const r = await groupsRoute.onRequestPost({ request: req({ name: 'g4m1ng', maxPlayers: 6 }), env, data: { user: user(MALLORY) } });
  const b = await r.json();
  if (b.slug === 'g4m1ng') return 'slug collided with the existing group';
  const row = sqlite.prepare('SELECT * FROM groups WHERE slug=?').get(b.slug);
  const mem = sqlite.prepare("SELECT role FROM memberships WHERE group_id=? AND steam_id=?").get(row.id, MALLORY);
  const after = sqlite.prepare('SELECT COUNT(*) AS n FROM groups').get().n;
  return (after === before + 1 && mem.role === 'owner' && row.max_players === 6) || `slug ${b.slug}, role ${mem?.role}, cap ${row.max_players}`;
});

await check('a reserved slug is never handed out', async () => {
  const r = await groupsRoute.onRequestPost({ request: req({ name: 'api' }), env, data: { user: user(MALLORY) } });
  const b = await r.json();
  return b.slug !== 'api' || 'handed out the reserved slug "api"';
});

await check('group size is validated', async () => {
  const r = await groupsRoute.onRequestPost({ request: req({ name: 'Too Big', maxPlayers: 999 }), env, data: { user: user(MALLORY) } });
  return r.status === 400 || `got ${r.status}`;
});

console.log('\nGlobal catalogue & pools');

const coopRoute = await import(path.join(SITE, 'functions/api/coop/index.js'));
const getCoop = (qs = '') =>
  coopRoute.onRequestGet({ request: new Request(`https://x/api/coop?${qs}`), env });

sqlite.exec(`INSERT INTO coop_apps (appid, name, popularity_rank, max_players, max_players_src) VALUES
  (777001,'Verified Four',1,4,'manual'),
  (777002,'Unverified Cap',2,NULL,NULL),
  (777003,'Verified Two',3,2,'manual')`);
// A fresh steam_apps row so pooling does not reach out to Steam during tests.
sqlite.exec(`INSERT INTO steam_apps (appid, name, genre, fetched_at)
             VALUES (777001,'Verified Four','Action',unixepoch())`);

await check('the catalogue is global — identical for callers in different groups', async () => {
  const a = await (await getCoop()).json();
  const b = await (await getCoop()).json();
  return (a.total === b.total && a.total >= 3) || `totals ${a.total} vs ${b.total}`;
});

await check('the catalogue exposes no group-scoped fields', async () => {
  const { games } = await (await getCoop()).json();
  const leaked = games.flatMap((g) => Object.keys(g))
    .filter((k) => /group|steam_id|rating|votes|pool/i.test(k));
  return leaked.length === 0 || `leaked ${[...new Set(leaked)].join(', ')}`;
});

await check('a fit filter never offers a game whose player count is unverified', async () => {
  const { games } = await (await getCoop()).json();
  const hasUnverified = games.some((g) => g.appid === 777002);
  const fits = await (await getCoop('minPlayers=4')).json();
  if (!hasUnverified) return 'fixture missing: unverified game absent from unfiltered list';
  if (fits.games.some((g) => g.max_players == null)) return 'CLAIMED AN UNVERIFIED GAME FITS';
  return fits.games.every((g) => g.max_players >= 4) || 'returned a game below the headcount';
});

await check('two groups can pool the same game independently', async () => {
  const one = await ctxFor(ALICE, 'g4m1ng');
  const two = await ctxFor(MALLORY, 'mallorys');
  const r1 = await gamesRoute.onRequestPost({ request: req({ input: '777001', maxPlayers: 4 }), env, data: one.data });
  const r2 = await gamesRoute.onRequestPost({ request: req({ input: '777001', maxPlayers: 4 }), env, data: two.data });
  if (r1.status !== 201) return `first group could not pool it: ${r1.status}`;
  if (r2.status !== 201) return `second group blocked by a global unique: ${r2.status}`;
  const rows = sqlite.prepare('SELECT group_id FROM games WHERE steam_appid=777001').all();
  return rows.length === 2 || `expected one row per group, got ${rows.length}`;
});

await check('pooling the same game twice in one group is rejected', async () => {
  const { data } = await ctxFor(ALICE, 'g4m1ng');
  const r = await gamesRoute.onRequestPost({ request: req({ input: '777001' }), env, data });
  return r.status === 409 || `expected 409, got ${r.status}`;
});

await check('a pooled game lands only in the pooling group', async () => {
  const { data } = await ctxFor(MALLORY, 'mallorys');
  const body = await (await gamesRoute.onRequestGet({ env, data })).json();
  const mine = body.games.filter((g) => g.steam_appid === 777001);
  const foreign = body.games.filter((g) => g.group_id && g.group_id !== 2);
  return (mine.length === 1 && foreign.length === 0) || `mine:${mine.length} foreign:${foreign.length}`;
});

await check('a game with no Steam page can be added by hand', async () => {
  const { data } = await ctxFor(ALICE, 'g4m1ng');
  const r = await gamesRoute.onRequestPost({
    request: req({ manual: true, name: 'Kniffel Deluxe', genre: 'Board game', maxPlayers: 2 }), env, data });
  if (r.status !== 201) return `expected 201, got ${r.status}`;
  const row = sqlite.prepare("SELECT * FROM games WHERE group_id=1 AND name='Kniffel Deluxe'").get();
  if (!row) return 'row not written';
  if (row.steam_appid != null) return 'invented a steam_appid';
  // enriched_at must be stamped, or /enrich will keep hunting for a match that
  // deliberately does not exist and burn Steam quota on every run.
  return row.enriched_at != null || 'enriched_at not stamped, /enrich will retry forever';
});

await check('a hand-added game is not added twice under the same name', async () => {
  const { data } = await ctxFor(ALICE, 'g4m1ng');
  const r = await gamesRoute.onRequestPost({
    request: req({ manual: true, name: 'kniffel deluxe' }), env, data });   // different case
  return r.status === 409 || `expected 409, got ${r.status}`;
});

await check('a hand-added game needs a real name', async () => {
  const { data } = await ctxFor(ALICE, 'g4m1ng');
  const r = await gamesRoute.onRequestPost({ request: req({ manual: true, name: ' ' }), env, data });
  return r.status === 400 || `expected 400, got ${r.status}`;
});

await check('adding by hand cannot reach another group', async () => {
  const { data } = await ctxFor(MALLORY, 'mallorys');
  await gamesRoute.onRequestPost({ request: req({ manual: true, name: 'Mallory Board Game' }), env, data });
  const leaked = sqlite.prepare(
    "SELECT 1 FROM games WHERE group_id=1 AND name='Mallory Board Game'").get();
  return !leaked || 'hand-added game landed in the wrong group';
});

console.log('\nPre-assigned identities');

const { applySeedAssignment } = await import(path.join(SITE, 'lib/groups.js'));
const claimRoute = await import(path.join(SITE, 'functions/api/g/[slug]/claim.js'));

const LEO_REAL = '76561198000000777';
const NOBODY   = '76561198000000888';
sqlite.exec(`INSERT INTO users (steam_id, display_name) VALUES ('${LEO_REAL}','Leo IRL'),('${NOBODY}','Nobody')`);

await check('a pre-assigned SteamID64 is auto-claimed on joining', async () => {
  const before = sqlite.prepare(
    `SELECT COUNT(*) AS n FROM ratings r JOIN games g ON g.id=r.game_id
      WHERE g.group_id=1 AND r.steam_id='seed:1:leo'`).get().n;
  if (!before) return 'fixture: seed:1:leo has no ratings to move';

  sqlite.exec(`INSERT INTO seed_assignments (group_id, steam_id, seed_steam_id)
               VALUES (1,'${LEO_REAL}','seed:1:leo')`);
  // The membership must exist first — repointing onto a non-member trips the FK.
  sqlite.exec(`INSERT INTO memberships (group_id, steam_id, short_name, role)
               VALUES (1,'${LEO_REAL}','Leo IRL','member')`);

  const name = await applySeedAssignment(DB, 1, LEO_REAL);
  if (name !== 'Leo') return `expected 'Leo', got ${JSON.stringify(name)}`;

  const after = sqlite.prepare(
    `SELECT COUNT(*) AS n FROM ratings r JOIN games g ON g.id=r.game_id
      WHERE g.group_id=1 AND r.steam_id=?`).get(LEO_REAL).n;
  const placeholderGone = !sqlite.prepare(
    `SELECT 1 FROM memberships WHERE group_id=1 AND steam_id='seed:1:leo'`).get();
  return (after === before && placeholderGone)
    || `moved ${after}/${before}, placeholder gone: ${placeholderGone}`;
});

await check('applying the same assignment twice is a harmless no-op', async () => {
  const again = await applySeedAssignment(DB, 1, LEO_REAL);
  return again === null || `re-claimed as ${again}`;
});

await check('an assignment in one group never fires in another', async () => {
  // Mallory's group has its own membership for this person but no assignment.
  sqlite.exec(`INSERT INTO memberships (group_id, steam_id, short_name, role)
               VALUES (2,'${LEO_REAL}','Leo IRL','member')`);
  const leaked = await applySeedAssignment(DB, 2, LEO_REAL);
  return leaked === null || `CROSS-GROUP ASSIGNMENT FIRED: ${leaked}`;
});

await check('someone with no assignment is left to the claim screen', async () => {
  sqlite.exec(`INSERT INTO memberships (group_id, steam_id, short_name, role)
               VALUES (1,'${NOBODY}','Nobody','member')`);
  const auto = await applySeedAssignment(DB, 1, NOBODY);
  if (auto !== null) return `auto-claimed ${auto} without an assignment`;
  const { data } = await ctxFor(NOBODY, 'g4m1ng');
  const body = await (await claimRoute.onRequestGet({ env, data })).json();
  return (body.canClaim && body.unclaimed.length > 0)
    || `canClaim=${body.canClaim} unclaimed=${body.unclaimed.length}`;
});

await check('auto-claim refuses to merge an existing rating history', async () => {
  const game = sqlite.prepare('SELECT id FROM games WHERE group_id=1 LIMIT 1').get().id;
  sqlite.exec(`INSERT INTO ratings (game_id, steam_id, score) VALUES (${game},'${NOBODY}',7)`);
  sqlite.exec(`INSERT INTO seed_assignments (group_id, steam_id, seed_steam_id)
               VALUES (1,'${NOBODY}','seed:1:pat')`);
  const merged = await applySeedAssignment(DB, 1, NOBODY);
  const patIntact = sqlite.prepare(
    `SELECT 1 FROM memberships WHERE group_id=1 AND steam_id='seed:1:pat'`).get();
  return (merged === null && !!patIntact)
    || `merged=${JSON.stringify(merged)} patIntact=${!!patIntact}`;
});

console.log('\nGroup hours estimate');

const { recomputeEstimates } = await import(path.join(SITE, 'functions/api/g/[slug]/playtime.js'));

// Four real members in group 1, and three games to exercise the three cases the
// group actually asked about.
const PLAYERS = ['76561198000000101', '76561198000000102', '76561198000000103', '76561198000000104'];
sqlite.exec(`INSERT INTO users (steam_id, display_name) VALUES
  ${PLAYERS.map((p, i) => `('${p}','P${i + 1}')`).join(',')}`);
sqlite.exec(`INSERT INTO memberships (group_id, steam_id, short_name, role) VALUES
  ${PLAYERS.map((p, i) => `(1,'${p}','P${i + 1}','member')`).join(',')}`);
sqlite.exec(`INSERT INTO games (id, group_id, name, steam_appid, status) VALUES
  (7001,1,'Solo Only',900001,'finished'),
  (7002,1,'Coop Plus Solo',900002,'finished'),
  (7003,1,'Three Of Four',900003,'finished')`);

const mins = (steamId, appid, m) =>
  sqlite.exec(`INSERT OR REPLACE INTO playtime (steam_id, appid, minutes) VALUES ('${steamId}',${appid},${m})`);

// Only P1 played it at all.
mins(PLAYERS[0], 900001, 6000);
// All four played; P1 also sank a lot of solo time in.
mins(PLAYERS[0], 900002, 9000); mins(PLAYERS[1], 900002, 1200);
mins(PLAYERS[2], 900002, 1500); mins(PLAYERS[3], 900002, 1300);
// Three played; the fourth never launched it.
mins(PLAYERS[0], 900003, 600); mins(PLAYERS[1], 900003, 900);
mins(PLAYERS[2], 900003, 720); mins(PLAYERS[3], 900003, 0);

await recomputeEstimates(env, 1);
const est = (id) => sqlite.prepare('SELECT hours_estimated AS h, hours_participants AS n FROM games WHERE id=?').get(id);

await check('one person playing alone is zero group hours', async () => {
  const g = est(7001);
  return (g.h === 0 && g.n === 1) || `hours ${g.h}, participants ${g.n}`;
});

await check("one member's extra solo hours cannot inflate the estimate", async () => {
  // P1 has 150h, the others 20-25h. The minimum is 20h, so the solo overflow is
  // invisible — which is the whole reason for using a minimum.
  const g = est(7002);
  return (g.h === 20 && g.n === 4) || `hours ${g.h}, participants ${g.n}`;
});

await check('a member who never played does not drag the estimate down', async () => {
  // Three participants at 10h, 15h and 12h; the fourth's zero is excluded, so the
  // answer is 10 rather than 0.
  const g = est(7003);
  return (g.h === 10 && g.n === 3) || `hours ${g.h}, participants ${g.n}`;
});

await check('a hand-typed figure is never overwritten by a sync', async () => {
  sqlite.exec('UPDATE games SET hours = 42 WHERE id = 7002');
  await recomputeEstimates(env, 1);
  const row = sqlite.prepare('SELECT hours, hours_estimated FROM games WHERE id=7002').get();
  return (row.hours === 42 && row.hours_estimated === 20)
    || `hours ${row.hours}, estimate ${row.hours_estimated}`;
});

await check('estimates work from partial data', async () => {
  // Wipe two members' playtime entirely: the remaining two still produce a number,
  // and the participant count says how thin it is.
  sqlite.exec(`DELETE FROM playtime WHERE steam_id IN ('${PLAYERS[2]}','${PLAYERS[3]}')`);
  await recomputeEstimates(env, 1);
  const g = est(7002);
  return (g.n === 2 && g.h === 20) || `participants ${g.n}, hours ${g.h}`;
});

await check('a pre-assigned friend counts before they have ever signed in', async () => {
  // Leo is still the placeholder 'seed:1:leo' with a seed_assignments row pointing
  // at his real SteamID64. His playtime must count, or a group that imported its
  // history sees one participant everywhere and zero hours for everything.
  const LEO_REAL = '76561198000000901';
  sqlite.exec(`INSERT INTO users (steam_id, display_name) VALUES ('${LEO_REAL}','Leo Real')`);
  sqlite.exec(`INSERT OR REPLACE INTO seed_assignments (group_id, steam_id, seed_steam_id)
               VALUES (1,'${LEO_REAL}','seed:1:pat')`);
  sqlite.exec(`INSERT INTO games (id, group_id, name, steam_appid, status)
               VALUES (7004,1,'Assigned Coop',900004,'finished')`);
  mins(PLAYERS[0], 900004, 1200);   // a real member: 20h
  mins(LEO_REAL,   900004, 900);    // via the assignment: 15h
  await recomputeEstimates(env, 1);
  const g = est(7004);
  return (g.n === 2 && g.h === 15) || `participants ${g.n}, hours ${g.h}`;
});

await check('estimates never cross into another group', async () => {
  sqlite.exec(`INSERT INTO games (id, group_id, name, steam_appid, status)
               VALUES (7100,2,'Mallory Coop',900002,'finished')`);
  await recomputeEstimates(env, 1);
  const other = sqlite.prepare('SELECT hours_estimated FROM games WHERE id=7100').get();
  return other.hours_estimated == null || `group 2 game was given ${other.hours_estimated}`;
});

console.log('\nComments');

const getReq = (url) => new Request(url);
const delReq = (b) => new Request('https://x/', { method: 'DELETE', body: JSON.stringify(b) });

await check('a member can post a comment on their own group\'s game', async () => {
  const { data } = await ctxFor(ALICE, 'g4m1ng');
  const g = sqlite.prepare('SELECT id FROM games WHERE group_id=1 LIMIT 1').get();
  const r = await commentsRoute.onRequestPost({
    request: req({ gameId: g.id, body: 'worth a Wednesday' }), env, data });
  if (r.status !== 201) return `expected 201, got ${r.status}`;
  const row = sqlite.prepare('SELECT group_id, steam_id, body FROM comments WHERE game_id=?').get(g.id);
  return (row && row.group_id === 1 && row.steam_id === ALICE)
    || `row ${JSON.stringify(row)}`;
});

await check('CANNOT comment on another group\'s game by guessing its id', async () => {
  // Game 5000 belongs to Mallory's group. Alice is a legitimate member of hers.
  const { data } = await ctxFor(ALICE, 'g4m1ng');
  const r = await commentsRoute.onRequestPost({
    request: req({ gameId: 5000, body: 'pwned' }), env, data });
  const leaked = sqlite.prepare('SELECT COUNT(*) AS n FROM comments WHERE game_id=5000').get().n;
  return (r.status === 404 && leaked === 0) || `status ${r.status}, rows ${leaked}`;
});

await check('CANNOT read another group\'s comment thread', async () => {
  // Seed a comment on Mallory's game directly, then have Alice ask for it.
  sqlite.exec(`INSERT INTO comments (group_id, game_id, steam_id, body)
               VALUES (2, 5000, '${MALLORY}', 'mallory secret plan')`);
  const { data } = await ctxFor(ALICE, 'g4m1ng');
  const r = await commentsRoute.onRequestGet({
    request: getReq('https://x/api/g/g4m1ng/comments?gameId=5000'), env, data });
  if (r.status !== 404) return `expected 404, got ${r.status}`;
  const text = await r.text();
  return !text.includes('mallory secret plan') || 'LEAKED another group\'s comment';
});

await check('the thread returns only this group\'s comments', async () => {
  const { data } = await ctxFor(ALICE, 'g4m1ng');
  const g = sqlite.prepare('SELECT id FROM games WHERE group_id=1 LIMIT 1').get();
  const body = await (await commentsRoute.onRequestGet({
    request: getReq(`https://x/api/g/g4m1ng/comments?gameId=${g.id}`), env, data })).json();
  const foreign = body.comments.filter((c) => c.body === 'mallory secret plan');
  return foreign.length === 0 || 'foreign comment appeared in the thread';
});

await check('you can delete your own comment', async () => {
  const { data } = await ctxFor(ALICE, 'g4m1ng');
  const c = sqlite.prepare(`SELECT id FROM comments WHERE group_id=1 AND steam_id='${ALICE}'`).get();
  const r = await commentsRoute.onRequestDelete({ request: delReq({ id: c.id }), env, data });
  const gone = !sqlite.prepare('SELECT 1 FROM comments WHERE id=?').get(c.id);
  return (r.status === 200 && gone) || `status ${r.status}, gone ${gone}`;
});

await check('a plain member cannot delete someone else\'s comment', async () => {
  // Mallory is a plain member of group 1 (she joined with the invite code above).
  sqlite.exec(`INSERT INTO comments (group_id, game_id, steam_id, body)
               SELECT 1, id, '${ALICE}', 'alice says hi' FROM games WHERE group_id=1 LIMIT 1`);
  const c = sqlite.prepare(`SELECT id FROM comments WHERE body='alice says hi'`).get();
  const { data } = await ctxFor(MALLORY, 'g4m1ng');
  const r = await commentsRoute.onRequestDelete({ request: delReq({ id: c.id }), env, data });
  const still = !!sqlite.prepare('SELECT 1 FROM comments WHERE id=?').get(c.id);
  return (r.status === 403 && still) || `status ${r.status}, still ${still}`;
});

await check('the owner can delete anyone\'s comment', async () => {
  const c = sqlite.prepare(`SELECT id FROM comments WHERE body='alice says hi'`).get();
  const { data } = await ctxFor(ALICE, 'g4m1ng');   // Alice owns group 1
  const r = await commentsRoute.onRequestDelete({ request: delReq({ id: c.id }), env, data });
  return r.status === 200 || `status ${r.status}`;
});

await check('CANNOT delete a comment in another group', async () => {
  const c = sqlite.prepare(`SELECT id FROM comments WHERE body='mallory secret plan'`).get();
  const { data } = await ctxFor(ALICE, 'g4m1ng');
  const r = await commentsRoute.onRequestDelete({ request: delReq({ id: c.id }), env, data });
  const still = !!sqlite.prepare('SELECT 1 FROM comments WHERE id=?').get(c.id);
  return (r.status === 404 && still) || `status ${r.status}, still ${still}`;
});

await check('an empty comment is refused', async () => {
  const { data } = await ctxFor(ALICE, 'g4m1ng');
  const g = sqlite.prepare('SELECT id FROM games WHERE group_id=1 LIMIT 1').get();
  const r = await commentsRoute.onRequestPost({ request: req({ gameId: g.id, body: '   ' }), env, data });
  return r.status === 400 || `expected 400, got ${r.status}`;
});

await check('comments go with the game when the group is deleted', async () => {
  // Cascade check: group -> games -> comments, plus the direct group_id FK.
  const n = sqlite.prepare('SELECT COUNT(*) AS n FROM comments WHERE group_id=2').get().n;
  if (!n) return 'fixture: group 2 has no comments to cascade';
  sqlite.exec('DELETE FROM groups WHERE id=2');
  const left = sqlite.prepare('SELECT COUNT(*) AS n FROM comments WHERE group_id=2').get().n;
  sqlite.exec(`INSERT INTO groups (id, slug, name, invite_code, max_players)
               VALUES (2,'mallorys','Mallorys Crew','MALLORY123',4)`);
  sqlite.exec(`INSERT INTO memberships (group_id, steam_id, short_name, role)
               VALUES (2,'${MALLORY}','Mallory','owner')`);
  sqlite.exec(`INSERT INTO games (id, group_id, name, status) VALUES (5000,2,'Mallory Secret','backlog')`);
  return left === 0 || `${left} comments survived the group deletion`;
});

console.log('\nArchiving');

await check('removing a game archives it and keeps every rating', async () => {
  const { data } = await ctxFor(ALICE, 'g4m1ng');
  const g = sqlite.prepare('SELECT id FROM games WHERE group_id=1 LIMIT 1').get();
  sqlite.exec(`INSERT OR REPLACE INTO ratings (game_id, steam_id, score) VALUES (${g.id},'${ALICE}',8)`);
  const before = sqlite.prepare('SELECT COUNT(*) AS n FROM ratings WHERE game_id=?').get(g.id).n;

  const r = await gameIdRoute.onRequestDelete({ params: { id: String(g.id) }, env, data });
  if (r.status !== 200) return `expected 200, got ${r.status}`;

  const row = sqlite.prepare('SELECT archived_at FROM games WHERE id=?').get(g.id);
  const after = sqlite.prepare('SELECT COUNT(*) AS n FROM ratings WHERE game_id=?').get(g.id).n;
  return (row && row.archived_at != null && after === before)
    || `archived_at=${row?.archived_at} ratings ${before}->${after}`;
});

await check('an archived game leaves the rating queue', async () => {
  const skip = await import(path.join(SITE, 'functions/api/g/[slug]/skip.js'));
  const archived = sqlite.prepare('SELECT id FROM games WHERE group_id=1 AND archived_at IS NOT NULL').get();
  const { data } = await ctxFor(MALLORY, 'g4m1ng');   // someone who has not rated it
  const body = await (await skip.onRequestGet({ env, data })).json();
  return !body.queue.includes(archived.id) || 'archived game still offered in the queue';
});

await check('an archived game leaves the stats', async () => {
  const statsRoute = await import(path.join(SITE, 'functions/api/g/[slug]/stats.js'));
  const archived = sqlite.prepare('SELECT id, name FROM games WHERE group_id=1 AND archived_at IS NOT NULL').get();
  const { data } = await ctxFor(ALICE, 'g4m1ng');
  const body = await (await statsRoute.onRequestGet({ env, data })).json();
  // By id, not by name: "Sea of Thieves" is a substring of "Sea of Thieves:
  // Monkey Island", so a text search reports a false positive against a game that
  // is not archived at all.
  const ids = [...(body.topRated || []), ...(body.mostHours || []), ...(body.arguments || [])]
    .map((x) => x.id);
  if (ids.includes(archived.id)) return `archived game id ${archived.id} still in stats lists`;
  const rated = body.people.reduce((a, p) => a + p.count, 0);
  const expected = sqlite.prepare(
    `SELECT COUNT(*) AS n FROM ratings r JOIN games g ON g.id=r.game_id
      WHERE g.group_id=1 AND g.archived_at IS NULL`).get().n;
  return rated === expected || `people counts total ${rated}, expected ${expected}`;
});

await check('restoring brings the game and its ratings back', async () => {
  const { data } = await ctxFor(ALICE, 'g4m1ng');
  const archived = sqlite.prepare('SELECT id FROM games WHERE group_id=1 AND archived_at IS NOT NULL').get();
  const ratings = sqlite.prepare('SELECT COUNT(*) AS n FROM ratings WHERE game_id=?').get(archived.id).n;
  const r = await gameIdRoute.onRequestPatch({
    params: { id: String(archived.id) }, request: req({ archived: false }), env, data });
  if (r.status !== 200) return `expected 200, got ${r.status}`;
  const row = sqlite.prepare('SELECT archived_at FROM games WHERE id=?').get(archived.id);
  const after = sqlite.prepare('SELECT COUNT(*) AS n FROM ratings WHERE game_id=?').get(archived.id).n;
  return (row.archived_at === null && after === ratings)
    || `archived_at=${row.archived_at} ratings ${ratings}->${after}`;
});

await check('archiving cannot reach a game in another group', async () => {
  const { data } = await ctxFor(ALICE, 'g4m1ng');
  const r = await gameIdRoute.onRequestDelete({ params: { id: '5000' }, env, data });
  const row = sqlite.prepare('SELECT archived_at FROM games WHERE id=5000').get();
  return (r.status === 404 && row.archived_at == null) || `status ${r.status}, archived_at ${row.archived_at}`;
});

await check('there is no hard delete: the row survives a remove', async () => {
  const { data } = await ctxFor(ALICE, 'g4m1ng');
  const g = sqlite.prepare('SELECT id FROM games WHERE group_id=1 AND archived_at IS NULL LIMIT 1').get();
  await gameIdRoute.onRequestDelete({ params: { id: String(g.id) }, env, data });
  const still = sqlite.prepare('SELECT COUNT(*) AS n FROM games WHERE id=?').get(g.id).n;
  return still === 1 || 'the row was actually deleted';
});

console.log('\nGroup rename & deletion');

// Carol owns her own group and is NOT in group 1, so she cannot see that a group
// called "g4m1ng" exists. Mallory is unusable for this: she joined group 1 in the
// invite tests above, so a collision there is genuinely her own.
const CAROL = '76561198000000444';
sqlite.exec(`INSERT INTO users (steam_id, display_name) VALUES ('${CAROL}','Carol')`);
sqlite.exec(`INSERT INTO groups (id, slug, name, max_players) VALUES (300,'carols','Carols Crew',4)`);
sqlite.exec(`INSERT INTO memberships (group_id, steam_id, short_name, role)
             VALUES (300,'${CAROL}','Carol','owner')`);

await check('renaming does NOT check global uniqueness (that would leak private groups)', async () => {
  const { data } = await ctxFor(CAROL, 'carols');
  const r = await membersRoute.onRequestPatch({ request: req({ name: 'g4m1ng' }), env, data });
  const row = sqlite.prepare('SELECT name FROM groups WHERE id=300').get();
  return (r.status === 200 && row.name === 'g4m1ng')
    || `status ${r.status}, name ${row.name}`;
});

await check('renaming to a name YOU already use IS refused', async () => {
  // Now Carol joins group 1, which is also called "g4m1ng". The clash is
  // information she already has, so refusing it leaks nothing — and without the
  // check her switcher would show two identical entries.
  sqlite.exec(`UPDATE groups SET invite_code='CAROLJOIN9' WHERE id=1`);
  await joinRoute.onRequestPost({ request: req({ code: 'CAROLJOIN9' }), env, data: { user: user(CAROL) } });
  sqlite.exec(`UPDATE groups SET name='Carols Crew' WHERE id=300`);
  const { data } = await ctxFor(CAROL, 'carols');
  const r = await membersRoute.onRequestPatch({ request: req({ name: 'g4m1ng' }), env, data });
  const row = sqlite.prepare('SELECT name FROM groups WHERE id=300').get();
  return (r.status === 409 && row.name === 'Carols Crew')
    || `status ${r.status}, name ${row.name}`;
});

await check('renaming never changes the slug, so invite links keep working', async () => {
  const { data } = await ctxFor(MALLORY, 'mallorys');
  await membersRoute.onRequestPatch({ request: req({ name: 'Totally New Name' }), env, data });
  const row = sqlite.prepare('SELECT slug FROM groups WHERE id=2').get();
  return row.slug === 'mallorys' || `slug changed to ${row.slug}`;
});

await check('a plain member cannot delete the group', async () => {
  sqlite.exec(`INSERT INTO users (steam_id, display_name) VALUES ('76561198000000333','Rando')`);
  sqlite.exec(`INSERT INTO memberships (group_id, steam_id, short_name, role)
               VALUES (2,'76561198000000333','Rando','member')`);
  const { data } = await ctxFor('76561198000000333', 'mallorys');
  const r = await groupRoute.onRequestDelete({ request: req({ confirmName: data.group.name }), env, data });
  const still = sqlite.prepare('SELECT COUNT(*) AS n FROM groups WHERE id=2').get().n;
  return (r.status === 403 && still === 1) || `status ${r.status}, groups ${still}`;
});

await check('deleting needs the group name typed exactly', async () => {
  const { data } = await ctxFor(MALLORY, 'mallorys');
  const r = await groupRoute.onRequestDelete({ request: req({ confirmName: 'wrong' }), env, data });
  const still = sqlite.prepare('SELECT COUNT(*) AS n FROM groups WHERE id=2').get().n;
  return (r.status === 400 && still === 1) || `status ${r.status}, groups ${still}`;
});

await check('the owner can delete it, and everything in it goes too', async () => {
  const { data } = await ctxFor(MALLORY, 'mallorys');
  const gamesBefore = sqlite.prepare('SELECT COUNT(*) AS n FROM games WHERE group_id=2').get().n;
  if (!gamesBefore) return 'fixture: group 2 has no games to cascade';
  const r = await groupRoute.onRequestDelete({ request: req({ confirmName: data.group.name }), env, data });
  if (r.status !== 200) return `expected 200, got ${r.status}`;
  const left = {
    groups: sqlite.prepare('SELECT COUNT(*) AS n FROM groups WHERE id=2').get().n,
    games: sqlite.prepare('SELECT COUNT(*) AS n FROM games WHERE group_id=2').get().n,
    members: sqlite.prepare('SELECT COUNT(*) AS n FROM memberships WHERE group_id=2').get().n,
  };
  return (left.groups === 0 && left.games === 0 && left.members === 0)
    || `left behind ${JSON.stringify(left)}`;
});

await check('deleting one group leaves the other untouched', async () => {
  const g1 = sqlite.prepare('SELECT COUNT(*) AS n FROM games WHERE group_id=1').get().n;
  return g1 > 0 || 'group 1 lost its games when group 2 was deleted';
});

console.log('\nScoring & viability');
const { viability } = await import(path.join(SITE, 'lib/score.js'));

await check('viability respects the group headcount', async () => {
  const three = viability({ max_players: 3, coop_note: null }, 3);
  const four = viability({ max_players: 3, coop_note: null }, 4);
  return (three.ok === true && four.ok === false) || `3p:${three.ok} 4p:${four.ok}`;
});

await check('couch-only games are a workaround, not a hard no', async () => {
  const v = viability({ max_players: 0, coop_note: 'Couch co-op only — works for 4 via Remote Play Together' }, 4);
  return v.ok === 'workaround' || `got ${v.ok}`;
});

await check('an unset player count is unknown, not blocked', async () => {
  return viability({ max_players: null }, 4).ok === null || 'treated unknown as blocked';
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
