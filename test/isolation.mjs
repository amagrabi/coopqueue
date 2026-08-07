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
       commentsRoute, rootRoute, meRoute, exportRoute, playNightRoute, achievementsRoute,
       historyRoute, statsRoute] = await Promise.all([
  import(path.join(SITE, 'functions/api/g/[slug]/games/index.js')),
  import(path.join(SITE, 'functions/api/g/[slug]/games/[id].js')),
  import(path.join(SITE, 'functions/api/g/[slug]/rate.js')),
  import(path.join(SITE, 'functions/api/g/[slug]/_middleware.js')),
  import(path.join(SITE, 'functions/api/groups/join.js')),
  import(path.join(SITE, 'functions/api/groups/index.js')),
  import(path.join(SITE, 'functions/api/g/[slug]/members.js')),
  import(path.join(SITE, 'functions/api/g/[slug]/group.js')),
  import(path.join(SITE, 'functions/api/g/[slug]/comments.js')),
  import(path.join(SITE, 'functions/_middleware.js')),
  import(path.join(SITE, 'functions/api/me.js')),
  import(path.join(SITE, 'functions/api/g/[slug]/export.js')),
  import(path.join(SITE, 'functions/api/g/[slug]/play-night.js')),
  import(path.join(SITE, 'functions/api/g/[slug]/achievements.js')),
  import(path.join(SITE, 'functions/api/g/[slug]/history.js')),
  import(path.join(SITE, 'functions/api/g/[slug]/stats.js')),
]);
const { makeSessionCookie } = await import(path.join(SITE, 'lib/auth.js'));
const { body: readBody } = await import(path.join(SITE, 'lib/http.js'));
const { buildHistoryItems } = await import(path.join(SITE, 'lib/history.js'));

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

await check('creating a personal workspace records intent, one player, and no invite', async () => {
  const r = await groupsRoute.onRequestPost({
    request: req({ name: 'My history', mode: 'personal' }), env, data: { user: user(MALLORY) },
  });
  const b = await r.json();
  const row = sqlite.prepare(
    `SELECT g.id,g.max_players,g.invite_code,w.mode,m.role
       FROM groups g JOIN workspace_settings w ON w.group_id=g.id
       JOIN memberships m ON m.group_id=g.id AND m.steam_id=?
      WHERE g.slug=?`
  ).get(MALLORY, b.slug);
  const scoped = await ctxFor(MALLORY, b.slug);
  const library = await (await gamesRoute.onRequestGet({ env, data: scoped.data })).json();
  return (r.status === 201 && b.mode === 'personal' && row?.mode === 'personal'
      && row.max_players === 1 && row.invite_code == null && row.role === 'owner'
      && library.group.mode === 'personal')
    || `status ${r.status}, ${JSON.stringify({ row, group: library.group })}`;
});

await check('a one-person workspace can switch modes without losing its identity', async () => {
  const row = sqlite.prepare(
    "SELECT g.slug FROM groups g JOIN workspace_settings w ON w.group_id=g.id WHERE w.mode='personal' LIMIT 1"
  ).get();
  const { data } = await ctxFor(MALLORY, row.slug);
  const toCoop = await membersRoute.onRequestPatch({
    request: new Request('https://x/', { method: 'PATCH', body: JSON.stringify({ mode: 'coop', maxPlayers: 5 }) }),
    env, data,
  });
  const changed = sqlite.prepare(
    `SELECT g.max_players,w.mode FROM groups g JOIN workspace_settings w ON w.group_id=g.id WHERE g.slug=?`
  ).get(row.slug);
  return (toCoop.status === 200 && changed.mode === 'coop' && changed.max_players === 5)
    || `status ${toCoop.status}, ${JSON.stringify(changed)}`;
});

await check('a workspace with other members cannot be changed to personal', async () => {
  const { data } = await ctxFor(ALICE, 'g4m1ng');
  const r = await membersRoute.onRequestPatch({
    request: new Request('https://x/', { method: 'PATCH', body: JSON.stringify({ mode: 'personal' }) }),
    env, data,
  });
  const mode = sqlite.prepare(
    `SELECT COALESCE(w.mode,'coop') AS mode FROM groups g
       LEFT JOIN workspace_settings w ON w.group_id=g.id WHERE g.id=1`
  ).get().mode;
  return (r.status === 409 && mode === 'coop') || `status ${r.status}, mode ${mode}`;
});

console.log('\nGlobal catalogue & pools');

const coopRoute = await import(path.join(SITE, 'functions/api/coop/index.js'));
const getCoop = (qs = '') =>
  coopRoute.onRequestGet({ request: new Request(`https://x/api/coop?${qs}`), env });

sqlite.exec(`INSERT INTO coop_apps (appid, name, popularity_rank, max_players, max_players_src) VALUES
  (777001,'Verified Four',1,4,'manual'),
  (777002,'Unverified Cap',2,NULL,NULL),
  (777003,'Verified Two',3,2,'manual'),
  (777004,'100% Orange Juice',4,4,'manual')`);
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

await check('catalogue search treats % and _ as text, not SQL wildcards', async () => {
  const percent = await (await getCoop('q=%25')).json();
  const underscore = await (await getCoop('q=_')).json();
  return (percent.games.some((g) => g.appid === 777004)
      && percent.games.every((g) => g.name.includes('%'))
      && underscore.games.length === 0)
    || `percent=${percent.games.map((g) => g.name).join(',')} underscore=${underscore.games.length}`;
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

await check('manual game fields reject fractional caps and oversized text', async () => {
  const { data } = await ctxFor(ALICE, 'g4m1ng');
  const fractional = await gamesRoute.onRequestPost({
    request: req({ manual: true, name: 'Fractional cap', maxPlayers: 2.5 }), env, data });
  const oversized = await gamesRoute.onRequestPost({
    request: req({ manual: true, name: 'Huge genre', genre: 'x'.repeat(81) }), env, data });
  return (fractional.status === 400 && oversized.status === 400)
    || `fractional ${fractional.status}, oversized ${oversized.status}`;
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

await check('claim choices report how many ratings will move', async () => {
  const { data } = await ctxFor(NOBODY, 'g4m1ng');
  const body = await (await claimRoute.onRequestGet({ env, data })).json();
  const wrong = body.unclaimed.find((s) => {
    const expected = sqlite.prepare(
      `SELECT COUNT(*) AS n FROM ratings r JOIN games g ON g.id=r.game_id
        WHERE g.group_id=1 AND r.steam_id=?`).get(s.seedId).n;
    return s.ratings !== expected;
  });
  return !wrong || `${wrong.name} reports ${wrong.ratings}`;
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

console.log('\nExports, ownership & attendee ranking');

sqlite.exec(`INSERT INTO games
  (id, group_id, name, steam_appid, status, max_players, min_session_minutes, enriched_at, created_at)
  VALUES
  (8200,1,'Tonight Shortlist',982000,'backlog',4,60,100,100),
  (8201,1,'Tonight Too Small',982001,'backlog',1,180,100,100),
  (8202,1,'Tonight Duration Unknown',982002,'backlog',4,NULL,500,100),
  (8203,1,'Tonight Cap Unknown',982003,'backlog',NULL,60,100,100)`);
sqlite.exec(`INSERT OR REPLACE INTO ratings (game_id, steam_id, score) VALUES
  (8200,'${ALICE}',8),(8200,'${MALLORY}',9),(8200,'${LEO_REAL}',10),
  (8201,'${ALICE}',10),(8201,'${MALLORY}',10),
  (8202,'${ALICE}',9),(8203,'${ALICE}',9)`);
sqlite.exec(`INSERT OR REPLACE INTO playtime_sync (steam_id, games, played, synced_at) VALUES
  ('${ALICE}',100,50,2000),('${MALLORY}',100,50,1000)`);
sqlite.exec(`INSERT OR REPLACE INTO group_library_sync (group_id, steam_id, games, played, synced_at) VALUES
  (1,'${ALICE}',100,50,100),(1,'${MALLORY}',100,50,1000)`);
sqlite.exec(`INSERT OR REPLACE INTO playtime (steam_id, appid, minutes, fetched_at) VALUES
  ('${ALICE}',982000,0,100),('${MALLORY}',982000,0,100)`);

await check('ownership is true, false, or unknown — never guessed from stale data', async () => {
  const { data } = await ctxFor(ALICE, 'g4m1ng');
  const library = await (await gamesRoute.onRequestGet({ env, data })).json();
  const owned = library.games.find((game) => game.id === 8200).ownership;
  const stale = library.games.find((game) => game.id === 8202).ownership;
  return (owned[ALICE] === true && owned[MALLORY] === true && stale[ALICE] === null
      && stale[MALLORY] === false)
    || `owned=${JSON.stringify(owned)} stale=${JSON.stringify(stale)}`;
});

await check('attendee ranking uses only selected ratings and excludes only verified small caps', async () => {
  const { data } = await ctxFor(ALICE, 'g4m1ng');
  const r = await playNightRoute.onRequestPost({
    request: req({ attendees: [ALICE, MALLORY] }), env, data,
  });
  const result = await r.json();
  const short = result.games.find((game) => game.id === 8200);
  if (!short) return `short game missing: ${JSON.stringify(result.excluded)}`;
  if (short.score !== 8.5 || short.votes !== 2) return `attendee score ${short.score}/${short.votes}`;
  if (result.games.some((game) => game.id === 8201)) return 'a verified one-player game leaked in';
  if (!result.games.some((game) => game.id === 8202)) return 'missing session length was still treated as a gate';
  const unknown = result.games.find((game) => game.id === 8203);
  return (unknown?.playerCountVerified === false && result.excluded.tooFewPlayers > 0)
    || JSON.stringify({ unknown, excluded: result.excluded });
});

await check('attendee ranking supports a solo player', async () => {
  const { data } = await ctxFor(ALICE, 'g4m1ng');
  const r = await playNightRoute.onRequestPost({
    request: req({ attendees: [ALICE] }), env, data,
  });
  const result = await r.json();
  const short = result.games.find((game) => game.id === 8200);
  return (r.status === 200 && short?.score === 8 && short?.votes === 1)
    || `status ${r.status}, ${JSON.stringify(short)}`;
});

await check('attendee ranking rejects a player outside the group', async () => {
  const { data } = await ctxFor(ALICE, 'g4m1ng');
  const r = await playNightRoute.onRequestPost({
    request: req({ attendees: [ALICE, '76561198000000999'] }), env, data,
  });
  return r.status === 400 || `got ${r.status}`;
});

await check('session length accepts a real range and rejects invented values', async () => {
  const { data } = await ctxFor(ALICE, 'g4m1ng');
  const badPatch = await gameIdRoute.onRequestPatch({
    params: { id: '8200' }, request: req({ min_session_minutes: 7 }), env, data,
  });
  const goodPatch = await gameIdRoute.onRequestPatch({
    params: { id: '8200' }, request: req({ min_session_minutes: 75 }), env, data,
  });
  const value = sqlite.prepare('SELECT min_session_minutes FROM games WHERE id=8200').get().min_session_minutes;
  sqlite.exec('UPDATE games SET min_session_minutes=60 WHERE id=8200');
  return (badPatch.status === 400 && goodPatch.status === 200 && value === 75)
    || `bad ${badPatch.status}, good ${goodPatch.status}, value ${value}`;
});

sqlite.exec(`INSERT INTO games (id,group_id,name,status,max_players)
             VALUES (8250,1,'Two-person Argument','finished',4)`);
sqlite.exec(`INSERT OR REPLACE INTO ratings (game_id,steam_id,score) VALUES
             (8250,'${ALICE}',5),(8250,'${MALLORY}',9)`);

await check('Biggest arguments includes a real two-person disagreement', async () => {
  const { data } = await ctxFor(ALICE, 'g4m1ng');
  const r = await statsRoute.onRequestGet({ env, data });
  const result = await r.json();
  const argument = result.arguments.find((game) => game.id === 8250);
  return (r.status === 200 && argument?.spread === 4
      && Object.keys(argument.votes).length === 2)
    || `status ${r.status}, ${JSON.stringify(argument)}`;
});

sqlite.exec(`INSERT INTO games
  (id,group_id,name,status,release_date,hours_estimated,hours_participants,finished_estimated)
  VALUES
  (8300,1,'AAA History Fixture','finished','2 Feb, 2021',12.5,3,'2024-05-01'),
  (8301,2,'Foreign History','finished','3 Mar, 2022',8,2,'2024-06-01')`);
sqlite.exec(`INSERT OR REPLACE INTO ratings (game_id,steam_id,score) VALUES (8300,'${ALICE}',8)`);

await check('history suggestions use bounded evidence and leave moving facts alone', async () => {
  const epoch = (day) => Date.parse(`${day}T12:00:00Z`) / 1000;
  const games = [{
    id: 1, name: 'Finished', status: 'finished', steam_appid: 42,
    release_date: '2 Feb, 2021', hours_estimated: 12.5, hours_participants: 3,
    finished_estimated: '2024-03-01', my_rating: 8,
  }, {
    id: 2, name: 'Still playing', status: 'playing', steam_appid: 43,
    release_date: '3 Mar, 2022', hours_estimated: 20, hours_participants: 4,
    finished_estimated: '2024-04-01', my_rating: 7,
  }];
  const achievements = [{
    appid: 42,
    unlocked: JSON.stringify([
      { unlocktime: epoch('2021-03-01') }, { unlocktime: epoch('2024-04-01') },
    ]),
  }];
  const items = buildHistoryItems(games, achievements, [], Date.parse('2025-01-01T00:00:00Z'));
  const personalItems = buildHistoryItems(
    [{ ...games[0], my_minutes: 765 }], achievements, [], Date.parse('2025-01-01T00:00:00Z'),
    { mode: 'personal' }
  );
  const finished = Object.fromEntries(items.filter((item) => item.gameId === 1)
    .map((item) => [item.field, item.suggestion]));
  const personalHours = personalItems.find((item) => item.field === 'hours');
  const moving = items.filter((item) => item.gameId === 2).map((item) => item.field);
  return (finished.started?.source === 'achievement' && finished.started.value === '2021-03-01'
      && finished.hours?.source === 'steam-hours'
      && finished.finished?.source === 'achievement' && finished.finished.value === '2024-04-01'
      && personalHours?.suggestion?.value === 12.8
      && personalHours.prompt === 'Roughly how many hours did you play?'
      && moving.length === 1 && moving[0] === 'started')
    || JSON.stringify({ finished, personalHours, moving });
});

await check('history prompts are targeted and never leak another group', async () => {
  const { data } = await ctxFor(ALICE, 'g4m1ng');
  const view = await (await historyRoute.onRequestGet({ env, data })).json();
  const own = view.items.filter((item) => item.gameId === 8300);
  return (own.length >= 1 && own[0].likely && !view.items.some((item) => item.gameId === 8301))
    || `own ${own.length}, foreign ${view.items.some((item) => item.gameId === 8301)}`;
});

await check('a history suggestion cannot update a foreign game id', async () => {
  const { data } = await ctxFor(ALICE, 'g4m1ng');
  const r = await historyRoute.onRequestPost({
    request: req({ gameId: 8301, field: 'started', action: 'accept' }), env, data,
  });
  const row = sqlite.prepare('SELECT started FROM games WHERE id=8301').get();
  return (r.status === 404 && row.started == null) || `status ${r.status}, started ${row.started}`;
});

await check("'I don't know' is personal, not a group-wide dismissal", async () => {
  const alice = await ctxFor(ALICE, 'g4m1ng');
  const mallory = await ctxFor(MALLORY, 'g4m1ng');
  const r = await historyRoute.onRequestPost({
    request: req({ gameId: 8300, field: 'hours', action: 'dismiss' }), env, data: alice.data,
  });
  const mine = sqlite.prepare(
    'SELECT state FROM history_nudges WHERE group_id=1 AND game_id=8300 AND field=\'hours\' AND steam_id=?'
  ).get(ALICE);
  const theirs = sqlite.prepare(
    'SELECT state FROM history_nudges WHERE group_id=1 AND game_id=8300 AND field=\'hours\' AND steam_id=?'
  ).get(MALLORY);
  const r2 = await historyRoute.onRequestPost({
    request: req({ gameId: 8300, field: 'hours', action: 'dismiss' }), env, data: mallory.data,
  });
  return (r.status === 200 && mine?.state === 'dismissed' && !theirs && r2.status === 200)
    || `alice ${JSON.stringify(mine)}, mallory ${JSON.stringify(theirs)}, second ${r2.status}`;
});

await check('accepting history records the authoritative value and its provenance', async () => {
  const { data } = await ctxFor(ALICE, 'g4m1ng');
  const r = await historyRoute.onRequestPost({
    request: req({ gameId: 8300, field: 'started', action: 'accept', value: '2099-01-01' }), env, data,
  });
  const game = sqlite.prepare('SELECT started FROM games WHERE id=8300').get();
  const source = sqlite.prepare(
    'SELECT source,set_by FROM game_fact_sources WHERE group_id=1 AND game_id=8300 AND field=\'started\''
  ).get();
  return (r.status === 200 && game.started === '2021-02-02'
      && source.source === 'release-date' && source.set_by === ALICE)
    || `status ${r.status}, value ${game.started}, source ${JSON.stringify(source)}`;
});

await check('editing an approximate fact turns it into a human-entered fact', async () => {
  const { data } = await ctxFor(ALICE, 'g4m1ng');
  const r = await gameIdRoute.onRequestPatch({
    params: { id: '8300' }, request: req({ started: '2021-02-03' }), env, data,
  });
  const source = sqlite.prepare(
    'SELECT source,set_by FROM game_fact_sources WHERE group_id=1 AND game_id=8300 AND field=\'started\''
  ).get();
  return (r.status === 200 && source.source === 'manual' && source.set_by === ALICE)
    || `status ${r.status}, source ${JSON.stringify(source)}`;
});

await check('only an owner can export group data', async () => {
  const { data } = await ctxFor(MALLORY, 'g4m1ng');
  const r = await exportRoute.onRequestGet({
    request: getReq('https://x/api/g/g4m1ng/export?format=json'), env, data,
  });
  return r.status === 403 || `got ${r.status}`;
});

await check('JSON export is complete and never crosses the group boundary', async () => {
  const { data } = await ctxFor(ALICE, 'g4m1ng');
  const r = await exportRoute.onRequestGet({
    request: getReq('https://x/api/g/g4m1ng/export?format=json'), env, data,
  });
  const backup = await r.json();
  if (!r.headers.get('content-disposition')?.includes('.json')) return 'missing attachment filename';
  if (!backup.games.some((game) => game.id === 8200)) return 'own game missing';
  if (backup.games.some((game) => game.group_id !== 1)) return 'foreign game exported';
  if (backup.comments.some((comment) => comment.group_id !== 1)) return 'foreign comment exported';
  return (Array.isArray(backup.history) && Array.isArray(backup.ratings)
      && Array.isArray(backup.members) && backup.version === 2)
    || 'missing a relation';
});

await check('CSV export is one valid relation and neutralises spreadsheet formulas', async () => {
  sqlite.exec(`INSERT INTO comments (group_id, game_id, steam_id, body)
               VALUES (1,8200,'${ALICE}','=HYPERLINK(""https://bad"",""click"")')`);
  const { data } = await ctxFor(ALICE, 'g4m1ng');
  const r = await exportRoute.onRequestGet({
    request: getReq('https://x/api/g/g4m1ng/export?format=csv&table=comments'), env, data,
  });
  const csv = await r.text();
  return (r.headers.get('content-type')?.startsWith('text/csv') && csv.includes("'=HYPERLINK"))
    || `type ${r.headers.get('content-type')}, body ${csv.slice(-120)}`;
});

await check('achievement relay reads cached progress only for this group game', async () => {
  sqlite.exec(`INSERT OR REPLACE INTO achievement_progress
    (steam_id, appid, achieved, total, unlocked, fetched_at) VALUES
    ('${ALICE}',982000,1,2,'[{"key":"first","name":"First Night","unlocktime":123}]',100)`);
  const { data } = await ctxFor(ALICE, 'g4m1ng');
  const r = await achievementsRoute.onRequestGet({
    request: getReq('https://x/api/g/g4m1ng/achievements?gameId=8200'), env, data,
  });
  const view = await r.json();
  const mine = view.members.find((member) => member.steamId === ALICE);
  return (r.status === 200 && view.supported && mine.achieved === 1 && view.relay.unlocked === 1)
    || `status ${r.status}, ${JSON.stringify(view)}`;
});

await check('achievement sync fetches and stores only the signed-in member', async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = env.STEAM_API_KEY;
  env.STEAM_API_KEY = 'test-key';
  globalThis.fetch = async (url) => {
    if (!String(url).includes('/ISteamUserStats/GetPlayerAchievements/')) {
      throw new Error(`unexpected fetch ${url}`);
    }
    return new Response(JSON.stringify({
      playerstats: {
        success: true,
        gameName: 'Tonight Shortlist',
        achievements: [
          { apiname: 'first', name: 'First Night', achieved: 1, unlocktime: 456 },
          { apiname: 'later', name: 'Another Night', achieved: 0, unlocktime: 0 },
        ],
      },
    }), { headers: { 'content-type': 'application/json' } });
  };
  try {
    const { data } = await ctxFor(ALICE, 'g4m1ng');
    const r = await achievementsRoute.onRequestPost({
      request: req({ gameId: 8200 }), env, data,
    });
    const row = sqlite.prepare(
      'SELECT achieved, total, unlocked FROM achievement_progress WHERE steam_id=? AND appid=?'
    ).get(ALICE, 982000);
    const unlocked = JSON.parse(row?.unlocked || '[]');
    return (r.status === 200 && row?.achieved === 1 && row?.total === 2
        && unlocked.length === 1 && unlocked[0].key === 'first')
      || `status ${r.status}, row ${JSON.stringify(row)}`;
  } finally {
    env.STEAM_API_KEY = originalKey;
    globalThis.fetch = originalFetch;
  }
});

await check('achievement sync preserves private errors and falls back when the keyed endpoint refuses one app', async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = env.STEAM_API_KEY;
  env.STEAM_API_KEY = 'test-key';
  let publicHost = false;
  let fallback = false;
  globalThis.fetch = async (url) => {
    publicHost = String(url).startsWith('https://api.steampowered.com/');
    if (fallback && publicHost) {
      return new Response(null, { status: 403 });
    }
    if (fallback && String(url).startsWith('https://steamcommunity.com/profiles/')) {
      return new Response(`<?xml version="1.0"?><playerstats>
        <privacyState>public</privacyState>
        <game><gameName><![CDATA[Tonight Shortlist]]></gameName></game>
        <achievements>
          <achievement closed="1"><name>First &amp; Night</name><apiname>first</apiname>
            <unlockTimestamp>456</unlockTimestamp></achievement>
          <achievement closed="0"><name>Another Night</name><apiname>later</apiname></achievement>
        </achievements>
      </playerstats>`, { headers: { 'content-type': 'application/xml' } });
    }
    return new Response(JSON.stringify({
      playerstats: { success: false, error: 'Profile is not public' },
    }), { status: 400, headers: { 'content-type': 'application/json' } });
  };
  try {
    const { data } = await ctxFor(ALICE, 'g4m1ng');
    const privateResponse = await achievementsRoute.onRequestPost({
      request: req({ gameId: 8200 }), env, data,
    });
    const privateResult = await privateResponse.json();
    if (privateResponse.status !== 409 || !publicHost || privateResult.error !== 'Profile is not public') {
      return `private status ${privateResponse.status}, host ${publicHost}, ${JSON.stringify(privateResult)}`;
    }

    fallback = true;
    const fallbackResponse = await achievementsRoute.onRequestPost({
      request: req({ gameId: 8200 }), env, data,
    });
    const row = sqlite.prepare(
      'SELECT achieved, total, unlocked FROM achievement_progress WHERE steam_id=? AND appid=?'
    ).get(ALICE, 982000);
    const unlocked = JSON.parse(row?.unlocked || '[]');
    return (fallbackResponse.status === 200 && row?.achieved === 1 && row?.total === 2
        && unlocked[0]?.name === 'First & Night' && unlocked[0]?.unlocktime === 456)
      || `fallback status ${fallbackResponse.status}, row ${JSON.stringify(row)}`;
  } finally {
    env.STEAM_API_KEY = originalKey;
    globalThis.fetch = originalFetch;
  }
});

await check('achievement progress cannot be read through a foreign game id', async () => {
  const { data } = await ctxFor(ALICE, 'g4m1ng');
  const r = await achievementsRoute.onRequestGet({
    request: getReq('https://x/api/g/g4m1ng/achievements?gameId=5000'), env, data,
  });
  return r.status === 404 || `got ${r.status}`;
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

await check('the group switcher does not count archived games', async () => {
  const body = await (await groupsRoute.onRequestGet({ env, data: { user: user(ALICE) } })).json();
  const group = body.groups.find((g) => g.slug === 'g4m1ng');
  const expectedGames = sqlite.prepare(
    'SELECT COUNT(*) AS n FROM games WHERE group_id=1 AND archived_at IS NULL').get().n;
  const expectedUnrated = sqlite.prepare(
    `SELECT COUNT(*) AS n FROM games g
      WHERE g.group_id=1 AND g.archived_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM ratings r WHERE r.game_id=g.id AND r.steam_id=?)
        AND NOT EXISTS (SELECT 1 FROM skips s WHERE s.game_id=g.id AND s.steam_id=?)`
  ).get(ALICE, ALICE).n;
  return (group?.games === expectedGames && group?.unrated === expectedUnrated)
    || `games ${group?.games}/${expectedGames}, unrated ${group?.unrated}/${expectedUnrated}`;
});

await check('member coverage does not count ratings on archived games', async () => {
  const { data } = await ctxFor(ALICE, 'g4m1ng');
  const body = await (await membersRoute.onRequestGet({ env, data })).json();
  const mine = body.members.find((m) => m.steam_id === ALICE);
  const expected = sqlite.prepare(
    `SELECT COUNT(*) AS n FROM ratings r JOIN games g ON g.id=r.game_id
      WHERE r.steam_id=? AND g.group_id=1 AND g.archived_at IS NULL`).get(ALICE).n;
  return mine?.ratings === expected || `reported ${mine?.ratings}, expected ${expected}`;
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

console.log('\nPlay dates');

await check('start and end dates can be set by hand', async () => {
  const { data } = await ctxFor(ALICE, 'g4m1ng');
  const g = sqlite.prepare('SELECT id FROM games WHERE group_id=1 LIMIT 1 OFFSET 9').get();
  const r = await gameIdRoute.onRequestPatch({
    params: { id: String(g.id) },
    request: req({ started: '2025-03-14', finished: '2025-06-02' }), env, data });
  const row = sqlite.prepare('SELECT started, finished FROM games WHERE id=?').get(g.id);
  return (r.status === 200 && row.started === '2025-03-14' && row.finished === '2025-06-02')
    || `status ${r.status}, got ${JSON.stringify(row)}`;
});

await check('impossible calendar dates are refused', async () => {
  const { data } = await ctxFor(ALICE, 'g4m1ng');
  const g = sqlite.prepare('SELECT id FROM games WHERE group_id=1 LIMIT 1').get();
  const r = await gameIdRoute.onRequestPatch({
    params: { id: String(g.id) }, request: req({ started: '2025-02-29' }), env, data });
  return r.status === 400 || `expected 400, got ${r.status}`;
});

await check('a typed end date always beats the Steam estimate', async () => {
  /* Same rule as hours: `finished` is what a human said, `finished_estimated` is
     derived from rtime_last_played. Recomputing must never clobber the typed one. */
  const playtime = await import(path.join(SITE, 'functions/api/g/[slug]/playtime.js'));
  const g = sqlite.prepare(
    'SELECT id, steam_appid FROM games WHERE group_id=1 AND steam_appid IS NOT NULL LIMIT 1').get();
  sqlite.prepare("UPDATE games SET finished='2020-01-01' WHERE id=?").run(g.id);
  await playtime.recomputeEstimates(env, 1);
  const row = sqlite.prepare('SELECT finished FROM games WHERE id=?').get(g.id);
  return row.finished === '2020-01-01' || `estimate overwrote the typed date: ${row.finished}`;
});

await check('the end estimate is the LAST participant to stop, not the first', async () => {
  /* Hours take a minimum — you cannot all have played together longer than whoever
     played least. The end date is the opposite: the group stopped when the last of
     them did. Getting these the same way round would be the bug. */
  const playtime = await import(path.join(SITE, 'functions/api/g/[slug]/playtime.js'));
  const g = sqlite.prepare(
    'SELECT id, steam_appid FROM games WHERE group_id=1 AND steam_appid IS NOT NULL LIMIT 1 OFFSET 1').get();
  const who = sqlite.prepare(
    'SELECT steam_id FROM memberships WHERE group_id=1 AND is_seed=0 LIMIT 2').all();
  if (who.length < 2) return 'fixture: need two real members';
  const early = Math.floor(Date.UTC(2024, 4, 1) / 1000);   // 2024-05-01
  const late  = Math.floor(Date.UTC(2024, 8, 9) / 1000);   // 2024-09-09
  sqlite.prepare("UPDATE games SET finished=NULL WHERE id=?").run(g.id);
  for (const [i, m] of who.entries()) {
    sqlite.prepare(`INSERT INTO playtime (steam_id, appid, minutes, last_played)
                    VALUES (?,?,?,?)
                    ON CONFLICT(steam_id, appid) DO UPDATE SET
                      minutes=excluded.minutes, last_played=excluded.last_played`)
      .run(m.steam_id, g.steam_appid, 600, i === 0 ? early : late);
  }
  await playtime.recomputeEstimates(env, 1);
  const row = sqlite.prepare('SELECT finished_estimated FROM games WHERE id=?').get(g.id);
  return row.finished_estimated === '2024-09-09'
    || `expected the later date 2024-09-09, got ${row.finished_estimated}`;
});

await check('one participant is enough for an end date, unlike hours', async () => {
  /* Forced by Steam: rtime_last_played comes back only for the account owning the
     API key, so a two-person floor would make this permanently null. It is labelled
     as "the latest date Steam will tell us", not as the group's finish date. */
  const playtime = await import(path.join(SITE, 'functions/api/g/[slug]/playtime.js'));
  const g = sqlite.prepare(
    'SELECT id, steam_appid FROM games WHERE group_id=1 AND steam_appid IS NOT NULL LIMIT 1 OFFSET 2').get();
  const who = sqlite.prepare(
    'SELECT steam_id FROM memberships WHERE group_id=1 AND is_seed=0 LIMIT 1').get();
  // Exactly one participant, so the contrast with hours is the thing being tested.
  sqlite.prepare('DELETE FROM playtime WHERE appid=?').run(g.steam_appid);
  sqlite.prepare('INSERT INTO playtime (steam_id, appid, minutes, last_played) VALUES (?,?,?,?)')
    .run(who.steam_id, g.steam_appid, 900, Math.floor(Date.UTC(2024, 1, 2) / 1000));
  await playtime.recomputeEstimates(env, 1);
  const row = sqlite.prepare('SELECT finished_estimated, hours_estimated FROM games WHERE id=?').get(g.id);
  // The date is set from one player; the HOURS estimate still refuses to be.
  return (row.finished_estimated === '2024-02-02' && row.hours_estimated === 0)
    || `date ${row.finished_estimated}, hours ${row.hours_estimated}`;
});

console.log('\nRe-rating');

await check('rating the same game twice replaces the score, it does not duplicate', async () => {
  const { data } = await ctxFor(ALICE, 'g4m1ng');
  const g = sqlite.prepare('SELECT id FROM games WHERE group_id=1 LIMIT 1 OFFSET 11').get();
  await rateRoute.onRequestPost({ request: req({ gameId: g.id, score: 4 }), env, data });
  await rateRoute.onRequestPost({ request: req({ gameId: g.id, score: 9 }), env, data });
  const rows = sqlite.prepare('SELECT score FROM ratings WHERE game_id=? AND steam_id=?').all(g.id, ALICE);
  sqlite.prepare('DELETE FROM ratings WHERE game_id=? AND steam_id=?').run(g.id, ALICE);
  return (rows.length === 1 && rows[0].score === 9) || `got ${JSON.stringify(rows)}`;
});

console.log('\nAdded-by attribution');

await check('an adder can be set, and it is reported with the library', async () => {
  const { data } = await ctxFor(ALICE, 'g4m1ng');
  const g = sqlite.prepare('SELECT id FROM games WHERE group_id=1 LIMIT 1').get();
  const r = await gameIdRoute.onRequestPatch({
    params: { id: String(g.id) }, request: req({ added_by: ALICE }), env, data });
  const body = await (await gamesRoute.onRequestGet({ env, data })).json();
  return (r.status === 200 && body.games.find((x) => x.id === g.id).added_by === ALICE)
    || `status ${r.status}`;
});

await check('it can be cleared back to unknown', async () => {
  const { data } = await ctxFor(ALICE, 'g4m1ng');
  const g = sqlite.prepare('SELECT id FROM games WHERE group_id=1 LIMIT 1').get();
  await gameIdRoute.onRequestPatch({
    params: { id: String(g.id) }, request: req({ added_by: null }), env, data });
  const row = sqlite.prepare('SELECT added_by FROM games WHERE id=?').get(g.id);
  return row.added_by === null || `still ${row.added_by}`;
});

await check('an account outside the group cannot be written in as the adder', async () => {
  /* added_by is rendered as a name, so an unchecked value would let a member paint
     an arbitrary SteamID64 — or another group's member — onto their own rows. */
  const { data } = await ctxFor(ALICE, 'g4m1ng');
  const g = sqlite.prepare('SELECT id FROM games WHERE group_id=1 LIMIT 1').get();
  const r = await gameIdRoute.onRequestPatch({
    params: { id: String(g.id) }, request: req({ added_by: '76561190000000999' }), env, data });
  const row = sqlite.prepare('SELECT added_by FROM games WHERE id=?').get(g.id);
  return (r.status === 400 && row.added_by === null) || `status ${r.status}, stored ${row.added_by}`;
});

console.log('\nStatuses');

await check('"unfinished" is accepted as a status', async () => {
  const { data } = await ctxFor(ALICE, 'g4m1ng');
  const g = sqlite.prepare('SELECT id FROM games WHERE group_id=1 LIMIT 1 OFFSET 7').get();
  const r = await gameIdRoute.onRequestPatch({
    params: { id: String(g.id) }, request: req({ status: 'unfinished' }), env, data });
  const row = sqlite.prepare('SELECT status FROM games WHERE id=?').get(g.id);
  return (r.status === 200 && row.status === 'unfinished') || `status ${r.status}, stored ${row.status}`;
});

await check('a status outside the list is still refused', async () => {
  const { data } = await ctxFor(ALICE, 'g4m1ng');
  const g = sqlite.prepare('SELECT id FROM games WHERE group_id=1 LIMIT 1 OFFSET 8').get();
  const before = sqlite.prepare('SELECT status FROM games WHERE id=?').get(g.id).status;
  const r = await gameIdRoute.onRequestPatch({
    params: { id: String(g.id) }, request: req({ status: 'nearly-done' }), env, data });
  const after = sqlite.prepare('SELECT status FROM games WHERE id=?').get(g.id).status;
  return (r.status === 400 && after === before) || `status ${r.status}, ${before} -> ${after}`;
});

await check('a game you failed to finish counts as played, not as backlog', async () => {
  /* It belongs in the "how good was it?" queue and in the played-games stats — you
     have an opinion on a game you got most of the way through. The stats module's
     PLAYED set is the server-side half of that; PLAYED_STATUS in app.js is the half
     that decides which rating queue the card lands in. */
  const stats = await import(path.join(SITE, 'functions/api/g/[slug]/stats.js'));
  const { data } = await ctxFor(ALICE, 'g4m1ng');
  const g = sqlite.prepare(
    "SELECT id, name FROM games WHERE group_id=1 AND id IN (SELECT game_id FROM ratings) LIMIT 1").get();

  sqlite.prepare("UPDATE games SET status='backlog' WHERE id=?").run(g.id);
  const asBacklog = (await (await stats.onRequestGet({ env, data })).json()).totals.backlog;
  sqlite.prepare("UPDATE games SET status='unfinished' WHERE id=?").run(g.id);
  const asUnfinished = (await (await stats.onRequestGet({ env, data })).json()).totals.backlog;

  return asUnfinished === asBacklog - 1
    || `backlog count ${asBacklog} -> ${asUnfinished}, expected one fewer`;
});

console.log('\n"I didn\'t play this"');

const skipRoute = await import(path.join(SITE, 'functions/api/g/[slug]/skip.js'));

await check('"no opinion" and "didn\'t play" both leave the queue', async () => {
  const { data } = await ctxFor(ALICE, 'g4m1ng');
  const g = sqlite.prepare('SELECT id FROM games WHERE group_id=1 LIMIT 1').get();
  await skipRoute.onRequestPost({ request: req({ gameId: g.id, notPlayed: true }), env, data });
  const q = await (await skipRoute.onRequestGet({ env, data })).json();
  return !q.queue.includes(g.id) || 'a game marked not-played stayed in the queue';
});

await check('they are stored as different answers, not the same one', async () => {
  const { data } = await ctxFor(ALICE, 'g4m1ng');
  const [a, b] = sqlite.prepare('SELECT id FROM games WHERE group_id=1 LIMIT 2 OFFSET 1').all();
  await skipRoute.onRequestPost({ request: req({ gameId: a.id, notPlayed: true }), env, data });
  await skipRoute.onRequestPost({ request: req({ gameId: b.id }), env, data });
  const rows = sqlite.prepare(
    'SELECT game_id, not_played FROM skips WHERE steam_id=? AND game_id IN (?,?)').all(ALICE, a.id, b.id);
  const byId = Object.fromEntries(rows.map((r) => [r.game_id, r.not_played]));
  return (byId[a.id] === 1 && byId[b.id] === 0) || `got ${JSON.stringify(byId)}`;
});

await check('a mis-click is fixable — re-posting updates the flag', async () => {
  const { data } = await ctxFor(ALICE, 'g4m1ng');
  const g = sqlite.prepare('SELECT id FROM games WHERE group_id=1 LIMIT 1 OFFSET 3').get();
  await skipRoute.onRequestPost({ request: req({ gameId: g.id, notPlayed: true }), env, data });
  await skipRoute.onRequestPost({ request: req({ gameId: g.id, notPlayed: false }), env, data });
  const row = sqlite.prepare('SELECT not_played FROM skips WHERE steam_id=? AND game_id=?').get(ALICE, g.id);
  return row.not_played === 0 || `stuck at ${row.not_played}`;
});

await check('a game you sat out leaves YOUR coverage denominator', async () => {
  /* The whole point of the distinction. Alice's percentage must rise when a game
     she did not play is excluded, while the group's game count is unchanged. */
  const { data } = await ctxFor(ALICE, 'g4m1ng');
  sqlite.exec(`DELETE FROM skips WHERE steam_id='${ALICE}'`);
  // Alice needs a numerator: at 0 ratings the percentage is 0 whatever the
  // denominator does, which would let a broken implementation pass.
  const rated = sqlite.prepare(
    'SELECT id FROM games WHERE group_id=1 AND archived_at IS NULL LIMIT 20').all();
  for (const g of rated) {
    sqlite.prepare('INSERT OR IGNORE INTO ratings (game_id, steam_id, score) VALUES (?,?,8)')
      .run(g.id, ALICE);
  }
  const before = (await (await statsRoute.onRequestGet({ env, data })).json())
    .people.find((p) => p.steamId === ALICE);

  const unrated = sqlite.prepare(
    `SELECT id FROM games WHERE group_id=1 AND archived_at IS NULL
       AND id NOT IN (SELECT game_id FROM ratings WHERE steam_id=?) LIMIT 12`).all(ALICE);
  for (const g of unrated) {
    await skipRoute.onRequestPost({ request: req({ gameId: g.id, notPlayed: true }), env, data });
  }
  const after = (await (await statsRoute.onRequestGet({ env, data })).json())
    .people.find((p) => p.steamId === ALICE);

  sqlite.exec(`DELETE FROM skips WHERE steam_id='${ALICE}'`);
  sqlite.exec(`DELETE FROM ratings WHERE steam_id='${ALICE}'`);
  return (after.coverage > before.coverage && after.count === before.count
          && after.notPlayed === unrated.length)
    || `coverage ${before.coverage}->${after.coverage}, count ${before.count}->${after.count}, notPlayed ${after.notPlayed}`;
});

await check('"no opinion" does NOT change the denominator', async () => {
  // It means "I was there and have nothing to say", which is still unrated.
  const { data } = await ctxFor(ALICE, 'g4m1ng');
  sqlite.exec(`DELETE FROM skips WHERE steam_id='${ALICE}'`);
  const before = (await (await statsRoute.onRequestGet({ env, data })).json())
    .people.find((p) => p.steamId === ALICE);
  const unrated = sqlite.prepare(
    `SELECT id FROM games WHERE group_id=1 AND archived_at IS NULL
       AND id NOT IN (SELECT game_id FROM ratings WHERE steam_id=?) LIMIT 12`).all(ALICE);
  for (const g of unrated) {
    await skipRoute.onRequestPost({ request: req({ gameId: g.id }), env, data });
  }
  const after = (await (await statsRoute.onRequestGet({ env, data })).json())
    .people.find((p) => p.steamId === ALICE);
  sqlite.exec(`DELETE FROM skips WHERE steam_id='${ALICE}'`);
  return after.coverage === before.coverage || `coverage moved ${before.coverage}->${after.coverage}`;
});

await check('a skipped game stays reachable — it reports MY skip back to me', async () => {
  /* The bug this exists to stop: skipping took a game out of the queue, and with no
     rating it was in no other list either, so it became unreachable and the skip
     could never be undone. Subnautica 2 sat like that in production. */
  const { data } = await ctxFor(ALICE, 'g4m1ng');
  const g = sqlite.prepare('SELECT id FROM games WHERE group_id=1 LIMIT 1 OFFSET 13').get();
  await skipRoute.onRequestPost({ request: req({ gameId: g.id }), env, data });

  const q = await (await skipRoute.onRequestGet({ env, data })).json();
  const lib = await (await gamesRoute.onRequestGet({ env, data })).json();
  const row = lib.games.find((x) => x.id === g.id);
  return (!q.queue.includes(g.id) && row.mySkip === 'no-opinion')
    || `inQueue ${q.queue.includes(g.id)}, mySkip ${row.mySkip}`;
});

await check('the two kinds of skip are distinguishable to the person who made them', async () => {
  const { data } = await ctxFor(ALICE, 'g4m1ng');
  const g = sqlite.prepare('SELECT id FROM games WHERE group_id=1 LIMIT 1 OFFSET 14').get();
  await skipRoute.onRequestPost({ request: req({ gameId: g.id, notPlayed: true }), env, data });
  const lib = await (await gamesRoute.onRequestGet({ env, data })).json();
  return lib.games.find((x) => x.id === g.id).mySkip === 'not-played'
    || `got ${lib.games.find((x) => x.id === g.id).mySkip}`;
});

await check('un-skipping puts it back in the queue', async () => {
  const { data } = await ctxFor(ALICE, 'g4m1ng');
  const g = sqlite.prepare('SELECT id FROM games WHERE group_id=1 LIMIT 1 OFFSET 15').get();
  await skipRoute.onRequestPost({ request: req({ gameId: g.id }), env, data });
  await skipRoute.onRequestDelete({ request: req({ gameId: g.id }), env, data });
  const q = await (await skipRoute.onRequestGet({ env, data })).json();
  const lib = await (await gamesRoute.onRequestGet({ env, data })).json();
  return (q.queue.includes(g.id) && lib.games.find((x) => x.id === g.id).mySkip === null)
    || 'still skipped';
});

await check('rating a skipped game clears the skip, so it cannot be in both lists', async () => {
  const { data } = await ctxFor(ALICE, 'g4m1ng');
  const g = sqlite.prepare('SELECT id FROM games WHERE group_id=1 LIMIT 1 OFFSET 16').get();
  await skipRoute.onRequestPost({ request: req({ gameId: g.id }), env, data });
  await rateRoute.onRequestPost({ request: req({ gameId: g.id, score: 7 }), env, data });
  const lib = await (await gamesRoute.onRequestGet({ env, data })).json();
  const row = lib.games.find((x) => x.id === g.id);
  sqlite.prepare('DELETE FROM ratings WHERE game_id=? AND steam_id=?').run(g.id, ALICE);
  return (row.mySkip === null && row.votes[ALICE] === 7) || `mySkip ${row.mySkip}, vote ${row.votes[ALICE]}`;
});

await check('one person\'s skip is never reported as another\'s', async () => {
  // mySkip is answered for the caller only; MALLORY must not see ALICE's skips.
  const g = sqlite.prepare('SELECT id FROM games WHERE group_id=1 LIMIT 1 OFFSET 17').get();
  const a = await ctxFor(ALICE, 'g4m1ng');
  await skipRoute.onRequestPost({ request: req({ gameId: g.id }), env, data: a.data });
  const m = await ctxFor(MALLORY, 'g4m1ng');
  const lib = await (await gamesRoute.onRequestGet({ env, data: m.data })).json();
  return lib.games.find((x) => x.id === g.id).mySkip === null
    || 'leaked another member\'s skip';
});

await check('cannot mark a game in another group as not played', async () => {
  const { data } = await ctxFor(ALICE, 'g4m1ng');
  const r = await skipRoute.onRequestPost({ request: req({ gameId: 5000, notPlayed: true }), env, data });
  const leaked = sqlite.prepare('SELECT COUNT(*) AS n FROM skips WHERE game_id=5000').get().n;
  return (r.status === 404 && leaked === 0) || `status ${r.status}, rows ${leaked}`;
});

await check('the library reports who sat each game out', async () => {
  const { data } = await ctxFor(ALICE, 'g4m1ng');
  const g = sqlite.prepare('SELECT id FROM games WHERE group_id=1 LIMIT 1 OFFSET 5').get();
  await skipRoute.onRequestPost({ request: req({ gameId: g.id, notPlayed: true }), env, data });
  const body = await (await gamesRoute.onRequestGet({ env, data })).json();
  const row = body.games.find((x) => x.id === g.id);
  sqlite.exec(`DELETE FROM skips WHERE steam_id='${ALICE}'`);
  return row.notPlayed.includes(ALICE) || `notPlayed was ${JSON.stringify(row.notPlayed)}`;
});

console.log('\nBlind rating (an owner-only group rule)');

await check('blind rating is off by default', async () => {
  const { data } = await ctxFor(ALICE, 'g4m1ng');
  const r = await membersRoute.onRequestGet({ env, data });
  const b = (await r.json()).group.blindRating;
  return b === false || `default was ${b}`;
});

await check('the owner can turn blind rating on', async () => {
  const { data } = await ctxFor(ALICE, 'g4m1ng');
  const r = await membersRoute.onRequestPatch({ request: req({ blindRating: true }), env, data });
  const row = sqlite.prepare('SELECT blind_rating FROM groups WHERE id=1').get();
  return (r.status === 200 && row.blind_rating === 1) || `status ${r.status}, col ${row.blind_rating}`;
});

await check('a plain member cannot change blind rating', async () => {
  // Mallory joined group 1 in the invite tests above, as a member and not an owner.
  const { data } = await ctxFor(MALLORY, 'g4m1ng');
  const before = sqlite.prepare('SELECT blind_rating FROM groups WHERE id=1').get().blind_rating;
  const r = await membersRoute.onRequestPatch({ request: req({ blindRating: false }), env, data });
  const after = sqlite.prepare('SELECT blind_rating FROM groups WHERE id=1').get().blind_rating;
  return (r.status === 403 && after === before) || `status ${r.status}, ${before} -> ${after}`;
});

console.log('\nCo-op classification');

const { classifyCoop, parseStoreTags } = await import(path.join(SITE, 'lib/coop.js'));
/* Real tag orders, as Steam lists them. The first four games are the regression: an
   earlier rule required a co-op tag in the top 5 and classified all of them as NOT
   co-op, which hid most of this group's own library behind a filter that defaults
   to on. The PvP cases are the other half — a rule that keeps everything is no
   filter at all. */
const CLASSIFY = [
  ['Terraria', 1, ['Open World Survival Craft', 'Sandbox', 'Survival', '2D', 'Multiplayer', 'Pixel Graphics', 'Adventure']],
  ['Stardew Valley', 1, ['Farming Sim', 'Pixel Graphics', 'Multiplayer', 'Life Sim', 'RPG', 'Relaxing']],
  ['ELDEN RING', 1, ['Souls-like', 'Open World', 'Dark Fantasy', 'RPG', 'Difficult', 'Action RPG']],
  ["Baldur's Gate 3", 1, ['RPG', 'Character Customization', 'Choices Matter', 'Story Rich', 'Turn-Based Combat', 'Co-op']],
  ['Deep Rock Galactic', 1, ['Dwarf', 'Co-op', 'PvE', 'FPS', 'Procedural Generation', 'Class-Based']],
  ['PEAK', 1, ['Multiplayer', 'Online Co-Op', 'Co-op', 'Physics', 'Adventure', 'Exploration', 'First-Person']],
  ['Overwatch 2', 0, ['Free to Play', 'Hero Shooter', 'FPS', 'Multiplayer', 'Team-Based', 'First-Person']],
  ['Rainbow Six Siege', 0, ['FPS', 'PvP', 'Multiplayer', 'Shooter', 'Tactical', 'eSports']],
  ['Counter-Strike 2', 0, ['FPS', 'Shooter', 'Multiplayer', 'Competitive', 'Action', 'Team-Based']],
  ['Apex Legends', 0, ['Free to Play', 'Multiplayer', 'Battle Royale', 'FPS', 'Shooter', 'First-Person']],
  ['THE FINALS', 0, ['Destruction', 'Free to Play', 'FPS', 'Multiplayer', 'Shooter', 'PvP', 'Team-Based']],
];

for (const [name, want, tags] of CLASSIFY) {
  await check(`${name} classifies as ${want ? 'co-op' : 'PvP'}`, async () => {
    const got = classifyCoop(tags);
    return got === !!want || `got ${got}`;
  });
}

await check('a PvP tag past the window is an optional mode, not the genre', async () => {
  /* Rust tags PvP at 7 and Destiny 2 at 9, and this group plays both co-operatively.
     Widening the window to catch them would be the old bug in the other direction. */
  const rust = ['Survival', 'Crafting', 'Multiplayer', 'Open World', 'Open World Survival Craft', 'Building', 'PvP'];
  const destiny = ['Free to Play', 'Open World', 'Looter Shooter', 'Multiplayer', 'MMORPG', 'FPS', 'Co-op', 'Adventure', 'PvP'];
  return (classifyCoop(rust) && classifyCoop(destiny)) || 'excluded on a PvP tag past rank 6';
});

console.log('\nStore-page tag parsing');

await check('tags come out of a store page in Steam\'s own order', async () => {
  // The real markup shape, down to the inline `style` that broke a first attempt.
  const html = `<div class="glance_tags_label">Popular user-defined tags:</div>
    <div class="glance_tags popular_tags" data-appid="105600">
    <a href="/tags/en/Sandbox/" class="app_tag" style="display: none;"> Sandbox </a>
    <a href="/tags/en/Survival/" class="app_tag"> Survival </a>
    <a href="/tags/en/Co-op/" class="app_tag"> Co-op </a></div>`;
  const got = parseStoreTags(html);
  return (JSON.stringify(got?.tags) === '["Sandbox","Survival","Co-op"]' && got.isCoop === true)
    || `got ${JSON.stringify(got)}`;
});

await check('a page with no tag block is unclassified, not "not co-op"', async () => {
  /* An age gate or a delisted app serves a page with no tags. The browse filter
     keeps NULLs visible, so returning a verdict here would hide real co-op games —
     and recording "no tags" would stop the crawler ever retrying the row. */
  return parseStoreTags('<html><body>Please enter your birth date</body></html>') === null
    || 'invented a verdict from a page with no tags';
});

await check('the tag list is capped, so one page cannot bloat a row', async () => {
  const many = Array.from({ length: 40 }, (_, i) => `<a class="app_tag"> Tag${i} </a>`).join('');
  const got = parseStoreTags(`<div class="glance_tags popular_tags">${many}</div>`, 12);
  return got.tags.length === 12 || `kept ${got.tags.length}`;
});

console.log('\nRecommendations');

const recommendRoute = await import(path.join(SITE, 'functions/api/g/[slug]/recommend.js'));
const { recommend } = await import(path.join(SITE, 'lib/recommend.js'));
const DAN = '76561198000000555';
const recReq = (qs = '') => new Request(`https://x/api/g/g4m1ng/recommend${qs}`);

await check('recommendations are group-scoped: a non-member never reaches them', async () => {
  // Same 404-not-403 boundary as everything else below /api/g/:slug.
  const { passed, out } = await ctxFor(MALLORY, 'carols');
  return (!passed && out.status === 404) || `passed ${passed}, status ${out?.status}`;
});

await check('a thin history is reported as popularity, not dressed up as taste', async () => {
  const out = recommend(
    [{ appid: 1, popularity_rank: 2, tags: '["Survival"]' },
     { appid: 2, popularity_rank: 1, tags: '["RPG"]' }],
    [{ appid: 9, score: 8 }],                       // one rated game, below MIN_HISTORY
    new Map([[9, ['Survival']]]),
  );
  return (out.basis === 'popularity' && out.games[0].appid === 2)
    || `basis ${out.basis}, first ${out.games[0]?.appid}`;
});

await check('tags the group rates highly rank above tags it rates poorly', async () => {
  // Three games per tag: TAG_MIN_GAMES is 3, because at 2 a coincidence reads as
  // a taste — "Early Access" scored +0.51 off three games on real data.
  const history = [
    { appid: 11, score: 9 }, { appid: 12, score: 9 }, { appid: 13, score: 9 },  // Survival: loved
    { appid: 14, score: 3 }, { appid: 15, score: 3 }, { appid: 16, score: 3 },  // Racing: disliked
    { appid: 17, score: 6 },
  ];
  const tagsFor = new Map([
    [11, ['Survival']], [12, ['Survival']], [13, ['Survival']],
    [14, ['Racing']], [15, ['Racing']], [16, ['Racing']], [17, ['Puzzle']],
  ]);
  const out = recommend(
    [{ appid: 1, name: 'a racer', review_count: 5e5, tags: '["Racing"]' },
     { appid: 2, name: 'a survival game', review_count: 10, tags: '["Survival"]' }],
    history, tagsFor,
  );
  // Note the review counts: the racer is far more popular, so this also asserts
  // popularity cannot overturn a real taste signal.
  return (out.basis === 'taste' && out.games[0].appid === 2 && out.games[0].why[0] === 'Survival')
    || `first ${out.games[0]?.appid}, why ${JSON.stringify(out.games[0]?.why)}`;
});

await check('a tag on fewer than three games cannot define a taste', async () => {
  // Two games is a coincidence, not a preference — see TAG_MIN_GAMES.
  const history = [
    { appid: 11, score: 9 }, { appid: 12, score: 9 }, { appid: 13, score: 5 },
    { appid: 14, score: 5 }, { appid: 15, score: 5 }, { appid: 16, score: 5 },
  ];
  const out = recommend(
    [{ appid: 1, tags: '["Roguelike"]' }],
    history,
    new Map([[11, ['Roguelike']], [12, ['Roguelike']],
             [13, ['X']], [14, ['X']], [15, ['X']], [16, ['X']]]),
  );
  return out.games[0].fit === null || `scored a two-game tag: ${out.games[0].fit}`;
});

await check('release state and price model are not tastes', async () => {
  /* "Early Access" was group 1's second-strongest preference (+0.51 off three
     games) and drove five of its top ten suggestions — a list of unreleased games
     nobody has heard of. It describes how a game ships, not how it plays. */
  const history = [
    { appid: 11, score: 9 }, { appid: 12, score: 9 }, { appid: 13, score: 9 },
    { appid: 14, score: 4 }, { appid: 15, score: 4 }, { appid: 16, score: 4 },
  ];
  const tags = ['Early Access', 'Free to Play'];
  const out = recommend(
    [{ appid: 1, tags: JSON.stringify(tags) }],
    history,
    new Map([[11, tags], [12, tags], [13, tags],
             [14, ['Puzzle']], [15, ['Puzzle']], [16, ['Puzzle']]]),
  );
  // "Puzzle" legitimately appears — it is a real tag on three rated games. The
  // assertion is that the two shipping-state tags do not, and that a candidate
  // carrying only those scores nothing at all.
  const named = [...out.likes, ...out.dislikes].map((l) => l.tag);
  const leaked = named.filter((t) => tags.includes(t));
  return (out.games[0].fit === null && !leaked.length)
    || `fit ${out.games[0].fit}, stoplisted tags surfaced: ${JSON.stringify(leaked)}`;
});

await check('a rare tag outweighs several common ones', async () => {
  /* Without IDF, every tag on a candidate counts equally and the generic ones win
     by commonness. On real data "Exploration" and "Open World" outvoted
     "Souls-like" and put four driving simulators in group 1's top ten. */
  const history = [
    { appid: 11, score: 10 }, { appid: 12, score: 10 }, { appid: 13, score: 10 },  // Souls-like: adored
    { appid: 14, score: 7 }, { appid: 15, score: 7 }, { appid: 16, score: 7 },     // Open World: mildly warm
    { appid: 17, score: 5 },
  ];
  const tagsFor = new Map([
    [11, ['Souls-like', 'Open World']], [12, ['Souls-like', 'Open World']], [13, ['Souls-like', 'Open World']],
    [14, ['Open World']], [15, ['Open World']], [16, ['Open World']], [17, ['Puzzle']],
  ]);
  // "Open World" is on almost every candidate, so it says nothing; "Souls-like" is
  // on one and is the whole signal. The specific match must win.
  const common = Array.from({ length: 12 }, (_, i) => ({ appid: 100 + i, tags: '["Open World"]' }));
  const out = recommend([...common, { appid: 1, tags: '["Souls-like","Open World"]' }], history, tagsFor);
  return (out.games[0].appid === 1 && out.games[0].why[0] === 'Souls-like')
    || `first ${out.games[0]?.appid}, why ${JSON.stringify(out.games[0]?.why)}`;
});

await check('camera angle and PvP are not tastes', async () => {
  /* "Third Person" scored +0.29 on real data and dragged in racing games for a
     group that likes Souls-likes. PvP is excluded too: the catalogue is filtered to
     co-op, so "matches your taste for PvP" is an incoherent reason to show a card. */
  const history = [
    { appid: 11, score: 9 }, { appid: 12, score: 9 }, { appid: 13, score: 9 },
    { appid: 14, score: 4 }, { appid: 15, score: 4 }, { appid: 16, score: 4 },
  ];
  const tags = ['Third Person', 'PvP'];
  const out = recommend(
    [{ appid: 1, tags: JSON.stringify(tags) }],
    history,
    new Map([[11, tags], [12, tags], [13, tags],
             [14, ['Puzzle']], [15, ['Puzzle']], [16, ['Puzzle']]]),
  );
  const leaked = [...out.likes, ...out.dislikes].map((l) => l.tag).filter((t) => tags.includes(t));
  return (out.games[0].fit === null && !leaked.length)
    || `fit ${out.games[0].fit}, surfaced ${JSON.stringify(leaked)}`;
});

await check('the order never contradicts the fit it displays', async () => {
  /* Popularity is a tiebreak, and it has to stay below the resolution of the number
     the card shows. Unweighted it reordered real differences, producing a list whose
     own fit column read 0.23, 0.23, 0.25, 0.23 — defensible internally and plainly
     broken to look at. Review counts here span five orders of magnitude, which is
     the full spread the popularity term ever sees. */
  const history = [
    { appid: 11, score: 9 }, { appid: 12, score: 9 }, { appid: 13, score: 8 },
    { appid: 14, score: 4 }, { appid: 15, score: 4 }, { appid: 16, score: 6 },
  ];
  const tagsFor = new Map([
    [11, ['Survival', 'Crafting']], [12, ['Survival']], [13, ['Crafting']],
    [14, ['Shooter']], [15, ['Shooter', 'Action']], [16, ['Action']],
  ]);
  const out = recommend([
    { appid: 1, review_count: 10, tags: '["Survival","Crafting"]' },
    { appid: 2, review_count: 2_000_000, tags: '["Survival"]' },
    { appid: 3, review_count: 500, tags: '["Crafting","Action"]' },
    { appid: 4, review_count: 900_000, tags: '["Shooter"]' },
    { appid: 5, review_count: 50, tags: '["Shooter","Action"]' },
  ], history, tagsFor);

  const fits = out.games.map((g) => g.fit);
  const bad = fits.findIndex((f, i) => i && f > fits[i - 1]);
  return bad === -1 || `fit column is not descending: ${JSON.stringify(fits)}`;
});

await check('untasted candidates sort below every ranked one', async () => {
  const history = [
    { appid: 11, score: 9 }, { appid: 12, score: 9 }, { appid: 13, score: 9 },
    { appid: 14, score: 5 }, { appid: 15, score: 5 }, { appid: 16, score: 5 },
  ];
  const out = recommend(
    // The unknown game is hugely more popular, and must still lose to a match.
    [{ appid: 1, review_count: 5e6, tags: '["Nothing We Have Played"]' },
     { appid: 2, review_count: 1, tags: '["Survival"]' }],
    history,
    new Map([[11, ['Survival']], [12, ['Survival']], [13, ['Survival']],
             [14, ['Y']], [15, ['Y']], [16, ['Y']]]),
  );
  return out.games[0].appid === 2 || `popularity beat a taste match: first ${out.games[0]?.appid}`;
});

await check('the recommender only ever reads THIS group\'s ratings', async () => {
  /* The tenancy invariant, at the level that matters for this route: another
     group's ratings must not shape group 1's suggestions. Asserted against the real
     handler rather than the pure function, because the group_id filter lives in the
     SQL. Its own fixture group — group 2 is gone by now, deleted by the tests above.

     One tag, on a game only the other group has rated, and rated high enough that
     it would be group 1's top preference if it leaked at all. */
  sqlite.exec(`INSERT INTO users (steam_id, display_name) VALUES ('${DAN}','Dan')`);
  sqlite.exec(`INSERT INTO groups (id, slug, name, max_players) VALUES (301,'dans','Dans Crew',4)`);
  sqlite.exec(`INSERT INTO memberships (group_id, steam_id, short_name, role)
               VALUES (301,'${DAN}','Dan','owner')`);
  sqlite.exec(`INSERT INTO coop_apps (appid, name, popularity_rank, is_coop, tags)
               VALUES (9102,'Dans Favourite',1,1,'["Only Dan Likes This"]')`);
  sqlite.exec(`INSERT INTO games (id, group_id, name, steam_appid) VALUES (9100,301,'Dans Pick',9102)`);
  sqlite.exec(`INSERT INTO ratings (game_id, steam_id, score) VALUES (9100,'${DAN}',10)`);

  const { data } = await ctxFor(ALICE, 'g4m1ng');
  const d = await (await recommendRoute.onRequestGet({
    request: recReq('?coopOnly=0'), env, data })).json();
  const leaked = [...(d.likes || []), ...(d.dislikes || [])]
    .some((l) => l.tag === 'Only Dan Likes This');

  sqlite.exec('DELETE FROM ratings WHERE game_id=9100');
  sqlite.exec('DELETE FROM games WHERE id=9100');
  sqlite.exec('DELETE FROM coop_apps WHERE appid=9102');
  return !leaked || 'another group\'s rating shaped group 1\'s tag preferences';
});

await check('the co-op filter is on by default and can be turned off', async () => {
  sqlite.exec(`INSERT INTO coop_apps (appid, name, popularity_rank, is_coop, tags)
               VALUES (9101,'A PvP Shooter',1,0,'["PvP"]')`);
  const { data } = await ctxFor(ALICE, 'g4m1ng');
  const on = await (await recommendRoute.onRequestGet({ request: recReq(), env, data })).json();
  const off = await (await recommendRoute.onRequestGet({ request: recReq('?coopOnly=0'), env, data })).json();
  const has = (d) => (d.games || []).some((g) => g.appid === 9101);
  sqlite.exec('DELETE FROM coop_apps WHERE appid=9101');
  return (!has(on) && has(off)) || `default showed it: ${has(on)}; coopOnly=0 hid it: ${!has(off)}`;
});

console.log('\nHTTP boundaries');

await check('JSON request bodies are capped before handlers can buffer them', async () => {
  const request = new Request('https://x/api/groups', {
    method: 'POST', body: JSON.stringify({ text: 'x'.repeat(33 * 1024) }),
  });
  try {
    await readBody(request);
    return 'oversized body was accepted';
  } catch (e) {
    return (e.status === 413) || `threw ${e.name} with status ${e.status}`;
  }
});

await check('malformed JSON is rejected instead of becoming an empty object', async () => {
  try {
    await readBody(new Request('https://x/api/groups', { method: 'POST', body: '{nope' }));
    return 'malformed body was accepted';
  } catch (e) {
    return (e.status === 400) || `threw ${e.name} with status ${e.status}`;
  }
});

await check('authenticated writes are rate-limited per account', async () => {
  sqlite.exec('DELETE FROM rate_limits');
  const cookie = await makeSessionCookie(ALICE, env.SESSION_SECRET);
  let last;
  for (let i = 0; i < 61; i++) {
    last = await rootRoute.onRequest({
      request: new Request('https://x/api/groups/join', {
        method: 'POST', headers: { cookie },
      }),
      env,
      data: {},
      next: async () => new Response(null, { status: 204 }),
    });
  }
  sqlite.exec('DELETE FROM rate_limits');
  return (last.status === 429 && Number(last.headers.get('retry-after')) > 0)
    || `last status ${last.status}, retry-after ${last.headers.get('retry-after')}`;
});

await check('presence updates are scheduled off the /api/me response path', async () => {
  let pending;
  const response = await meRoute.onRequestGet({
    env,
    data: { user: user(ALICE) },
    waitUntil: (promise) => { pending = promise; },
  });
  if (response.status !== 200 || !pending?.then) return 'response or waitUntil promise missing';
  await pending;
  return true;
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
