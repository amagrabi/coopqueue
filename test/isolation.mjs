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
const BOB = '76561198000000003';
sqlite.exec(`INSERT INTO users (steam_id, display_name) VALUES
  ('${ALICE}','Alice'),('${MALLORY}','Mallory'),('${BOB}','Bob Builder')`);
sqlite.exec(`INSERT INTO memberships (group_id, steam_id, short_name, role) VALUES (1,'${ALICE}','Ama','owner')`);
sqlite.exec(`INSERT INTO groups (id, slug, name, invite_code, max_players) VALUES (2,'mallorys','Mallorys Crew','MALLORY123',4)`);
sqlite.exec(`INSERT INTO memberships (group_id, steam_id, short_name, role) VALUES (2,'${MALLORY}','Mallory','owner')`);

const DB = makeDB(sqlite);
const env = { DB, SESSION_SECRET: 'test', STEAM_API_KEY: '' };

const [gamesRoute, gameIdRoute, rateRoute, groupMw, joinRoute, groupsRoute, membersRoute, groupRoute,
       commentsRoute, rootRoute, meRoute, exportRoute, playNightRoute, achievementsRoute,
       historyRoute, statsRoute, steamImportRoute, achievementScanRoute, directInvitesRoute,
       incomingInvitesRoute, dismissalsRoute] = await Promise.all([
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
  import(path.join(SITE, 'functions/api/g/[slug]/steam-import.js')),
  import(path.join(SITE, 'functions/api/g/[slug]/achievement-scan.js')),
  import(path.join(SITE, 'functions/api/g/[slug]/invites.js')),
  import(path.join(SITE, 'functions/api/invites.js')),
  import(path.join(SITE, 'functions/api/g/[slug]/dismissals.js')),
]);
const { makeSessionCookie } = await import(path.join(SITE, 'lib/auth.js'));
const { body: readBody } = await import(path.join(SITE, 'lib/http.js'));
const { buildHistoryItems } = await import(path.join(SITE, 'lib/history.js'));
const activityRoute = await import(path.join(SITE, 'functions/api/g/[slug]/activity.js'));

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

await check('history prompts are off by default and opt in per member', async () => {
  const alice = await ctxFor(ALICE, 'g4m1ng');
  const mallory = await ctxFor(MALLORY, 'g4m1ng');
  const before = await (await membersRoute.onRequestGet({ env, data: alice.data })).json();
  const response = await membersRoute.onRequestPatch({
    request: req({ historyPrompts: true }), env, data: mallory.data,
  });
  const aliceSetting = sqlite.prepare(
    'SELECT history_prompts FROM member_preferences WHERE group_id=1 AND steam_id=?'
  ).get(ALICE);
  const mallorySetting = sqlite.prepare(
    'SELECT history_prompts FROM member_preferences WHERE group_id=1 AND steam_id=?'
  ).get(MALLORY);
  return (!before.group.historyPrompts && response.status === 200 && !aliceSetting
      && mallorySetting?.history_prompts === 1)
    || JSON.stringify({ before: before.group.historyPrompts, aliceSetting, mallorySetting });
});

await check('only an owner can search registered accounts for a direct invite', async () => {
  const owner = await ctxFor(ALICE, 'g4m1ng');
  const member = await ctxFor(MALLORY, 'g4m1ng');
  const found = await (await directInvitesRoute.onRequestGet({
    request: new Request('https://x/api/g/g4m1ng/invites?q=bob'), env, data: owner.data,
  })).json();
  const blocked = await directInvitesRoute.onRequestGet({
    request: new Request('https://x/api/g/g4m1ng/invites?q=bob'), env, data: member.data,
  });
  return (found.results?.[0]?.steamId === BOB && blocked.status === 403)
    || `found ${JSON.stringify(found)}, member status ${blocked.status}`;
});

await check('a direct invitation stays pending until the named account accepts', async () => {
  const owner = await ctxFor(ALICE, 'g4m1ng');
  const created = await directInvitesRoute.onRequestPost({
    request: req({ steamId: BOB }), env, data: owner.data,
  });
  const inbox = await (await incomingInvitesRoute.onRequestGet({
    env, data: { user: user(BOB) },
  })).json();
  const membership = sqlite.prepare(
    'SELECT 1 FROM memberships WHERE group_id=1 AND steam_id=?'
  ).get(BOB);
  return (created.status === 201 && inbox.invites?.length === 1 && !membership)
    || `status ${created.status}, inbox ${JSON.stringify(inbox)}, membership ${!!membership}`;
});

await check('another account cannot answer someone else\'s invitation', async () => {
  const invite = sqlite.prepare(
    "SELECT id FROM group_invites WHERE group_id=1 AND invited_steam_id=? AND status='pending'"
  ).get(BOB);
  const response = await incomingInvitesRoute.onRequestPost({
    request: req({ id: invite.id, action: 'accept' }), env, data: { user: user(ALICE) },
  });
  return response.status === 404 || `got ${response.status}`;
});

await check('accepting a direct invite creates exactly the intended membership', async () => {
  const invite = sqlite.prepare(
    "SELECT id FROM group_invites WHERE group_id=1 AND invited_steam_id=? AND status='pending'"
  ).get(BOB);
  const response = await incomingInvitesRoute.onRequestPost({
    request: req({ id: invite.id, action: 'accept' }), env, data: { user: user(BOB) },
  });
  const payload = await response.json();
  const joined = sqlite.prepare(
    'SELECT COUNT(*) AS n FROM memberships WHERE group_id=1 AND steam_id=?'
  ).get(BOB).n;
  const status = sqlite.prepare('SELECT status FROM group_invites WHERE id=?').get(invite.id).status;
  return (response.status === 200 && payload.slug === 'g4m1ng' && joined === 1 && status === 'accepted')
    || `status ${response.status}, payload ${JSON.stringify(payload)}, rows ${joined}, invite ${status}`;
});

await check('a direct-invite id from another group cannot be cancelled', async () => {
  const mallory = await ctxFor(MALLORY, 'mallorys');
  const alice = await ctxFor(ALICE, 'g4m1ng');
  const created = await directInvitesRoute.onRequestPost({
    request: req({ steamId: BOB }), env, data: mallory.data,
  });
  const foreign = sqlite.prepare(
    "SELECT id FROM group_invites WHERE group_id=2 AND invited_steam_id=? AND status='pending'"
  ).get(BOB);
  const cancelled = await directInvitesRoute.onRequestDelete({
    request: req({ id: foreign.id }), env, data: alice.data,
  });
  const status = sqlite.prepare('SELECT status FROM group_invites WHERE id=?').get(foreign.id).status;
  return (created.status === 201 && cancelled.status === 404 && status === 'pending')
    || `created ${created.status}, cancel ${cancelled.status}, status ${status}`;
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
  sqlite.exec(`INSERT INTO groups (slug,name,max_players) VALUES ('same-name','Same Name',4)`);
  const existing = sqlite.prepare("SELECT id FROM groups WHERE slug='same-name'").get();
  sqlite.prepare("INSERT INTO memberships (group_id,steam_id,short_name,role) VALUES (?,?,?,'owner')")
    .run(existing.id, ALICE, 'Ama');
  const before = sqlite.prepare('SELECT COUNT(*) AS n FROM groups').get().n;
  const r = await groupsRoute.onRequestPost({ request: req({ name: 'Same Name', maxPlayers: 6 }), env, data: { user: user(MALLORY) } });
  const b = await r.json();
  if (b.slug === 'same-name') return 'slug collided with the existing group';
  const row = sqlite.prepare('SELECT * FROM groups WHERE slug=?').get(b.slug);
  const mem = sqlite.prepare("SELECT role FROM memberships WHERE group_id=? AND steam_id=?").get(row.id, MALLORY);
  const after = sqlite.prepare('SELECT COUNT(*) AS n FROM groups').get().n;
  return (after === before + 1 && mem.role === 'owner' && row.max_players === 6) || `slug ${b.slug}, role ${mem?.role}, cap ${row.max_players}`;
});

await check('creating a duplicate name in your own workspace list is refused', async () => {
  const before = sqlite.prepare('SELECT COUNT(*) AS n FROM groups').get().n;
  const r = await groupsRoute.onRequestPost({
    request: req({ name: '  SAME NAME  ', maxPlayers: 4 }), env, data: { user: user(MALLORY) },
  });
  const after = sqlite.prepare('SELECT COUNT(*) AS n FROM groups').get().n;
  return (r.status === 409 && after === before) || `status ${r.status}, rows ${before} -> ${after}`;
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

await check('personal workspaces reject direct invitations', async () => {
  const { data } = await ctxFor(MALLORY, 'my-history');
  const response = await directInvitesRoute.onRequestPost({
    request: req({ steamId: ALICE }), env, data,
  });
  return response.status === 409 || `got ${response.status}`;
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

await check('a known single-player Steam game can still be added deliberately', async () => {
  sqlite.exec(`INSERT INTO steam_apps (appid,name,coop_categories,fetched_at)
               VALUES (777010,'Deliberate Solo Addition','["Single-player"]',unixepoch())`);
  sqlite.exec(`INSERT INTO coop_apps (appid,name,tags,is_coop)
               VALUES (777010,'Deliberate Solo Addition','["Singleplayer"]',0)`);
  const { data } = await ctxFor(ALICE, 'g4m1ng');
  const response = await gamesRoute.onRequestPost({ request: req({ input: '777010' }), env, data });
  const added = sqlite.prepare('SELECT max_players FROM games WHERE group_id=1 AND steam_appid=777010').get();
  return (response.status === 201 && added && added.max_players == null)
    || `status ${response.status}, added ${JSON.stringify(added)}`;
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
  (id,group_id,name,genre,status,hours,started,finished)
  VALUES
  (8260,1,'Stats Fixture','Stats Fixture','finished',12,'2023-01-02','2023-02-03'),
  (8261,2,'Foreign Stats','Stats Fixture','finished',999,'2023-01-02','2023-02-03')`);
sqlite.exec(`INSERT INTO ratings (game_id,steam_id,score) VALUES
  (8260,'${ALICE}',7),(8261,'${MALLORY}',10)`);

await check('library-shape stats aggregate recorded data without crossing groups', async () => {
  const { data } = await ctxFor(ALICE, 'g4m1ng');
  const response = await statsRoute.onRequestGet({ env, data });
  const result = await response.json();
  const genre = result.genres.find((item) => item.genre === 'Stats Fixture');
  const point = result.timeVsRating.find((item) => item.id === 8260);
  const statusTotal = Object.values(result.statusCounts).reduce((sum, count) => sum + count, 0);
  const year = result.timeline.find((item) => item.year === 2023);
  return (response.status === 200 && statusTotal === result.totals.games
      && genre?.games === 1 && genre.hours === 12 && genre.hoursGames === 1
      && genre.ratedGames === 1 && genre.avg === 7
      && point?.hours === 12 && point.rating === 7
      && !result.timeVsRating.some((item) => item.id === 8261)
      && year?.started >= 1 && year.finished >= 1)
    || JSON.stringify({ status: response.status, statusTotal, totals: result.totals, genre, point, year });
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
  let masked = false;
  globalThis.fetch = async (url) => {
    publicHost = String(url).startsWith('https://api.steampowered.com/');
    if (fallback && publicHost) {
      return new Response(null, { status: 403 });
    }
    if (fallback && String(url).includes('/achievements/')) {
      return new Response(null, { status: 429 });
    }
    if (fallback && String(url).startsWith('https://steamcommunity.com/profiles/')) {
      const first = masked
        ? '<achievement closed="0"><name>First Night</name><apiname>first</apiname></achievement>'
        : '<achievement closed="1"><name>First &amp; Night</name><apiname>first</apiname><unlockTimestamp>456</unlockTimestamp></achievement>';
      return new Response(`<?xml version="1.0"?><playerstats>
        <privacyState>public</privacyState>
        <game><gameName><![CDATA[Tonight Shortlist]]></gameName></game>
        <achievements>
          ${first}
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
    if (fallbackResponse.status !== 200 || row?.achieved !== 1 || row?.total !== 2
        || unlocked[0]?.name !== 'First & Night' || unlocked[0]?.unlocktime !== 456) {
      return `fallback status ${fallbackResponse.status}, row ${JSON.stringify(row)}`;
    }

    sqlite.prepare(
      'UPDATE achievement_progress SET achieved=0, unlocked=? WHERE steam_id=? AND appid=?'
    ).run('[]', ALICE, 982000);
    masked = true;
    const maskedResponse = await achievementsRoute.onRequestPost({
      request: req({ gameId: 8200 }), env, data,
    });
    const maskedView = await maskedResponse.json();
    const maskedRow = sqlite.prepare(
      'SELECT achieved FROM achievement_progress WHERE steam_id=? AND appid=?'
    ).get(ALICE, 982000);
    const mine = maskedView.members.find((member) => member.steamId === ALICE);
    return (maskedResponse.status === 200 && maskedView.notice?.includes('even with public settings')
        && mine?.total == null && !maskedRow)
      || `masked status ${maskedResponse.status}, row ${JSON.stringify(maskedRow)}, ${JSON.stringify(maskedView)}`;
  } finally {
    env.STEAM_API_KEY = originalKey;
    globalThis.fetch = originalFetch;
  }
});

// Synthetic accounts and two achievements mirror the current Community page's
// sparse personal data plus separate schema. Never commit a real profile dump.
function communityAchievementQueries() {
  return [
    { queryKey: ['achievements', 982000, 'user_achievements', ALICE], state: {
      status: 'success', data: { appid: 982000, steamid: ALICE, schema_hash: 123,
        achievements: { 256: { internal_key: 256, unlocked: true, unlock_time: 456 } } },
    } },
    { queryKey: ['achievements', 982000, 'schema'], state: {
      status: 'success', data: { appid: 982000, schema_hash: 123, groups: [{
        id: 0, ispublic: true, archived: false, achievements: [
          { internal_key: 256, api_name: 'first', name: 'First & Night', hidden: false },
          { internal_key: 257, api_name: 'later', name: 'Another Night', hidden: true },
        ],
      }] },
    } },
    { queryKey: ['achievements', 982000, 'globalpercentages'], state: {
      status: 'success', data: { percentages: { 256: 80, 257: 40 } },
    } },
  ];
}

function communityAchievementHtml(queries) {
  return `<script type="application/json" id="valve-ssr-data">${JSON.stringify({
    renderContext: { queryData: JSON.stringify({ queries }) },
  })}</script>`;
}

await check('achievement sync reads current public unlocks before the legacy XML fallback', async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = env.STEAM_API_KEY;
  env.STEAM_API_KEY = 'test-key';
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).startsWith('https://api.steampowered.com/')) return new Response(null, { status: 403 });
    if (String(url) === `https://steamcommunity.com/profiles/${ALICE}/achievements/982000?l=english`) {
      return new Response(communityAchievementHtml(communityAchievementQueries()));
    }
    throw new Error('Unexpected fallback request');
  };
  try {
    const { data } = await ctxFor(ALICE, 'g4m1ng');
    const response = await achievementsRoute.onRequestPost({ request: req({ gameId: 8200 }), env, data });
    const row = sqlite.prepare(
      'SELECT achieved,total,unlocked FROM achievement_progress WHERE steam_id=? AND appid=?'
    ).get(ALICE, 982000);
    const unlocked = JSON.parse(row?.unlocked || '[]');
    return (response.status === 200 && row?.achieved === 1 && row?.total === 2
        && unlocked[0]?.key === 'first' && unlocked[0]?.name === 'First & Night'
        && unlocked[0]?.unlocktime === 456 && calls.length === 2)
      || `status ${response.status}, row ${JSON.stringify(row)}, calls ${calls.length}`;
  } finally {
    env.STEAM_API_KEY = originalKey;
    globalThis.fetch = originalFetch;
  }
});

await check('current Community fallback rejects mismatched, malformed and global-only data without changing progress', async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = env.STEAM_API_KEY;
  env.STEAM_API_KEY = 'test-key';
  let html;
  globalThis.fetch = async (url) => String(url).includes('/achievements/')
    ? new Response(html) : new Response(null, { status: String(url).includes('/stats/') ? 429 : 403 });
  const cases = [
    ['foreign account key', (q) => { q[0].queryKey[3] = BOB; }],
    ['foreign account payload', (q) => { q[0].state.data.steamid = BOB; }],
    ['foreign app key', (q) => { q[0].queryKey[1] = 700002; }],
    ['foreign app payload', (q) => { q[0].state.data.appid = 700002; }],
    ['foreign schema', (q) => { q[1].state.data.appid = 700002; }],
    ['mismatched schema revision', (q) => { q[0].state.data.schema_hash = 456; }],
    ['schema alone', (q) => { q.shift(); }],
    ['global rates alone', (q) => { q.splice(0, 2); }],
    ['unknown unlocked key', (q) => {
      q[0].state.data.achievements[258] = { internal_key: 258, unlocked: true };
    }],
    ['mismatched internal key', (q) => { q[0].state.data.achievements[256].internal_key = 257; }],
    ['duplicate achievement', (q) => {
      q[1].state.data.groups[0].achievements.push(q[1].state.data.groups[0].achievements[0]);
    }],
    ['malformed JSON', null],
    ['oversized page', null],
  ];
  try {
    const { data } = await ctxFor(ALICE, 'g4m1ng');
    for (const [label, mutate] of cases) {
      const queries = communityAchievementQueries();
      if (mutate) mutate(queries);
      html = mutate ? communityAchievementHtml(queries)
        : label === 'malformed JSON' ? '<script id="valve-ssr-data">{</script>' : 'x'.repeat(2 * 1024 * 1024 + 1);
      const response = await achievementsRoute.onRequestPost({ request: req({ gameId: 8200 }), env, data });
      const row = sqlite.prepare(
        'SELECT achieved,total FROM achievement_progress WHERE steam_id=? AND appid=?'
      ).get(ALICE, 982000);
      if (response.status !== 502 || row?.achieved !== 1 || row?.total !== 2) {
        return `${label}: status ${response.status}, row ${JSON.stringify(row)}`;
      }
    }
    return true;
  } finally {
    env.STEAM_API_KEY = originalKey;
    globalThis.fetch = originalFetch;
  }
});

await check('empty current Community progress stays unknown, clears only old zeroes and preserves real progress', async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = env.STEAM_API_KEY;
  env.STEAM_API_KEY = 'test-key';
  let queries;
  globalThis.fetch = async (url) => String(url).includes('/achievements/')
    ? new Response(communityAchievementHtml(queries)) : new Response(null, { status: 403 });
  try {
    const { data } = await ctxFor(ALICE, 'g4m1ng');
    for (const hash of [0, 123]) {
      queries = communityAchievementQueries();
      queries[0].state.data.achievements = {};
      queries[0].state.data.schema_hash = hash;
      const response = await achievementsRoute.onRequestPost({ request: req({ gameId: 8200 }), env, data });
      const view = await response.json();
      const mine = view.members.find((member) => member.steamId === ALICE);
      if (response.status !== 200 || mine?.achieved !== 1 || !view.notice?.includes('even with public settings')) {
        return `empty hash ${hash}: status ${response.status}, ${JSON.stringify(view)}`;
      }
    }
    sqlite.prepare('UPDATE achievement_progress SET achieved=0,unlocked=? WHERE steam_id=? AND appid=?')
      .run('[]', ALICE, 982000);
    const response = await achievementsRoute.onRequestPost({ request: req({ gameId: 8200 }), env, data });
    const view = await response.json();
    return (response.status === 200 && view.members.find((member) => member.steamId === ALICE)?.total == null)
      || `empty cache status ${response.status}, ${JSON.stringify(view)}`;
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

await check('hours are stored to one decimal place', async () => {
  const { data } = await ctxFor(ALICE, 'g4m1ng');
  const g = sqlite.prepare('SELECT id,hours FROM games WHERE group_id=1 LIMIT 1 OFFSET 8').get();
  const priorSource = sqlite.prepare(
    "SELECT source,set_by,updated_at FROM game_fact_sources WHERE group_id=1 AND game_id=? AND field='hours'"
  ).get(g.id);
  const r = await gameIdRoute.onRequestPatch({
    params: { id: String(g.id) }, request: req({ hours: 12.333333333 }), env, data,
  });
  const stored = sqlite.prepare('SELECT hours FROM games WHERE id=?').get(g.id).hours;
  sqlite.prepare('UPDATE games SET hours=? WHERE id=?').run(g.hours, g.id);
  if (priorSource) {
    sqlite.prepare(`UPDATE game_fact_sources SET source=?,set_by=?,updated_at=?
                     WHERE group_id=1 AND game_id=? AND field='hours'`)
      .run(priorSource.source, priorSource.set_by, priorSource.updated_at, g.id);
  } else {
    sqlite.prepare("DELETE FROM game_fact_sources WHERE group_id=1 AND game_id=? AND field='hours'").run(g.id);
  }
  return (r.status === 200 && stored === 12.3) || `status ${r.status}, stored ${stored}`;
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

const { classifyCoop, classifyGameType, parseStoreTags, shapeDetails } = await import(path.join(SITE, 'lib/coop.js'));
// Public Steam tag order checked 2026-10-17, /app/<appid>/?l=english.
// Multiplayer evidence sits below the old 12-tag cutoff in all three co-op cases.
const MODE_FIXTURES = [
  { appid: 753640, name: 'Outer Wilds', coop: false, tags: [
    'Exploration', 'Space', 'Mystery', 'Story Rich', 'Adventure', 'Great Soundtrack',
    'Atmospheric', 'Puzzle', 'Open World', 'Singleplayer', 'Indie', 'Sci-fi', 'Horror',
    'First-Person', 'Beautiful', 'Psychological Horror', 'Epic', '3D', 'Simulation', 'Action',
  ] },
  { appid: 3643170, name: 'Roadside Research', coop: true, tags: [
    'Early Access', 'Shop Keeper', 'Simulation', 'Relaxing', 'Management', 'Immersive Sim',
    'Resource Management', 'Singleplayer', 'Inventory Management', 'Economy', 'Building',
    'Trading', 'Life Sim', 'First-Person', 'Character Customization', 'Funny', 'Comedy',
    'Sci-fi', 'Casual', 'Online Co-Op',
  ] },
  { appid: 1794680, name: 'Vampire Survivors', coop: true, tags: [
    'Action Roguelike', 'Bullet Hell', 'Roguelite', 'Pixel Graphics', 'Vampires', '2D',
    'Indie', 'Singleplayer', 'Casual', 'Roguelike', 'Arcade', 'Action', 'Local Co-Op',
    'RPG', 'Controller', 'Score Attack', 'Retro', 'Dark Fantasy', 'Action RPG', 'Co-op',
  ] },
  { appid: 1340990, name: 'Rise of the Ronin', coop: true, tags: [
    'Open World', 'Action RPG', 'RPG', 'Swordplay', 'Action', 'Third Person', 'Adventure',
    'Historical', '3D', 'Character Customization', 'Souls-like', 'Singleplayer', 'Samurai',
    'Multiple Endings', 'Gore', 'Online Co-Op', 'Violent', 'Ninja', 'Co-op', 'Asynchronous Multiplayer',
  ] },
];
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
  await check(`${name} classifies as ${want ? 'co-op' : 'not co-op'}`, async () => {
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

for (const game of MODE_FIXTURES) {
  await check(`${game.name} uses mode evidence beyond the first six tags`, async () =>
    classifyCoop(game.tags) === game.coop || `wrong verdict for ${game.appid}`);
}

await check('cached Steam modes rescue co-op games with older truncated tag lists', async () => {
  const failures = MODE_FIXTURES.filter((game) => game.coop
    && !classifyCoop(game.tags.slice(0, 12), ['Multi-player', 'Co-op', 'Online Co-op']));
  return !failures.length || `hidden: ${failures.map((game) => game.name).join(', ')}`;
});

await check('Steam co-op modes cannot override a primary PvP genre', async () => {
  const tags = ['FPS', 'PvP', 'Multiplayer', 'Co-op'];
  const categories = ['Multi-player', 'Co-op', 'Online Co-op'];
  return (!classifyCoop(tags, categories)
      && classifyGameType({ tags, categories, isCoop: 1 }) === 'multiplayer')
    || 'Steam mode hints overrode the PvP exclusion';
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

for (const game of MODE_FIXTURES) {
  await check(`${game.name} keeps its complete visible Steam tag list`, async () => {
    const html = '<div class="glance_tags popular_tags">'
      + game.tags.map((tag) => `<a class="app_tag" style="display: none;">${tag}</a>`).join('')
      + '</div><a class="app_tag">PvP</a>';
    const parsed = parseStoreTags(html);
    return (JSON.stringify(parsed?.tags) === JSON.stringify(game.tags) && parsed.isCoop === game.coop)
      || `got ${JSON.stringify(parsed)}`;
  });
}

await check('tag parsing stays bounded and never reads multiplayer tags from the modal', async () => {
  const many = Array.from({ length: 100 }, (_, i) => `<a class="app_tag">Tag${i}</a>`).join('');
  const bounded = parseStoreTags(`<div class="glance_tags popular_tags">${many}</div>`);
  const solo = parseStoreTags('<div class="glance_tags popular_tags"><a class="app_tag">Singleplayer</a>'
    + '</div><div><a class="app_tag">Multiplayer</a></div>');
  return (bounded.tags.length === 64 && solo.isCoop === false && solo.tags.length === 1)
    || `bounded ${bounded.tags.length}, solo ${JSON.stringify(solo)}`;
});

await check('full Steam metadata retains explicit solo evidence without inventing player caps', async () => {
  const { getAppDetails } = await import(path.join(SITE, 'lib/steam.js'));
  const previousFetch = globalThis.fetch;
  const payload = { 710099: { success: true, data: {
    type: 'game', name: 'Known Solo', categories: [
      { description: 'Single-player' }, { description: 'Steam Achievements' },
    ],
  } } };
  try {
    globalThis.fetch = async () => new Response(JSON.stringify(payload));
    const details = await getAppDetails(env.DB, 710099);
    const cached = JSON.parse(sqlite.prepare('SELECT coop_categories FROM steam_apps WHERE appid=710099').get().coop_categories);
    const catalogue = shapeDetails(710099, payload);
    return (JSON.stringify(details.coop_categories) === '["Single-player"]'
        && JSON.stringify(cached) === '["Single-player"]'
        && JSON.stringify(catalogue.coop_categories) === '["Single-player"]'
        && !('max_players' in details) && !('max_players' in catalogue))
      || `details ${JSON.stringify(details)}, cached ${JSON.stringify(cached)}`;
  } finally { globalThis.fetch = previousFetch; }
});

console.log('\nRecommendations');

const recommendRoute = await import(path.join(SITE, 'functions/api/g/[slug]/recommend.js'));
const { recommend, REVIEW_PRIOR, DIVERSITY } = await import(path.join(SITE, 'lib/recommend.js'));
const DAN = '76561198000000555';
const recReq = (qs = '') => new Request(`https://x/api/g/g4m1ng/recommend${qs}`);

/* MIN_HISTORY is 20: below that `recommend` returns the popularity order and says
   so, because the taste ranking measures as noise on a thin history. These fixtures
   are about the tag arithmetic, not the threshold, so they are padded up to it —
   with games that score the fixture's own mean, so the group average does not move,
   and a tag unique to each, so no new preference can qualify. */
const pad = (n, score, tagsFor, from = 8900) => {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ appid: from + i, name: `Filler ${i}`, score });
    tagsFor.set(from + i, [`Filler ${i}`]);
  }
  return out;
};

await check('full classification tags do not change the measured top-12 taste model', async () => {
  const tagsFor = new Map();
  const history = pad(20, 7, tagsFor);
  for (let i = 0; i < 4; i++) {
    history.push({ appid: 8800 + i, name: `Liked ${i}`, score: 10 });
    tagsFor.set(8800 + i, ['Survival', ...Array.from({ length: 11 }, (_, n) => `Mechanic${n}`)]);
  }
  for (const [appid, tags] of tagsFor) tagsFor.set(appid, [...tags, ...Array(12).fill('Common')].slice(0, 12));
  const candidates = [
    { appid: 1, tags: JSON.stringify(tagsFor.get(8800)), review_count: 100 },
    { appid: 2, tags: ['Puzzle', ...Array(11).fill('Other')], review_count: 200 },
  ];
  const brief = (out) => ({
    games: out.games.map(({ appid, fit }) => ({ appid, fit })), likes: out.likes, dislikes: out.dislikes,
  });
  const before = brief(recommend(candidates, history, tagsFor));
  const extendedHistory = new Map([...tagsFor].map(([appid, tags]) => [appid,
    tags.concat('Online Co-Op', 'Late taste tag'),
  ]));
  const extendedCandidates = candidates.map((game) => ({ ...game,
    tags: (typeof game.tags === 'string' ? JSON.parse(game.tags) : game.tags).concat('Online Co-Op', 'Late taste tag'),
  }));
  const full = brief(recommend(extendedCandidates, history, extendedHistory));
  return (before.games.length === 2 && JSON.stringify(before) === JSON.stringify(full))
    || `before ${JSON.stringify(before)}, full ${JSON.stringify(full)}`;
});

await check('recommendations are group-scoped: a non-member never reaches them', async () => {
  // Same 404-not-403 boundary as everything else below /api/g/:slug.
  const { passed, out } = await ctxFor(MALLORY, 'carols');
  return (!passed && out.status === 404) || `passed ${passed}, status ${out?.status}`;
});

await check('a thin history is reported as popularity, not dressed up as taste', async () => {
  const out = recommend(
    [{ appid: 1, review_count: 2, tags: '["Survival"]' },
     { appid: 2, review_count: 3, tags: '["RPG"]' }],
    [{ appid: 9, score: 8 }],                       // one rated game, below MIN_HISTORY
    new Map([[9, ['Survival']]]),
  );
  return (out.basis === 'popularity' && out.games[0].appid === 2)
    || `basis ${out.basis}, first ${out.games[0]?.appid}`;
});

await check('tags the group rates highly rank above tags it rates poorly', async () => {
  // Four games per tag: TAG_MIN_GAMES is 4, because at 3 a coincidence still reads
  // as a taste — "Pirates" scored +0.70 off three games on real data and put a
  // pirate MMO at number one.
  const history = [
    { appid: 11, name: 'Survival A', score: 9 }, { appid: 12, name: 'Survival B', score: 9 },
    { appid: 13, name: 'Survival C', score: 9 }, { appid: 18, name: 'Survival D', score: 9 },
    { appid: 14, name: 'Racer A', score: 3 }, { appid: 15, name: 'Racer B', score: 3 },
    { appid: 16, name: 'Racer C', score: 3 }, { appid: 19, name: 'Racer D', score: 3 },
    { appid: 17, name: 'A Puzzle', score: 6 },
  ];
  const tagsFor = new Map([
    [11, ['Survival']], [12, ['Survival']], [13, ['Survival']], [18, ['Survival']],
    [14, ['Racing']], [15, ['Racing']], [16, ['Racing']], [19, ['Racing']], [17, ['Puzzle']],
  ]);
  const out = recommend(
    [{ appid: 1, name: 'a racer', review_count: 5e5, tags: '["Racing"]' },
     { appid: 2, name: 'a survival game', review_count: 10, tags: '["Survival"]' }],
    [...history, ...pad(12, 6, tagsFor)], tagsFor,
  );
  // Note the review counts: the racer is far more popular, so this also asserts
  // popularity cannot overturn a real taste signal.
  /* The reason names the game it resembles, not the tag they share — the ranking is
     built on whole-game similarity now, and "because you rated Survival A" is a
     claim somebody can check. */
  return (out.basis === 'taste' && out.games[0].appid === 2 && /^Survival /.test(out.games[0].why[0]))
    || `first ${out.games[0]?.appid}, why ${JSON.stringify(out.games[0]?.why)}`;
});

await check('a thin tag stays out of the likes summary', async () => {
  /* This used to assert that a two-game tag could not score a candidate at all.
     The ranking no longer works per tag — it compares whole games — so a shared
     rare tag IS legitimate evidence there, weighted by overall resemblance and
     shrunk when the resemblance is faint. TAG_MIN_GAMES now governs only the
     likes/dislikes summary the UI prints, which is a claim about the group
     ("you rate Survival above your average") and still needs real backing. */
  const tagsFor = new Map([[11, ['Roguelike']], [12, ['Roguelike']],
                           [13, ['X']], [14, ['X']], [15, ['X']], [16, ['X']]]);
  const history = [
    { appid: 11, name: 'Rogue A', score: 9 }, { appid: 12, name: 'Rogue B', score: 9 },
    { appid: 13, name: 'Other A', score: 5 }, { appid: 14, name: 'Other B', score: 5 },
    { appid: 15, name: 'Other C', score: 5 }, { appid: 16, name: 'Other D', score: 5 },
  ];
  const out = recommend(
    [{ appid: 1, tags: '["Roguelike"]' }],
    [...history, ...pad(15, 6, tagsFor)],
    tagsFor,
  );
  const named = [...out.likes, ...out.dislikes].map((l) => l.tag);
  return !named.includes('Roguelike')
    || `a two-game tag reached the summary: ${JSON.stringify(named)}`;
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
  const tagsFor = new Map([[11, tags], [12, tags], [13, tags], [17, tags],
                           [14, ['Puzzle']], [15, ['Puzzle']], [16, ['Puzzle']], [18, ['Puzzle']]]);
  const out = recommend(
    [{ appid: 1, tags: JSON.stringify(tags) }],
    [...history, { appid: 17, score: 9 }, { appid: 18, score: 4 }, ...pad(14, 6.5, tagsFor)],
    tagsFor,
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
    { appid: 11, name: 'Souls A', score: 10 }, { appid: 12, name: 'Souls B', score: 10 },
    { appid: 13, name: 'Souls C', score: 10 }, { appid: 18, name: 'Souls D', score: 10 },
    { appid: 14, name: 'Open A', score: 7 }, { appid: 15, name: 'Open B', score: 7 },
    { appid: 16, name: 'Open C', score: 7 }, { appid: 17, name: 'A Puzzle', score: 5 },
  ];
  const tagsFor = new Map([
    [11, ['Souls-like', 'Open World']], [12, ['Souls-like', 'Open World']],
    [13, ['Souls-like', 'Open World']], [18, ['Souls-like', 'Open World']],
    [14, ['Open World']], [15, ['Open World']], [16, ['Open World']], [17, ['Puzzle']],
  ]);
  // "Open World" is on almost every candidate, so it says nothing; "Souls-like" is
  // on one and is the whole signal. The specific match must win.
  const common = Array.from({ length: 12 }, (_, i) => ({ appid: 100 + i, tags: '["Open World"]' }));
  const out = recommend([...common, { appid: 1, tags: '["Souls-like","Open World"]' }],
    [...history, ...pad(13, 8.25, tagsFor)], tagsFor);
  return (out.games[0].appid === 1 && /^Souls /.test(out.games[0].why[0]))
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
  const tagsFor = new Map([[11, tags], [12, tags], [13, tags], [17, tags],
                           [14, ['Puzzle']], [15, ['Puzzle']], [16, ['Puzzle']], [18, ['Puzzle']]]);
  const out = recommend(
    [{ appid: 1, tags: JSON.stringify(tags) }],
    [...history, { appid: 17, score: 9 }, { appid: 18, score: 4 }, ...pad(14, 6.5, tagsFor)],
    tagsFor,
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
    // A weak verdict on a strong match: the prior is large enough to reorder, so
    // it has to be inside the displayed number or the column stops descending.
    { appid: 6, review_count: 400, review_hint: 'Mixed', tags: '["Survival","Co-op"]' },
    { appid: 7, review_count: 400, review_hint: 'Overwhelmingly Negative', tags: '["Survival"]' },
  ], history, tagsFor);

  const fits = out.games.map((g) => g.fit);
  const bad = fits.findIndex((f, i) => i && f > fits[i - 1]);
  return bad === -1 || `fit column is not descending: ${JSON.stringify(fits)}`;
});

await check('untasted candidates sort below every ranked one', async () => {
  const history = [
    { appid: 11, score: 9 }, { appid: 12, score: 9 }, { appid: 13, score: 9 }, { appid: 18, score: 9 },
    { appid: 14, score: 5 }, { appid: 15, score: 5 }, { appid: 16, score: 5 }, { appid: 19, score: 5 },
  ];
  const untastedTags = new Map([
    [11, ['Survival']], [12, ['Survival']], [13, ['Survival']], [18, ['Survival']],
    [14, ['Y']], [15, ['Y']], [16, ['Y']], [19, ['Y']]]);
  const out = recommend(
    // The unknown game is hugely more popular, and must still lose to a match.
    [{ appid: 1, review_count: 5e6, tags: '["Nothing We Have Played"]' },
     { appid: 2, review_count: 1, tags: '["Survival"]' }],
    [...history, ...pad(13, 7, untastedTags)],
    untastedTags,
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

await check('taste is learned from library games the catalogue does not list', async () => {
  /* The bug this covers cost group 1 45 of its 103 rated games: tags were read from
     coop_apps only, so anything the crawler had never listed taught the recommender
     nothing. Measured leave-one-out correlation with the group's own scores went
     from 0.03 to 0.25 once the gap was filled. */
  sqlite.exec(`INSERT INTO steam_apps (appid, name, tags)
               VALUES (9200,'Not In The Catalogue','["Dwarves","Base Building"]')`);
  sqlite.exec(`INSERT INTO games (id, group_id, name, steam_appid) VALUES
               (9201,1,'Uncatalogued A',9200)`);
  sqlite.exec(`INSERT INTO ratings (game_id, steam_id, score) VALUES (9201,'${ALICE}',10)`);
  // Three more so the tag clears TAG_MIN_GAMES, which counts rated GAMES.
  sqlite.exec(`INSERT INTO steam_apps (appid, name, tags) VALUES
               (9202,'Also Missing','["Dwarves","Base Building"]'),
               (9203,'Missing Too','["Dwarves","Base Building"]'),
               (9206,'Missing As Well','["Dwarves","Base Building"]')`);
  sqlite.exec(`INSERT INTO games (id, group_id, name, steam_appid) VALUES
               (9204,1,'Uncatalogued B',9202), (9205,1,'Uncatalogued C',9203),
               (9207,1,'Uncatalogued D',9206)`);
  sqlite.exec(`INSERT INTO ratings (game_id, steam_id, score) VALUES
               (9204,'${ALICE}',10), (9205,'${ALICE}',10), (9207,'${ALICE}',10)`);
  /* Clear MIN_HISTORY. Group 1's seeded games carry no steam_appid, so they are
     invisible to the recommender's history query — padding with linked rows is the
     only way to reach the threshold. Unique tags each, so none can qualify. */
  for (let i = 0; i < 20; i++) {
    sqlite.exec(`INSERT INTO steam_apps (appid, name, tags)
                 VALUES (${9400 + i},'Pad ${i}','["Pad Tag ${i}"]')`);
    sqlite.exec(`INSERT INTO games (id, group_id, name, steam_appid)
                 VALUES (${9400 + i},1,'Pad ${i}',${9400 + i})`);
    sqlite.exec(`INSERT INTO ratings (game_id, steam_id, score) VALUES (${9400 + i},'${ALICE}',7)`);
  }

  const { data } = await ctxFor(ALICE, 'g4m1ng');
  const d = await (await recommendRoute.onRequestGet({
    request: recReq('?coopOnly=0'), env, data })).json();
  const learned = (d.likes || []).some((l) => l.tag === 'Dwarves');

  for (const sql of [
    'DELETE FROM ratings WHERE game_id IN (9201,9204,9205,9207) OR game_id BETWEEN 9400 AND 9419',
    'DELETE FROM games WHERE id IN (9201,9204,9205,9207) OR id BETWEEN 9400 AND 9419',
    'DELETE FROM steam_apps WHERE appid IN (9200,9202,9203,9206) OR appid BETWEEN 9400 AND 9419',
  ]) sqlite.exec(sql);
  return learned || `likes were ${JSON.stringify((d.likes || []).map((l) => l.tag))}`;
});

await check('the list does not repeat one beloved game five times', async () => {
  /* The neighbourhood model gives everything near one beloved cluster a high fit,
     so without diversification the first page is the same game over and over —
     7 of group 1's top 20 had Elden Ring as their nearest rated game. */
  const tagsFor = new Map();
  const history = pad(24, 7, tagsFor);
  // Two things they love equally, so fit cannot be what separates the candidates.
  for (const [i, a] of [600, 601, 602, 603].entries()) {
    history.push({ appid: a, name: `Souls ${i}`, score: 10 });
    tagsFor.set(a, ['Souls-like', 'Dark Fantasy']);
  }
  for (const [i, a] of [610, 611, 612, 613].entries()) {
    history.push({ appid: a, name: `Farm ${i}`, score: 10 });
    tagsFor.set(a, ['Farming Sim', 'Cozy']);
  }
  // Five interchangeable matches of the first kind, one of the second.
  const clones = Array.from({ length: 5 }, (_, i) => ({
    appid: 700 + i, name: `Clone ${i}`, review_count: 1000, tags: '["Souls-like","Dark Fantasy"]',
  }));
  const other = { appid: 800, name: 'Different', review_count: 1000, tags: '["Farming Sim","Cozy"]' };
  const out = recommend([...clones, other], history, tagsFor);
  const at = out.games.findIndex((g) => g.appid === 800) + 1;
  /* One of each kind should lead. In plain fit order the five clones are
     indistinguishable and fill the whole head of the list before anything else. */
  return at <= 2 || `the second kind ranked ${at} of ${out.games.length}, behind the clones`;
});

await check('a taste ranking says when it has not settled yet', async () => {
  /* Measured: this ranking does not track taste until roughly 45 rated games, so
     between MIN_HISTORY and there it is shown with a caveat rather than presented
     as though the fit means what it eventually will. */
  const tagsFor = new Map();
  const cands = [{ appid: 1, tags: '["Survival"]', review_count: 1 }];
  const thin = recommend(cands, pad(19, 7, tagsFor), tagsFor);
  const middling = recommend(cands, pad(30, 7, tagsFor), tagsFor);
  const settled = recommend(cands, pad(50, 7, tagsFor), tagsFor);
  return (thin.basis === 'popularity' && thin.settled === false
          && middling.basis === 'taste' && middling.settled === false
          && settled.basis === 'taste' && settled.settled === true)
    || `19:${thin.basis}/${thin.settled} 30:${middling.basis}/${middling.settled} 50:${settled.basis}/${settled.settled}`;
});

await check('a weak Steam verdict loses a tie, and never touches popularity order', async () => {
  /* A prior, not a fitted signal: group 1 has rated nothing below Mixed, so the
     correlation cannot speak to the bad end of the scale. What is observable is
     that weak-verdict games reached the top — Mixed at 5th and 13th. */
  const tagsFor = new Map();
  const history = pad(24, 7, tagsFor);
  // Two identical matches, so only the verdict can separate them.
  history.push({ appid: 500, name: 'Liked A', score: 10 }, { appid: 501, name: 'Liked B', score: 10 },
               { appid: 502, name: 'Liked C', score: 10 }, { appid: 503, name: 'Liked D', score: 10 });
  for (const a of [500, 501, 502, 503]) tagsFor.set(a, ['Survival']);
  const cands = [
    { appid: 1, name: 'mixed', review_count: 5000, review_hint: 'Mixed', tags: '["Survival"]' },
    { appid: 2, name: 'loved', review_count: 5000, review_hint: 'Very Positive', tags: '["Survival"]' },
  ];
  const ranked = recommend(cands, history, tagsFor);
  /* Identical tags, so identical resemblance to the group's history — every point
     of difference between them is a deliberate adjustment, and both live inside the
     displayed number rather than being applied invisibly: the Mixed prior, plus the
     full duplicate penalty the second one takes for repeating the first exactly. */
  const goodFirst = ranked.games[0].appid === 2;
  const gap = Math.round((ranked.games[0].fit - ranked.games[1].fit) * 100) / 100;
  const sameFit = gap === Math.round((REVIEW_PRIOR.Mixed + DIVERSITY) * 100) / 100;
  // Below MIN_HISTORY the label promises popularity order, so it must be exactly that.
  const popular = recommend(cands, pad(3, 7, new Map()), new Map());
  return (sameFit && goodFirst && popular.basis === 'popularity' && popular.games[0].appid === 1)
    || `gap ${gap} (expected ${REVIEW_PRIOR.Mixed} + ${DIVERSITY}), first ${ranked.games[0].appid}, popularity first ${popular.games[0].appid}`;
});

await check('a game already in the library is not recommended, but is still findable', async () => {
  sqlite.exec(`INSERT INTO coop_apps (appid, name, popularity_rank, is_coop, tags)
               VALUES (9300,'Already Ours',1,1,'["Survival"]')`);
  sqlite.exec(`INSERT INTO games (id, group_id, name, steam_appid) VALUES (9301,1,'Already Ours',9300)`);
  const { data } = await ctxFor(ALICE, 'g4m1ng');
  const listed = await (await recommendRoute.onRequestGet({ request: recReq('?coopOnly=0'), env, data })).json();
  // A search is a lookup, not a recommendation: hiding what you typed reads as broken.
  const found = await (await recommendRoute.onRequestGet({
    request: recReq('?coopOnly=0&q=Already%20Ours'), env, data })).json();
  const has = (d) => (d.games || []).some((g) => g.appid === 9300);
  sqlite.exec('DELETE FROM games WHERE id=9301');
  sqlite.exec('DELETE FROM coop_apps WHERE appid=9300');
  return (!has(listed) && has(found))
    || `recommended it: ${has(listed)}; search found it: ${has(found)}`;
});

console.log('\nPersonal Steam import');

sqlite.exec(`INSERT INTO groups (id,slug,name,max_players,created_by)
             VALUES (410,'alice-solo','Alice Solo',1,'${ALICE}')`);
sqlite.exec(`INSERT INTO workspace_settings (group_id,mode) VALUES (410,'personal')`);
sqlite.exec(`INSERT INTO memberships (group_id,steam_id,short_name,role)
             VALUES (410,'${ALICE}','Alice','owner')`);
sqlite.exec(`INSERT INTO games (group_id,name,steam_appid,status)
             VALUES (1,'Same app in co-op',700001,'backlog'),
                    (1,'Foreign achievement target',700002,'sampled'),
                    (410,'Already tracked solo game',700003,'backlog')`);
// Only the cap with explicit provenance may cross from the global catalogue into
// a personal import. A bare number is deliberately treated as unverified.
sqlite.exec(`INSERT INTO coop_apps (appid,name,max_players,max_players_src) VALUES
             (700001,'Imported Solo Game',4,'manual:test'),
             (700005,'Wishlist Solo Game',3,NULL)`);
sqlite.exec(`INSERT INTO coop_apps (appid,name,max_players,max_players_src,coop_categories,is_coop)
             VALUES (700008,'Wishlist Co-op Game',4,'manual:test','["Online Co-op"]',1)`);
sqlite.exec(`INSERT INTO steam_apps (appid,name,coop_categories,fetched_at)
             VALUES (700009,'Wishlist Solo Two','["Single-player"]',unixepoch())`);

const originalFetch = globalThis.fetch;
const steamCalls = [];
globalThis.fetch = async (url) => {
  steamCalls.push(String(url));
  if (String(url).includes('GetOwnedGames')) {
    return new Response(JSON.stringify({ response: { games: [
      { appid: 700001, name: 'Imported Solo Game', playtime_forever: 125,
        rtime_last_played: 1700000000, img_icon_url: 'abcdef1234' },
      { appid: 700003, name: 'Already tracked solo game', playtime_forever: 60,
        rtime_last_played: 1690000000, img_icon_url: 'abcdef5678' },
    ] } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (String(url).includes('GetWishlist')) {
    return new Response(JSON.stringify({ response: { items: [
      { appid: 700005, priority: 0, date_added: 1710000000 },
      { appid: 700008, priority: 0, date_added: 1710001000 },
      { appid: 700009, priority: 0, date_added: 1710002000 },
    ] } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (String(url).includes('IStoreBrowseService/GetItems')) {
    return new Response(JSON.stringify({ response: { store_items: [
      { appid: 700001, name: 'Imported Solo Game' },
      { appid: 700005, name: 'Wishlist Solo Game' },
      { appid: 700008, name: 'Wishlist Co-op Game' },
      { appid: 700009, name: 'Wishlist Solo Two' },
    ] } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (String(url).includes('GetPlayerAchievements')) {
    return new Response(JSON.stringify({ playerstats: { success: true, achievements: [{
      apiname: 'chapter_one', name: 'Chapter One', achieved: 1, unlocktime: 1690000000,
    }] } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response('{}', { status: 404 });
};
env.STEAM_API_KEY = 'test-key';

await check('personal import compares and writes only inside the selected workspace', async () => {
  const { data } = await ctxFor(ALICE, 'alice-solo');
  const preview = await (await steamImportRoute.onRequestPost({
    request: req({ action: 'preview' }), env, data,
  })).json();
  const wishlistPreview = await (await steamImportRoute.onRequestPost({
    request: req({ action: 'preview', source: 'wishlist' }), env, data,
  })).json();
  if (preview.items?.[0]?.appid !== 700001 || !preview.items.some((game) => game.appid === 700005)
      || wishlistPreview.items?.length !== 3
      || !wishlistPreview.items.some((game) => game.appid === 700005)
      || !wishlistPreview.items.some((game) => game.appid === 700008)) {
    return `unexpected previews: ${JSON.stringify({ preview, wishlistPreview })}`;
  }
  const response = await steamImportRoute.onRequestPost({
    request: req({ action: 'import', appids: [700001, 700005, 999999] }), env, data,
  });
  const enrichment = await (await steamImportRoute.onRequestPost({
    request: req({ action: 'enrich' }), env, data,
  })).json();
  const own = sqlite.prepare(
    'SELECT status,hours,finished,max_players FROM games WHERE group_id=410 AND steam_appid=700001'
  ).get();
  const wishlisted = sqlite.prepare(
    'SELECT name,status,hours,max_players FROM games WHERE group_id=410 AND steam_appid=700005'
  ).get();
  const foreign = sqlite.prepare(
    'SELECT COUNT(*) AS n FROM games WHERE group_id=1 AND steam_appid=700001'
  ).get().n;
  const refreshed = sqlite.prepare(
    'SELECT minutes FROM playtime WHERE steam_id=? AND appid=700003'
  ).get(ALICE)?.minutes;
  return (response.status === 201 && own?.status === 'sampled' && own.hours === 2.1
      && own.max_players === 4
      && own.finished === '2023-11-14' && wishlisted?.name === 'Wishlist Solo Game'
      && wishlisted.status === 'backlog' && wishlisted.hours == null && wishlisted.max_players == null
      && foreign === 1 && refreshed === 60 && enrichment.enriched === 0
      && enrichment.remaining >= 2)
    || `status ${response.status}, own ${JSON.stringify(own)}, wishlisted ${JSON.stringify(wishlisted)}, foreign ${foreign}, refreshed ${refreshed}, enrichment ${JSON.stringify(enrichment)}`;
});

await check('co-op workspaces can preview Steam imports and default to co-op games', async () => {
  const { data } = await ctxFor(ALICE, 'g4m1ng');
  const response = await steamImportRoute.onRequestPost({
    request: req({ action: 'preview' }), env, data,
  });
  const preview = await response.json();
  return (response.status === 200 && preview.items?.some((game) => game.appid === 700008)
      && preview.items.every((game) => game.gameType === 'coop'))
    || `status ${response.status}, preview ${JSON.stringify(preview.items)}`;
});

await check('Steam import game-type filters apply across the full candidate set', async () => {
  const { data } = await ctxFor(ALICE, 'alice-solo');
  const solo = await (await steamImportRoute.onRequestPost({
    request: req({ action: 'preview', gameTypes: ['solo'] }), env, data,
  })).json();
  const coop = await (await steamImportRoute.onRequestPost({
    request: req({ action: 'preview', gameTypes: ['coop'] }), env, data,
  })).json();
  return (solo.items?.some((game) => game.appid === 700009)
      && solo.items.every((game) => game.gameType === 'solo')
      && coop.items?.some((game) => game.appid === 700008)
      && coop.items.every((game) => game.gameType === 'coop'))
    || JSON.stringify({ solo: solo.items, coop: coop.items });
});

await check('Steam import separates solo, multiplayer and unknown without changing saved games', async () => {
  const previousFetch = globalThis.fetch;
  const outerWilds = MODE_FIXTURES[0].tags;
  const cases = [
    { appid: 710001, want: 'solo', isCoop: 0, tags: ['Singleplayer', 'Adventure'] },
    { appid: 710002, want: 'solo', isCoop: 1, tags: outerWilds },
    { appid: 710003, want: 'multiplayer', categories: ['Multi-player'] },
    { appid: 710004, want: 'solo', tags: ['Adventure', 'Singleplayer'] },
    { appid: 710005, want: 'unknown' },
    { appid: 710006, want: 'multiplayer', isCoop: 0, tags: ['FPS', 'PvP', 'Multiplayer'],
      categories: ['Co-op', 'Online Co-op'] },
    { appid: 710007, want: 'coop', isCoop: 1, tags: MODE_FIXTURES[1].tags.slice(0, 12),
      categories: ['Online Co-op'] },
    { appid: 710008, want: 'unknown', isCoop: 0 },
    { appid: 710009, want: 'solo', categories: ['Single-player'] },
    { appid: 710010, want: 'coop', isCoop: 1, tags: ['RPG', 'Co-op'],
      steamTags: ['PvP', 'Battle Royale'] },
    { appid: 710011, want: 'coop', categories: ['Single-player', 'Online Co-op'] },
    { appid: 710012, want: 'multiplayer', tags: ['PvP', 'Hero Shooter'], categories: ['Online Co-op'] },
    { appid: 710013, want: 'solo', tags: ['Singleplayer', 'PvE'] },
  ];
  const before = JSON.stringify(sqlite.prepare('SELECT * FROM games ORDER BY id').all());
  const cacheInsert = sqlite.prepare(
    'INSERT INTO steam_apps (appid,name,tags,coop_categories,fetched_at) VALUES (?,?,?,?,unixepoch())');
  const catalogueInsert = sqlite.prepare(
    'INSERT INTO coop_apps (appid,name,tags,coop_categories,is_coop) VALUES (?,?,?,?,?)');
  for (const game of cases) {
    if (game.isCoop != null) catalogueInsert.run(game.appid, `Mode fixture ${game.appid}`,
      game.tags ? JSON.stringify(game.tags) : null, JSON.stringify(game.categories || []), game.isCoop);
    else if (game.tags || game.categories) cacheInsert.run(game.appid, `Mode fixture ${game.appid}`,
      JSON.stringify(game.tags || []), JSON.stringify(game.categories || []));
    if (game.steamTags) cacheInsert.run(game.appid, `Mode fixture ${game.appid}`,
      JSON.stringify(game.steamTags), '[]');
  }
  try {
    globalThis.fetch = async (url) => {
      if (String(url).includes('GetOwnedGames')) return new Response('{"response":{"games":[]}}');
      if (String(url).includes('GetWishlist')) return new Response(JSON.stringify({ response: {
        items: cases.map((game) => ({ appid: game.appid })),
      } }));
      if (String(url).includes('IStoreBrowseService/GetItems')) return new Response(JSON.stringify({ response: {
        store_items: cases.map((game) => ({ appid: game.appid, name: `Mode fixture ${game.appid}` })),
      } }));
      throw new Error(`unexpected Steam call during classification: ${url}`);
    };
    const personal = (await ctxFor(ALICE, 'alice-solo')).data;
    const group = (await ctxFor(ALICE, 'g4m1ng')).data;
    for (const type of ['coop', 'multiplayer', 'solo', 'unknown']) {
      const preview = await (await steamImportRoute.onRequestPost({
        request: req({ action: 'preview', gameTypes: [type] }), env, data: personal,
      })).json();
      const wanted = cases.filter((game) => game.want === type).map((game) => game.appid).sort();
      const got = (preview.items || []).map((game) => game.appid).sort();
      if (JSON.stringify(wanted) !== JSON.stringify(got)
          || preview.items.some((game) => game.gameType !== type)
          || preview.counts.types[type] !== wanted.length) return `${type}: wanted ${wanted}, got ${JSON.stringify(preview)}`;
    }
    const personalPreview = await (await steamImportRoute.onRequestPost({
      request: req({ action: 'preview' }), env, data: personal,
    })).json();
    const groupPreview = await (await steamImportRoute.onRequestPost({
      request: req({ action: 'preview' }), env, data: group,
    })).json();
    const flags = sqlite.prepare('SELECT is_coop FROM coop_apps WHERE appid IN (710001,710002) ORDER BY appid').all();
    return (personalPreview.items.length === cases.length
        && groupPreview.items.length === cases.filter((game) => game.want === 'coop').length
        && groupPreview.items.every((game) => game.gameType === 'coop')
        && flags[0].is_coop === 0 && flags[1].is_coop === 1
        && before === JSON.stringify(sqlite.prepare('SELECT * FROM games ORDER BY id').all()))
      || `defaults or saved data changed: ${JSON.stringify({ personalPreview, groupPreview, flags })}`;
  } finally {
    globalThis.fetch = previousFetch;
    for (const game of cases) {
      sqlite.prepare('DELETE FROM coop_apps WHERE appid=?').run(game.appid);
      sqlite.prepare('DELETE FROM steam_apps WHERE appid=?').run(game.appid);
    }
  }
});

await check('an all-zero Steam library is not silently imported as a real backlog', async () => {
  const visibleFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ response: { games: [{
      appid: 700004, name: 'Privacy Masked Game', playtime_forever: 0, rtime_last_played: 0,
    }] } }), { status: 200, headers: { 'content-type': 'application/json' } });
    const { data } = await ctxFor(ALICE, 'alice-solo');
    const response = await steamImportRoute.onRequestPost({
      request: req({ action: 'import', appids: [700004] }), env, data,
    });
    const inserted = sqlite.prepare(
      'SELECT COUNT(*) AS n FROM games WHERE group_id=410 AND steam_appid=700004'
    ).get().n;
    return (response.status === 409 && inserted === 0) || `status ${response.status}, rows ${inserted}`;
  } finally { globalThis.fetch = visibleFetch; }
});

await check('wishlist-only import works without a readable library or a false ownership watermark', async () => {
  const visibleFetch = globalThis.fetch;
  const visibleKey = env.STEAM_API_KEY;
  try {
    env.STEAM_API_KEY = '';
    sqlite.exec('DELETE FROM group_library_sync WHERE group_id=410');
    globalThis.fetch = async (url) => {
      if (String(url).includes('GetWishlist')) {
        return new Response(JSON.stringify({ response: { items: [
          { appid: 700006, priority: 0, date_added: 1720000000 },
        ] } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (String(url).includes('IStoreBrowseService/GetItems')) {
        return new Response(JSON.stringify({ response: { store_items: [
          { appid: 700006, name: 'Wishlist Without Library' },
        ] } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('{}', { status: 404 });
    };
    const { data } = await ctxFor(ALICE, 'alice-solo');
    const response = await steamImportRoute.onRequestPost({
      request: req({ action: 'import', appids: [700006] }), env, data,
    });
    const inserted = sqlite.prepare(
      'SELECT name,status,hours FROM games WHERE group_id=410 AND steam_appid=700006'
    ).get();
    const watermark = sqlite.prepare(
      'SELECT COUNT(*) AS n FROM group_library_sync WHERE group_id=410'
    ).get().n;
    return (response.status === 201 && inserted?.name === 'Wishlist Without Library'
        && inserted.status === 'backlog' && inserted.hours == null && watermark === 0)
      || `status ${response.status}, inserted ${JSON.stringify(inserted)}, watermark ${watermark}`;
  } finally {
    env.STEAM_API_KEY = visibleKey;
    globalThis.fetch = visibleFetch;
  }
});

await check('large wishlist previews paginate and imports are no longer capped at fifty', async () => {
  const visibleFetch = globalThis.fetch;
  const visibleKey = env.STEAM_API_KEY;
  const wishlist = Array.from({ length: 321 }, (_, index) => ({
    appid: 710000 + index, priority: 0, date_added: 1720000000 + index,
  }));
  try {
    env.STEAM_API_KEY = 'test-key';
    globalThis.fetch = async (url) => {
      const target = String(url);
      if (target.includes('GetOwnedGames')) {
        return new Response(JSON.stringify({ response: { games: [] } }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      if (target.includes('GetWishlist')) {
        return new Response(JSON.stringify({ response: { items: wishlist } }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      if (target.includes('IStoreBrowseService/GetItems')) {
        const input = JSON.parse(new URL(target).searchParams.get('input_json'));
        const storeItems = input.ids.map(({ appid }) => ({ appid, name: `Wishlist ${appid}` }));
        return new Response(JSON.stringify({ response: { store_items: storeItems } }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 404 });
    };
    const { data } = await ctxFor(ALICE, 'alice-solo');
    const first = await (await steamImportRoute.onRequestPost({
      request: req({ action: 'preview', source: 'wishlist' }), env, data,
    })).json();
    const second = await (await steamImportRoute.onRequestPost({
      request: req({ action: 'preview', source: 'wishlist', offset: first.nextOffset }), env, data,
    })).json();
    const response = await steamImportRoute.onRequestPost({
      request: req({ action: 'import', appids: wishlist.slice(0, 121).map((item) => item.appid) }), env, data,
    });
    const imported = await response.json();
    const rows = sqlite.prepare(
      'SELECT COUNT(*) AS n FROM games WHERE group_id=410 AND steam_appid BETWEEN 710000 AND 710120'
    ).get().n;
    return (first.items.length === 250 && first.hasMore && second.items.length === 71
        && !second.hasMore && response.status === 201 && imported.imported === 121 && rows === 121)
      || `pages ${first.items.length}/${second.items.length}, status ${response.status}, imported ${imported.imported}, rows ${rows}`;
  } finally {
    env.STEAM_API_KEY = visibleKey;
    globalThis.fetch = visibleFetch;
  }
});

await check('achievement scan never selects a game from another workspace', async () => {
  steamCalls.length = 0;
  const { data } = await ctxFor(ALICE, 'alice-solo');
  const response = await achievementScanRoute.onRequestPost({
    request: req({ afterId: 0 }), env, data,
  });
  const payload = await response.json();
  const fetchedForeign = steamCalls.some((url) => /appid=700002(?:&|$)/.test(url));
  const progress = sqlite.prepare(
    'SELECT achieved,total FROM achievement_progress WHERE steam_id=? AND appid=700001'
  ).get(ALICE);
  const history = sqlite.prepare(
    `SELECT g.started,f.source FROM games g
       LEFT JOIN game_fact_sources f
         ON f.group_id=g.group_id AND f.game_id=g.id AND f.field='started'
      WHERE g.group_id=410 AND g.steam_appid=700001`
  ).get();
  return (response.status === 200 && payload.processed === 1 && progress?.achieved === 1
      && progress.total === 1 && history?.started === '2023-07-22'
      && history.source === 'achievement' && !fetchedForeign)
    || `status ${response.status}, payload ${JSON.stringify(payload)}, history ${JSON.stringify(history)}, foreign ${fetchedForeign}`;
});

const { completionEvidence } = await import(path.join(SITE, 'lib/completion.js'));
const { buildPersonalStats } = await import(path.join(SITE, 'lib/stats.js'));
await check('completion suggestions require an exact curated terminal achievement', async () => {
  const yes = completionEvidence(264710, [{ key: 'launchrocket' }]);
  const no = completionEvidence(264710, [{ key: 'buildbase' }]);
  const inserted = sqlite.prepare(
    `INSERT INTO games (group_id,name,steam_appid,status)
     VALUES (410,'Subnautica completion test',264710,'sampled')`
  ).run();
  sqlite.prepare(
    `INSERT INTO achievement_progress (steam_id,appid,achieved,total,unlocked)
     VALUES (?,?,?,?,?)`
  ).run(ALICE, 264710, 1, 17, '[{"key":"launchrocket"}]');
  const { data } = await ctxFor(ALICE, 'alice-solo');
  const library = await (await gamesRoute.onRequestGet({ env, data })).json();
  const suggestion = library.games.find((game) => game.id === Number(inserted.lastInsertRowid))
    ?.completionSuggestion;
  sqlite.prepare('DELETE FROM achievement_progress WHERE steam_id=? AND appid=?').run(ALICE, 264710);
  sqlite.prepare('DELETE FROM games WHERE id=? AND group_id=?').run(Number(inserted.lastInsertRowid), 410);
  return (yes?.label === 'Go Among the Stars' && no == null
      && suggestion?.label === 'Go Among the Stars')
    || `${JSON.stringify({ yes, no, suggestion })}`;
});

await check('personal stats keep completion, time, ratings and achievements honest', async () => {
  const stats = buildPersonalStats([
    { id: 1, name: 'Subnautica', steam_appid: 264710, status: 'sampled', effectiveHours: 10, n: 1, raw: 9 },
    { id: 2, name: 'Finished Game', steam_appid: 2, status: 'finished', effectiveHours: 20, n: 1, raw: 7 },
  ], [{ appid: 264710, achieved: 1, total: 5, unlocked: '[{"key":"launchrocket"}]' }]);
  return (stats.completion.rate === 50 && stats.completion.medianFinishedHours === 20
      && stats.ratingDistribution.length === 2 && stats.achievements.unlocked === 1
      && stats.completionSuggestions[0]?.id === 1)
    || JSON.stringify(stats);
});

globalThis.fetch = originalFetch;
env.STEAM_API_KEY = '';

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

console.log('\n"Not interested"');

/* Its own second group: the shared `mallorys` fixture is deleted further up by the
   group-deletion test, so anything reaching for it here gets no membership row. */
sqlite.exec("INSERT INTO groups (id, slug, name, max_players) VALUES (910,'other-crew','Other Crew',4)");
sqlite.exec(`INSERT INTO memberships (group_id, steam_id, short_name, role)
             VALUES (910,'${MALLORY}','Mallory','owner')`);
sqlite.exec(`INSERT INTO coop_apps (appid, name, popularity_rank, is_coop, tags)
             VALUES (9500,'Nobody Wants This',1,1,'["Survival"]')`);
const dismissalRows = () =>
  sqlite.prepare('SELECT group_id, name, steam_id FROM coop_dismissals WHERE appid=9500 ORDER BY group_id').all();

await check('a dismissal is group-scoped and never leaks across the boundary', async () => {
  const alice = await ctxFor(ALICE, 'g4m1ng');
  const other = await ctxFor(MALLORY, 'other-crew');
  const posted = await dismissalsRoute.onRequestPost({ request: req({ appid: 9500 }), env, data: alice.data });
  const mine = await (await dismissalsRoute.onRequestGet({ env, data: alice.data })).json();
  const theirs = await (await dismissalsRoute.onRequestGet({ env, data: other.data })).json();
  const rows = dismissalRows();
  return (posted.status === 200
          && mine.dismissals.length === 1 && mine.dismissals[0].appid === 9500
          && theirs.dismissals.length === 0
          && rows.length === 1 && rows[0].group_id === 1 && rows[0].steam_id === ALICE)
    || `posted ${posted.status}, mine ${mine.dismissals.length}, theirs ${theirs.dismissals.length}, rows ${JSON.stringify(rows)}`;
});

await check('the undo list names who said no, and survives losing the catalogue row', async () => {
  // The crawler DELETEs coop_apps rows it later rejects as DLC or too thin. The
  // stored name is what keeps the undo list from becoming a column of appids.
  sqlite.exec('DELETE FROM coop_apps WHERE appid=9500');
  const { data } = await ctxFor(ALICE, 'g4m1ng');
  const out = await (await dismissalsRoute.onRequestGet({ env, data })).json();
  const row = out.dismissals.find((d) => d.appid === 9500);
  return (row?.name === 'Nobody Wants This' && row.by === 'Ama') || `got ${JSON.stringify(row)}`;
});

await check('any member can undo one, and it clears only their own group', async () => {
  sqlite.exec(`INSERT INTO coop_dismissals (group_id, appid, name, steam_id)
               VALUES (910, 9500, 'Nobody Wants This', '${MALLORY}')`);
  // Bob did not dismiss it and is not an owner. Undo is still his to do, exactly
  // like restoring an archived game.
  const bob = await ctxFor(BOB, 'g4m1ng');
  const out = await dismissalsRoute.onRequestDelete({ request: req({ appid: 9500 }), env, data: bob.data });
  const rows = dismissalRows();
  return (out.status === 200 && rows.length === 1 && rows[0].group_id === 910)
    || `status ${out.status}, left ${JSON.stringify(rows)}`;
});

await check('a game the catalogue never had, and a junk appid, are both refused', async () => {
  sqlite.exec('DELETE FROM coop_dismissals');
  const { data } = await ctxFor(ALICE, 'g4m1ng');
  const noName = await dismissalsRoute.onRequestPost({ request: req({ appid: 999111 }), env, data });
  const junk = await dismissalsRoute.onRequestPost({ request: req({ appid: 'not-a-number' }), env, data });
  const n = sqlite.prepare('SELECT COUNT(*) AS n FROM coop_dismissals').get().n;
  return (noName.status === 400 && junk.status === 400 && n === 0)
    || `noName ${noName.status}, junk ${junk.status}, rows ${n}`;
});

console.log('\nDefault workspace');

// A second workspace for Alice, so "replaces the first" has something to replace.
sqlite.exec("INSERT INTO groups (id, slug, name, max_players) VALUES (900,'alices-other','Alices Other',4)");
sqlite.exec(`INSERT INTO memberships (group_id, steam_id, short_name, role) VALUES (900,'${ALICE}','Ama','owner')`);

const defaultsFor = (steamId) => sqlite.prepare(
  `SELECT g.slug FROM member_preferences p JOIN groups g ON g.id = p.group_id
    WHERE p.steam_id = ? AND p.default_workspace = 1`
).all(steamId).map((r) => r.slug);

const setDefault = (steamId, defaultGroup) => meRoute.onRequestPatch({
  request: req({ defaultGroup }), env, data: { user: user(steamId) },
});

await check('starring a workspace comes back on /api/me', async () => {
  const patched = await setDefault(ALICE, 'g4m1ng');
  if (patched.status !== 200) return `patch returned ${patched.status}`;
  const me = await (await meRoute.onRequestGet({
    env, data: { user: user(ALICE) }, waitUntil: () => {},
  })).json();
  const flagged = me.groups.filter((g) => g.is_default).map((g) => g.slug);
  return (flagged.length === 1 && flagged[0] === 'g4m1ng') || `flagged ${JSON.stringify(flagged)}`;
});

await check('a workspace you are not in is starrable-404, exactly like one that does not exist', async () => {
  // Mallory has joined g4m1ng by code further up, so the outsider here is a fresh
  // account in nothing at all — otherwise this would assert nothing.
  const OUTSIDER = '76561198000000009';
  sqlite.exec(`INSERT INTO users (steam_id, display_name) VALUES ('${OUTSIDER}','Outsider')`);
  const real = await setDefault(OUTSIDER, 'g4m1ng');
  const fake = await setDefault(OUTSIDER, 'does-not-exist');
  const wrote = defaultsFor(OUTSIDER);
  return (real.status === 404 && fake.status === 404 && wrote.length === 0)
    || `real ${real.status}, fake ${fake.status}, wrote ${JSON.stringify(wrote)}`;
});

await check('starring a second workspace replaces the first', async () => {
  const out = await setDefault(ALICE, 'alices-other');
  const defaults = defaultsFor(ALICE);
  return (out.status === 200 && defaults.length === 1 && defaults[0] === 'alices-other')
    || `status ${out.status}, defaults ${JSON.stringify(defaults)}`;
});

await check('clearing the default leaves none', async () => {
  const out = await setDefault(ALICE, null);
  const defaults = defaultsFor(ALICE);
  return (out.status === 200 && defaults.length === 0)
    || `status ${out.status}, defaults ${JSON.stringify(defaults)}`;
});

await check('leaving a workspace clears it as your default', async () => {
  await setDefault(ALICE, 'alices-other');
  if (defaultsFor(ALICE)[0] !== 'alices-other') return 'could not set up the default';
  sqlite.prepare('DELETE FROM memberships WHERE group_id = 900 AND steam_id = ?').run(ALICE);
  // Cascade, not cleanup code: the boot path must never be pointed at a
  // workspace the caller has left.
  return defaultsFor(ALICE).length === 0 || 'a default survived leaving the group';
});

console.log('\nReplay appetite');

const replayOf = (gameId, steamId) =>
  sqlite.prepare('SELECT score, replay FROM ratings WHERE game_id=? AND steam_id=?').get(gameId, steamId);

await check('a replay answer round-trips and travels with the library', async () => {
  const { data } = await ctxFor(ALICE, 'g4m1ng');
  const out = await rateRoute.onRequestPost({
    request: req({ gameId: 7003, score: 8, replay: 'no' }), env, data,
  });
  if (out.status !== 200) return `rate returned ${out.status}`;
  const lib = await (await gamesRoute.onRequestGet({ env, data })).json();
  const game = lib.games.find((g) => g.id === 7003);
  return game?.replay?.[ALICE] === 'no' || `library says ${JSON.stringify(game?.replay)}`;
});

await check('an ordinary save leaves an answer given earlier alone', async () => {
  // The card only asks this on a minority of games; a later save from the Played
  // tab must not clear it as a side effect of not mentioning it.
  const { data } = await ctxFor(ALICE, 'g4m1ng');
  await rateRoute.onRequestPost({ request: req({ gameId: 7003, score: 9 }), env, data });
  const row = replayOf(7003, ALICE);
  return (row.score === 9 && row.replay === 'no') || `score ${row.score}, replay ${row.replay}`;
});

await check('an invented replay value is rejected, and takes the score down with it', async () => {
  const { data } = await ctxFor(ALICE, 'g4m1ng');
  const out = await rateRoute.onRequestPost({
    request: req({ gameId: 7003, score: 4, replay: 'never ever' }), env, data,
  });
  const row = replayOf(7003, ALICE);
  return (out.status === 400 && row.score === 9 && row.replay === 'no')
    || `status ${out.status}, score ${row.score}, replay ${row.replay}`;
});

await check('sending null clears the answer on purpose', async () => {
  const { data } = await ctxFor(ALICE, 'g4m1ng');
  await rateRoute.onRequestPost({ request: req({ gameId: 7003, score: 9, replay: null }), env, data });
  return replayOf(7003, ALICE).replay === null || `got ${replayOf(7003, ALICE).replay}`;
});

await check('who has already played it comes from Steam, with an hour floor', async () => {
  /* Its own fixture: an earlier test deletes two players' playtime to check the
     estimate degrades, so reusing those rows would assert the floor while actually
     measuring the deletion. */
  sqlite.exec("INSERT INTO games (id, group_id, name, steam_appid, status) VALUES (7500,1,'Floor Test',900500,'backlog')");
  mins(PLAYERS[0], 900500, 600);   // ten hours: played it
  mins(PLAYERS[1], 900500, 30);    // half an hour: a look, not a play
  mins(PLAYERS[2], 900500, 0);     // owns it, never launched it
  const { data } = await ctxFor(ALICE, 'g4m1ng');
  const lib = await (await gamesRoute.onRequestGet({ env, data })).json();
  const game = lib.games.find((g) => g.id === 7500);
  const played = new Set(game?.playedBy || []);
  const owns = game?.ownership || {};
  return (played.has(PLAYERS[0]) && !played.has(PLAYERS[1]) && !played.has(PLAYERS[2])
          // …while all three still count as owning it: the two are different facts.
          && owns[PLAYERS[1]] === true && owns[PLAYERS[2]] === true)
    || `playedBy ${JSON.stringify([...played])}, ownership ${JSON.stringify(owns)}`;
});

console.log('\nPrice parsing');

/* Read the parser out of public/app.js rather than restating it here, the same way
   scripts/validate-palette.mjs reads SERIES: a second copy of a parser is a second
   copy that goes stale, and a test passing against a version the site does not use
   is worse than no test. */
const appSource = fs.readFileSync(path.join(SITE, 'public', 'app.js'), 'utf8');
const priceBlock = /const priceCents = \(text\) => \{[\s\S]*?\n\};/.exec(appSource);
if (!priceBlock) throw new Error('could not find priceCents in public/app.js');
const priceCents = new Function(`${priceBlock[0]}\nreturn priceCents;`)();

await check('Steam price strings parse to cents, and an unknown price stays unknown', async () => {
  const cases = [
    ['29,99€', 2999],        // what Steam actually returns for cc=de
    ['9,75€', 975],
    ['Free', 0],             // lib/steam.js writes this literal for is_free
    ['19.99', 1999],         // the same number in the other locale
    ['1.234,56 €', 123456],  // thousands separator on the far side of the decimal
    ['1.234', 123400],       // no decimals: that dot groups thousands
    [null, null],
    ['', null],
    ['TBA', null],
  ];
  const wrong = cases.filter(([input, want]) => priceCents(input) !== want);
  return !wrong.length
    || `wrong: ${JSON.stringify(wrong.map(([input]) => [input, priceCents(input)]))}`;
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

console.log('\nGroup activity');

const ACT_A = '76561198000510001';
const ACT_B = '76561198000510002';
const ACT_C = '76561198000510003';
sqlite.prepare('INSERT INTO users (steam_id,display_name) VALUES (?,?),(?,?),(?,?)')
  .run(ACT_A, 'Activity Alice', ACT_B, 'Activity Bob', ACT_C, 'Activity Carol');

async function withActivity(fn) {
  sqlite.exec(`INSERT INTO groups (id,slug,name,blind_rating) VALUES
    (5101,'activity-team','Activity Team',1),(5102,'activity-other','Other Activity',0)`);
  const member = sqlite.prepare('INSERT INTO memberships (group_id,steam_id,short_name,role) VALUES (?,?,?,?)');
  member.run(5101, ACT_A, 'Alice', 'owner');
  member.run(5101, ACT_B, 'Bob', 'member');
  member.run(5102, ACT_A, 'Alice', 'member');
  member.run(5102, ACT_C, 'Carol', 'owner');
  const game = sqlite.prepare('INSERT INTO games (group_id,name,status) VALUES (?,?,?)');
  const first = Number(game.run(5101, 'First Activity Game', 'playing').lastInsertRowid);
  const second = Number(game.run(5101, 'Second Activity Game', 'backlog').lastInsertRowid);
  const foreign = Number(game.run(5102, 'Private Other Game', 'playing').lastInsertRowid);
  const f = {
    first, second, foreign,
    a: (await ctxFor(ACT_A, 'activity-team')).data,
    b: (await ctxFor(ACT_B, 'activity-team')).data,
    other: (await ctxFor(ACT_C, 'activity-other')).data,
    otherReader: (await ctxFor(ACT_A, 'activity-other')).data,
    feed: async (data) => (await activityRoute.onRequestGet({ env, data })).json(),
    mark: (data, throughId) => activityRoute.onRequestPost({ env, data, request: req({ throughId }) }),
    markItem: (data, itemId) => activityRoute.onRequestPost({ env, data, request: req({ itemId }) }),
    rate: (gameId, score, data) => rateRoute.onRequestPost({ env, data, request: req({ gameId, score, comment: 'Secret rating explanation' }) }),
    comment: (gameId, data) => commentsRoute.onRequestPost({ env, data, request: req({ gameId, body: 'Secret comment body' }) }),
    align: () => sqlite.prepare('UPDATE group_activity SET created_at=? WHERE group_id=5101')
      .run(Math.floor(Date.now() / 600000) * 600),
  };
  try { return await fn(f); }
  finally { sqlite.exec('DELETE FROM groups WHERE id IN (5101,5102)'); }
}

await check('activity GET and POST use the 404 tenancy boundary', () => withActivity(async () => {
  for (const method of ['onRequestGet', 'onRequestPost']) {
    const data = { user: user(ACT_C) };
    let reached = false;
    const response = await groupMw.onRequest({ env, data, params: { slug: 'activity-team' },
      request: req({ throughId: 0 }), next: async () => {
        reached = true;
        return activityRoute[method]({ env, data, request: req({ throughId: 0 }) });
      } });
    if (reached || response.status !== 404) return `${method} leaked membership`;
  }
  return true;
}));

await check('activity is group-scoped even for a reader belonging to both groups', () => withActivity(async (f) => {
  await f.comment(f.foreign, f.other);
  const local = await f.feed(f.a);
  const other = await f.feed(f.otherReader);
  return (local.unreadCount === 0 && !local.items.length && other.unreadCount === 1
      && !JSON.stringify(local).includes('Private Other Game'))
    || JSON.stringify({ local, other });
}));

await check('game additions capture successful manual and bulk inserts without duplicate news', () => withActivity(async (f) => {
  const response = await gamesRoute.onRequestPost({ env, data: f.b,
    request: req({ manual: true, name: 'New Activity Game' }) });
  const duplicate = await gamesRoute.onRequestPost({ env, data: f.b,
    request: req({ manual: true, name: 'New Activity Game' }) });
  const insert = sqlite.prepare('INSERT OR IGNORE INTO games (group_id,name,steam_appid,added_by) VALUES (5101,?,?,?)');
  insert.run('Bulk Activity Game', 951001, ACT_B);
  insert.run('Bulk Activity Game', 951001, ACT_B);
  f.align();
  const feed = await f.feed(f.a);
  return (response.status === 201 && duplicate.status === 409 && feed.unreadCount === 1
      && feed.items[0]?.kind === 'game_added' && feed.items[0]?.gameCount === 2 && feed.items[0]?.actions === 2)
    || JSON.stringify({ status: response.status, duplicate: duplicate.status, feed });
}));

await check('blind activity groups ratings without scores, explanations or replay answers', () => withActivity(async (f) => {
  await f.rate(f.first, 8.5, f.b);
  await f.rate(f.second, 9, f.b);
  f.align();
  const feed = await f.feed(f.a);
  const text = JSON.stringify(feed);
  return (feed.unreadCount === 1 && feed.items.length === 1 && feed.items[0].gameCount === 2
      && feed.items[0].kind === 'rating' && feed.items[0].actor === 'Bob'
      && !/"score"|"replay"|Secret rating explanation/.test(text)) || text;
}));

await check('own actions never inflate the unread badge or the activity list', () => withActivity(async (f) => {
  await f.rate(f.first, 7, f.a);
  await f.comment(f.first, f.a);
  const feed = await f.feed(f.a);
  return (feed.unreadCount === 0 && feed.items.length === 0) || JSON.stringify(feed);
}));

await check('status news records the actual transition and ignores unchanged detail saves', () => withActivity(async (f) => {
  for (const patch of [{ status: 'dropped' }, { status: 'dropped', genre: 'Survival' }]) {
    const response = await gameIdRoute.onRequestPatch({ env, data: f.b,
      params: { id: String(f.first) }, request: req(patch) });
    if (response.status !== 200) return `patch ${response.status}`;
  }
  const feed = await f.feed(f.a);
  return (feed.items.length === 1 && feed.items[0].kind === 'status_changed'
      && feed.items[0].actor === 'Bob' && feed.items[0].fromStatus === 'playing'
      && feed.items[0].toStatus === 'dropped' && feed.items[0].actions === 1) || JSON.stringify(feed);
}));

await check('status edits collapse per game while different kinds and actors stay distinct', () => withActivity(async (f) => {
  for (const status of ['dropped', 'finished']) {
    await gameIdRoute.onRequestPatch({ env, data: f.b,
      params: { id: String(f.first) }, request: req({ status }) });
  }
  await gameIdRoute.onRequestPatch({ env, data: f.b,
    params: { id: String(f.second) }, request: req({ status: 'playing' }) });
  await f.comment(f.first, f.b);
  sqlite.prepare('INSERT INTO memberships (group_id,steam_id,short_name) VALUES (5101,?,?)').run(ACT_C, 'Carol');
  const carol = (await ctxFor(ACT_C, 'activity-team')).data;
  await f.rate(f.first, 7, f.b);
  await f.rate(f.second, 8, carol);
  f.align();
  const feed = await f.feed(f.a);
  const transition = feed.items.find((item) => item.kind === 'status_changed' && item.gameId === f.first);
  return (feed.unreadCount === 5 && feed.items.length === 5 && transition?.fromStatus === 'playing'
      && transition?.toStatus === 'finished' && transition?.actions === 2)
    || JSON.stringify(feed);
}));

await check('a rejected cross-group status patch cannot manufacture activity', () => withActivity(async (f) => {
  const response = await gameIdRoute.onRequestPatch({ env, data: f.a,
    params: { id: String(f.foreign) }, request: req({ status: 'dropped' }) });
  const own = await f.feed(f.a);
  const other = await f.feed(f.otherReader);
  return (response.status === 404 && own.items.length === 0 && other.items.length === 0)
    || JSON.stringify({ status: response.status, own, other });
}));

await check('repeated edits collapse while new edits after acknowledgement become unread', () => withActivity(async (f) => {
  await f.rate(f.first, 7, f.b);
  await f.rate(f.first, 8, f.b);
  await f.rate(f.first, 8, f.b);
  f.align();
  const before = await f.feed(f.a);
  if (before.items.length !== 1 || before.items[0].actions !== 2 || before.items[0].gameCount !== 1) return JSON.stringify(before);
  await f.mark(f.a, before.latestId);
  const read = await f.feed(f.a);
  await f.rate(f.first, 9, f.b);
  f.align();
  const after = await f.feed(f.a);
  return (read.unreadCount === 0 && !read.items[0].unread && after.unreadCount === 1
      && after.items.length === 1 && after.items[0].unread) || JSON.stringify({ read, after });
}));

await check('mark all reads only its snapshot and preserves events that arrived afterwards', () => withActivity(async (f) => {
  await f.rate(f.first, 7, f.b);
  const before = await f.feed(f.a);
  await f.comment(f.first, f.b);
  const response = await f.mark(f.a, before.latestId);
  const after = await f.feed(f.a);
  return (response.status === 200 && after.unreadCount === 1
      && after.items.find((item) => item.kind === 'comment')?.unread
      && !after.items.find((item) => item.kind === 'rating')?.unread) || JSON.stringify(after);
}));

await check('read cursors persist per member, remain monotonic and never cross groups', () => withActivity(async (f) => {
  await f.rate(f.first, 7, f.b);
  const early = await f.feed(f.a);
  await f.comment(f.first, f.b);
  const later = await f.feed(f.a);
  await f.comment(f.second, f.a);
  await f.comment(f.foreign, f.other);
  await f.mark(f.a, later.latestId);
  await f.mark(f.a, early.latestId);
  const secondDevice = await f.feed((await ctxFor(ACT_A, 'activity-team')).data);
  const bob = await f.feed(f.b);
  const other = await f.feed(f.otherReader);
  return (secondDevice.unreadCount === 0 && bob.unreadCount === 1 && other.unreadCount === 1)
    || JSON.stringify({ secondDevice, bob, other });
}));

await check('foreign and fabricated activity ids cannot change a group read cursor', () => withActivity(async (f) => {
  await f.comment(f.first, f.b);
  await f.comment(f.foreign, f.other);
  const foreign = await f.feed(f.otherReader);
  const response = await f.mark(f.a, foreign.latestId);
  const fabricated = await f.mark(f.a, foreign.latestId + 100000);
  const feed = await f.feed(f.a);
  const rows = sqlite.prepare('SELECT COUNT(*) AS n FROM activity_reads WHERE group_id=5101').get().n;
  return (response.status === 404 && fabricated.status === 404 && feed.unreadCount === 1 && rows === 0)
    || `statuses ${response.status}/${fabricated.status}, cursor rows ${rows}, ${JSON.stringify(feed)}`;
}));

await check('activity cursor validation rejects missing, negative, fractional and string ids', () => withActivity(async (f) => {
  for (const throughId of [undefined, null, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1]) {
    const response = await f.mark(f.a, throughId);
    if (response.status !== 400) return `${throughId}: ${response.status}`;
  }
  return (await f.mark(f.a, 0)).status === 200 || 'empty snapshot rejected';
}));

await check('clicking one notification leaves both older and newer notifications unread', () => withActivity(async (f) => {
  await f.comment(f.first, f.b);
  await f.rate(f.first, 7, f.b);
  const selected = (await f.feed(f.a)).items.find((item) => item.kind === 'rating');
  await f.comment(f.second, f.b);
  const response = await f.markItem(f.a, selected.id);
  const feed = await f.feed(f.a);
  const cursors = sqlite.prepare('SELECT COUNT(*) AS n FROM activity_reads WHERE group_id=5101').get().n;
  return (response.status === 200 && feed.unreadCount === 2 && cursors === 0
    && !feed.items.find((item) => item.kind === 'rating').unread
    && feed.items.filter((item) => item.kind === 'comment').every((item) => item.unread)) || JSON.stringify(feed);
}));

await check('individual reads acknowledge every game in a grouped rating snapshot but no later edits', () => withActivity(async (f) => {
  await f.rate(f.first, 7, f.b);
  await f.rate(f.second, 8, f.b);
  f.align();
  const selected = (await f.feed(f.a)).items[0];
  await f.rate(f.first, 9, f.b);
  f.align();
  await f.markItem(f.a, selected.id);
  const afterArrival = await f.feed(f.a);
  const receipts = sqlite.prepare('SELECT COUNT(*) AS n FROM activity_item_reads WHERE group_id=5101').get().n;
  await f.markItem(f.a, afterArrival.items[0].id);
  const read = await f.feed(f.a);
  await f.rate(f.second, 6, f.b);
  f.align();
  const afterRead = await f.feed(f.a);
  return (selected.gameCount === 2 && selected.actions === 2 && receipts === 2
    && afterArrival.items.length === 1 && afterArrival.unreadCount === 1
    && read.unreadCount === 0 && afterRead.unreadCount === 1) || JSON.stringify({ selected, receipts, afterArrival, read, afterRead });
}));

await check('individual reads match the feed window, actor, kind and per-game grouping', () => withActivity(async (f) => {
  const old = await (await f.comment(f.first, f.b)).json();
  await f.comment(f.first, f.b);
  await f.comment(f.first, f.b);
  await f.comment(f.second, f.b);
  await f.rate(f.first, 7, f.b);
  sqlite.prepare('INSERT INTO memberships (group_id,steam_id,short_name) VALUES (5101,?,?)').run(ACT_C, 'Carol');
  await f.comment(f.first, { ...f.b, user: { ...f.b.user, steam_id: ACT_C } });
  f.align();
  sqlite.prepare('UPDATE group_activity SET created_at=created_at-600 WHERE group_id=5101 AND comment_id=?').run(old.id);
  const before = await f.feed(f.a);
  const selected = before.items.find((item) => item.kind === 'comment' && item.actor === 'Bob' && item.actions === 2);
  await f.markItem(f.a, selected.id);
  const feed = await f.feed(f.a);
  return (before.unreadCount === 5 && feed.unreadCount === 4
    && feed.items.filter((item) => !item.unread).length === 1
    && !feed.items.find((item) => item.id === selected.id).unread) || JSON.stringify({ before, feed });
}));

await check('individual reads persist across devices, are idempotent and stay per member and group', () => withActivity(async (f) => {
  await f.rate(f.first, 7, f.b);
  await f.comment(f.second, f.a);
  await f.comment(f.foreign, f.other);
  const selected = (await f.feed(f.a)).items[0];
  await f.markItem(f.a, selected.id);
  const repeated = await f.markItem(f.a, selected.id);
  const secondDevice = await f.feed((await ctxFor(ACT_A, 'activity-team')).data);
  const bob = await f.feed(f.b);
  const other = await f.feed(f.otherReader);
  const rows = sqlite.prepare('SELECT COUNT(*) AS n FROM activity_item_reads WHERE group_id=5101').get().n;
  return (repeated.status === 200 && rows === 1 && secondDevice.unreadCount === 0
    && bob.unreadCount === 1 && other.unreadCount === 1) || JSON.stringify({ rows, secondDevice, bob, other });
}));

await check('mark all continues clearing remaining notifications after individual reads', () => withActivity(async (f) => {
  await f.rate(f.first, 7, f.b);
  const selected = (await f.feed(f.a)).items[0];
  await f.markItem(f.a, selected.id);
  await f.comment(f.second, f.b);
  const snapshot = await f.feed(f.a);
  await f.mark(f.a, snapshot.latestId);
  await f.markItem(f.a, selected.id);
  const read = await f.feed(f.a);
  await f.rate(f.first, 9, f.b);
  f.align();
  const later = await f.feed(f.a);
  return (snapshot.unreadCount === 1 && read.unreadCount === 0 && later.unreadCount === 1
    && later.items.find((item) => item.kind === 'rating').unread) || JSON.stringify({ snapshot, read, later });
}));

await check('foreign, own, expired and fabricated individual activity ids return 404 without read state', () => withActivity(async (f) => {
  await f.comment(f.first, f.a);
  await f.comment(f.first, f.b);
  await f.comment(f.foreign, f.other);
  const own = (await f.feed(f.b)).items[0].id;
  const expired = (await f.feed(f.a)).items[0].id;
  sqlite.prepare('UPDATE group_activity SET created_at=unixepoch()-7776001 WHERE group_id=5101 AND id=?').run(expired);
  const foreign = (await f.feed(f.otherReader)).items[0].id;
  for (const id of [own, expired, foreign, foreign + 100000]) {
    const response = await f.markItem(f.a, id);
    if (response.status !== 404) return `${id}: ${response.status}`;
  }
  return sqlite.prepare('SELECT COUNT(*) AS n FROM activity_item_reads WHERE group_id=5101').get().n === 0 || 'unexpected receipts';
}));

await check('individual read validation rejects invalid ids and ambiguous mark-all requests', () => withActivity(async (f) => {
  for (const itemId of [undefined, null, 0, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1]) {
    const response = await f.markItem(f.a, itemId);
    if (response.status !== 400) return `${itemId}: ${response.status}`;
  }
  for (const payload of [{ itemId: 1, throughId: 0 }, { itemId: null, throughId: 0 }, { itemId: 1, throughId: null }]) {
    const response = await activityRoute.onRequestPost({ env, data: f.a, request: req(payload) });
    if (response.status !== 400) return `${JSON.stringify(payload)}: ${response.status}`;
  }
  return true;
}));

await check('individual read receipts cascade with comments, retention and only the departing member', () => withActivity(async (f) => {
  const comment = await (await f.comment(f.first, f.b)).json();
  await f.markItem(f.a, (await f.feed(f.a)).items[0].id);
  await commentsRoute.onRequestDelete({ env, data: f.b, request: req({ id: comment.id }) });
  const rows = () => sqlite.prepare('SELECT COUNT(*) AS n FROM activity_item_reads WHERE group_id=5101').get().n;
  if (rows() !== 0) return 'comment receipt survived deletion';
  await f.rate(f.first, 7, f.b);
  await f.markItem(f.a, (await f.feed(f.a)).items[0].id);
  sqlite.prepare('UPDATE group_activity SET created_at=unixepoch()-7776001 WHERE group_id=5101').run();
  await f.comment(f.first, f.a);
  if (rows() !== 0) return 'expired receipt survived retention';
  await f.markItem(f.b, (await f.feed(f.b)).items[0].id);
  await f.comment(f.second, f.b);
  await f.markItem(f.a, (await f.feed(f.a)).items[0].id);
  sqlite.prepare('DELETE FROM memberships WHERE group_id=5101 AND steam_id=?').run(ACT_A);
  const remaining = sqlite.prepare('SELECT steam_id FROM activity_item_reads WHERE group_id=5101').all();
  return (remaining.length === 1 && remaining[0].steam_id === ACT_B) || JSON.stringify(remaining);
}));

await check('individual read migration is additive and idempotent with existing cursors and receipts', () => withActivity(async (f) => {
  await f.rate(f.first, 7, f.b);
  const selected = (await f.feed(f.a)).items[0];
  await f.mark(f.a, selected.id);
  await f.markItem(f.a, selected.id);
  const snapshot = () => JSON.stringify(['games', 'ratings', 'comments', 'group_activity', 'activity_reads', 'activity_item_reads']
    .map((table) => sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
  const before = snapshot();
  const migration = fs.readFileSync(path.join(SITE, 'migrations/037-activity-item-reads.sql'), 'utf8');
  sqlite.exec(migration);
  sqlite.exec(migration);
  return (snapshot() === before && sqlite.prepare('PRAGMA foreign_key_check').all().length === 0) || 'replay changed existing data';
}));

await check('the unread total includes groups beyond the forty-item display limit', () => withActivity(async (f) => {
  const now = Math.floor(Date.now() / 1000);
  for (let i = 0; i < 45; i++) {
    const response = await f.comment(f.first, f.b);
    const { id } = await response.json();
    sqlite.prepare('UPDATE group_activity SET created_at=? WHERE group_id=5101 AND comment_id=?').run(now - i * 600, id);
  }
  const feed = await f.feed(f.a);
  await f.mark(f.a, feed.latestId);
  const after = await f.feed(f.a);
  return (feed.items.length === 40 && feed.unreadCount === 45 && after.unreadCount === 0)
    || `items ${feed.items.length}, unread ${feed.unreadCount} -> ${after.unreadCount}`;
}));

await check('deleted comments do not leave dead notifications or unread counts', () => withActivity(async (f) => {
  const comment = await (await f.comment(f.first, f.b)).json();
  const before = await f.feed(f.a);
  await commentsRoute.onRequestDelete({ env, data: f.b, request: req({ id: comment.id }) });
  const after = await f.feed(f.a);
  return (before.unreadCount === 1 && after.unreadCount === 0 && after.items.length === 0)
    || JSON.stringify({ before, after });
}));

await check('seed claims, metadata refreshes and personal workspaces do not manufacture activity', () => withActivity(async (f) => {
  sqlite.prepare('INSERT INTO users (steam_id,display_name) VALUES (?,?)').run('seed:5101:someone', 'Seed Someone');
  sqlite.prepare('INSERT INTO memberships (group_id,steam_id,short_name,is_seed) VALUES (5101,?,?,1)')
    .run('seed:5101:someone', 'Seed');
  sqlite.prepare('INSERT INTO ratings (game_id,steam_id,score) VALUES (?,?,7)').run(f.first, 'seed:5101:someone');
  sqlite.prepare('UPDATE ratings SET steam_id=? WHERE game_id=? AND steam_id=?').run(ACT_B, f.first, 'seed:5101:someone');
  sqlite.prepare('UPDATE games SET header_image=? WHERE id=? AND group_id=5101').run('https://example.test/image.jpg', f.first);
  const before = await f.feed(f.a);
  sqlite.exec("INSERT INTO workspace_settings (group_id,mode) VALUES (5101,'personal')");
  await f.rate(f.first, 9, f.b);
  await f.comment(f.first, f.b);
  await gamesRoute.onRequestPost({ env, data: f.b, request: req({ manual: true, name: 'Personal Addition' }) });
  await gameIdRoute.onRequestPatch({ env, data: f.b, params: { id: String(f.first) }, request: req({ status: 'dropped' }) });
  const after = await f.feed(f.a);
  sqlite.prepare('DELETE FROM users WHERE steam_id=?').run('seed:5101:someone');
  return (before.items.length === 0 && after.items.length === 0) || JSON.stringify({ before, after });
}));

await check('activity migration is additive, idempotent and never backfills existing history', () => withActivity(async (f) => {
  await f.rate(f.first, 7, f.b);
  const snapshot = () => JSON.stringify({
    games: sqlite.prepare('SELECT * FROM games ORDER BY id').all(),
    ratings: sqlite.prepare('SELECT * FROM ratings ORDER BY game_id,steam_id').all(),
    activity: sqlite.prepare('SELECT * FROM group_activity ORDER BY id').all(),
  });
  const before = snapshot();
  const migration = fs.readFileSync(path.join(SITE, 'migrations/036-group-activity.sql'), 'utf8');
  sqlite.exec(migration);
  sqlite.exec(migration);
  return snapshot() === before || 'replay changed existing data or activity';
}));

await check('old activity expires and leaving a group clears only that member read state', () => withActivity(async (f) => {
  await f.rate(f.first, 7, f.b);
  const before = await f.feed(f.a);
  await f.mark(f.a, before.latestId);
  sqlite.prepare('UPDATE group_activity SET created_at=unixepoch()-7776001 WHERE group_id=5101').run();
  await f.comment(f.first, f.b);
  const rows = sqlite.prepare('SELECT COUNT(*) AS n FROM group_activity WHERE group_id=5101').get().n;
  sqlite.prepare('DELETE FROM memberships WHERE group_id=5101 AND steam_id=?').run(ACT_A);
  const reads = sqlite.prepare('SELECT COUNT(*) AS n FROM activity_reads WHERE group_id=5101').get().n;
  return (rows === 1 && reads === 0) || `events ${rows}, reads ${reads}`;
}));

console.log('\nRegular sessions');

const scheduleRoute = await import(path.join(SITE, 'functions/api/g/[slug]/schedule.js'));
const sched = await import(path.join(SITE, 'lib/schedule.js'));
const { claimSeedIdentity } = await import(path.join(SITE, 'lib/groups.js'));
const SCH_A = '76561198000520001';
const SCH_B = '76561198000520002';
const SCH_C = '76561198000520003';
sqlite.prepare('INSERT INTO users (steam_id,display_name) VALUES (?,?),(?,?),(?,?)')
  .run(SCH_A, 'Schedule Alice', SCH_B, 'Schedule Bob', SCH_C, 'Schedule Carol');

// Every day, so a session is always one or two days away whatever day the suite runs.
const DAILY = { weekdays: [1, 2, 3, 4, 5, 6, 7], time: '20:30', timezone: 'Europe/Berlin',
                everyWeeks: 1, startDate: '2026-01-05', durationMin: 180 };

async function withSchedule(fn) {
  sqlite.exec(`INSERT INTO groups (id,slug,name) VALUES
    (5201,'schedule-team','Schedule Team'),(5202,'schedule-other','Other Schedule'),
    (5203,'schedule-solo','Solo Schedule')`);
  sqlite.exec("INSERT INTO workspace_settings (group_id,mode) VALUES (5203,'personal')");
  sqlite.exec("INSERT INTO users (steam_id,display_name) VALUES ('seed:5201:zed','Zed (unclaimed)')");
  const member = sqlite.prepare('INSERT INTO memberships (group_id,steam_id,short_name,role,is_seed) VALUES (?,?,?,?,?)');
  member.run(5201, SCH_A, 'Alice', 'owner', 0);
  member.run(5201, SCH_B, 'Bob', 'member', 0);
  member.run(5201, 'seed:5201:zed', 'Zed', 'member', 1);
  member.run(5202, SCH_C, 'Carol', 'owner', 0);
  member.run(5203, SCH_A, 'Alice', 'owner', 0);
  const f = {
    a: (await ctxFor(SCH_A, 'schedule-team')).data,
    b: (await ctxFor(SCH_B, 'schedule-team')).data,
    other: (await ctxFor(SCH_C, 'schedule-other')).data,
    solo: (await ctxFor(SCH_A, 'schedule-solo')).data,
    get: async (data) => (await scheduleRoute.onRequestGet({ env, data })).json(),
    put: (data, rule) => scheduleRoute.onRequestPut({ env, data, request: req(rule) }),
    post: (data, input) => scheduleRoute.onRequestPost({ env, data, request: req(input) }),
    rows: (table) => sqlite.prepare(`SELECT * FROM ${table} WHERE group_id=5201 ORDER BY rowid`).all(),
    // Not the first session: that one may already be in progress when the suite runs.
    sessions: () => sched.upcomingSessions(sched.parseRule(DAILY).rule, Date.now(), 4),
  };
  try { return await fn(f); }
  finally {
    sqlite.exec('DELETE FROM groups WHERE id IN (5201,5202,5203)');
    sqlite.exec("DELETE FROM users WHERE steam_id='seed:5201:zed'");
  }
}

await check('schedule GET, PUT and POST sit behind the 404 tenancy boundary', () => withSchedule(async () => {
  const outsider = { user: user(MALLORY), steamId: MALLORY };
  const response = await groupMw.onRequest({ env, data: outsider, params: { slug: 'schedule-team' },
    next: async () => 'LEAKED' });
  return (response?.status === 404) || `outsider got ${response?.status ?? response}`;
}));

await check('only the owner sets the regular session; a member gets 403 and nothing changes', () => withSchedule(async (f) => {
  const denied = await f.put(f.b, DAILY);
  const before = f.rows('session_schedules').length;
  const ok = await f.put(f.a, DAILY);
  const after = f.rows('session_schedules');
  const removed = await scheduleRoute.onRequestDelete({ env, data: f.b });
  return (denied.status === 403 && before === 0 && ok.status === 200 && after.length === 1
    && after[0].updated_by === SCH_A && removed.status === 403 && f.rows('session_schedules').length === 1)
    || JSON.stringify({ denied: denied.status, before, ok: ok.status, after, removed: removed.status });
}));

await check('invalid rules are rejected: no days, bad time, unknown zone, impossible date', () => withSchedule(async (f) => {
  const cases = [
    { ...DAILY, weekdays: [] }, { ...DAILY, weekdays: [0] }, { ...DAILY, weekdays: [2, 2] },
    { ...DAILY, time: '24:00' }, { ...DAILY, time: '8:30' }, { ...DAILY, timezone: 'Mars/Olympus' },
    { ...DAILY, startDate: '2026-02-30' }, { ...DAILY, everyWeeks: 5 }, { ...DAILY, durationMin: 10 },
  ];
  const statuses = [];
  for (const rule of cases) statuses.push((await f.put(f.a, rule)).status);
  return (statuses.every((s) => s === 400) && f.rows('session_schedules').length === 0) || statuses.join(',');
}));

await check('sessions keep their wall-clock time across a daylight-saving change', () => {
  const rule = sched.parseRule({ ...DAILY, weekdays: [2] }).rule;
  // 2026-10-25 is the European switch back to winter time.
  const [summer, winter] = sched.upcomingSessions(rule, Date.parse('2026-10-19T00:00:00Z'), 2);
  return (summer.date === '2026-10-20' && new Date(summer.startsAt).toISOString() === '2026-10-20T18:30:00.000Z'
    && winter.date === '2026-10-27' && new Date(winter.startsAt).toISOString() === '2026-10-27T19:30:00.000Z')
    || JSON.stringify([summer, winter]);
});

await check('every-other-week rules keep their phase from the start date', () => {
  const rule = sched.parseRule({ ...DAILY, weekdays: [2], everyWeeks: 2, startDate: '2026-10-01' }).rule;
  const dates = sched.upcomingSessions(rule, Date.parse('2026-10-19T00:00:00Z'), 3).map((s) => s.date);
  return dates.join() === '2026-10-27,2026-11-10,2026-11-24' || dates.join();
});

await check('attendance is opt-out: everyone is coming until they say otherwise', () => withSchedule(async (f) => {
  await f.put(f.a, DAILY);
  const body = await f.get(f.b);
  const states = body.sessions.flatMap((s) => Object.values(s.attendance).map((a) => a.state));
  return (body.sessions.length === sched.SESSION_COUNT && states.length === 3 * sched.SESSION_COUNT
    && states.every((s) => s === 'in') && f.rows('session_rsvps').length === 0) || JSON.stringify(body).slice(0, 300);
}));

await check("any member can mark another member out, and set_by records who did", () => withSchedule(async (f) => {
  await f.put(f.a, DAILY);
  const date = f.sessions()[1].date;
  const r = await f.post(f.b, { action: 'rsvp', date, steamId: 'seed:5201:zed', answer: 'out' });
  const body = await f.get(f.a);
  const cell = body.sessions.find((s) => s.date === date).attendance['seed:5201:zed'];
  return (r.status === 200 && cell.state === 'out' && cell.setBy === SCH_B) || JSON.stringify({ status: r.status, cell });
}));

await check('answering for somebody outside the group is refused and writes nothing', () => withSchedule(async (f) => {
  await f.put(f.a, DAILY);
  const date = f.sessions()[1].date;
  const r = await f.post(f.a, { action: 'rsvp', date, steamId: SCH_C, answer: 'out' });
  const a = await f.post(f.a, { action: 'away', steamId: SCH_C, from: date, to: date });
  const leaked = sqlite.prepare('SELECT COUNT(*) AS n FROM session_rsvps WHERE steam_id=?').get(SCH_C).n
    + sqlite.prepare('SELECT COUNT(*) AS n FROM member_away WHERE steam_id=?').get(SCH_C).n;
  return (r.status === 400 && a.status === 400 && leaked === 0) || `${r.status} ${a.status} rows ${leaked}`;
}));

await check('answers are only accepted for real, unfinished sessions', () => withSchedule(async (f) => {
  const none = await f.post(f.a, { action: 'rsvp', date: f.sessions()[1].date, answer: 'out' });
  await f.put(f.a, { ...DAILY, weekdays: [2] });
  const tuesday = sched.upcomingSessions(sched.parseRule({ ...DAILY, weekdays: [2] }).rule, Date.now(), 1)[0].date;
  const wednesday = sched.addDays(tuesday, 1);
  const wrongDay = await f.post(f.a, { action: 'rsvp', date: wednesday, answer: 'out' });
  const past = await f.post(f.a, { action: 'rsvp', date: sched.addDays(tuesday, -7), answer: 'out' });
  const bad = await f.post(f.a, { action: 'rsvp', date: tuesday, answer: 'yes' });
  return (none.status === 409 && wrongDay.status === 400 && past.status === 400 && bad.status === 400
    && f.rows('session_rsvps').length === 0) || [none.status, wrongDay.status, past.status, bad.status].join(',');
}));

await check('"coming" clears an answer instead of storing one, unless it overrides an away range', () => withSchedule(async (f) => {
  await f.put(f.a, DAILY);
  const [, one, two] = f.sessions();
  await f.post(f.a, { action: 'rsvp', date: one.date, answer: 'maybe' });
  await f.post(f.a, { action: 'rsvp', date: one.date, answer: 'in' });
  const cleared = f.rows('session_rsvps').length;
  await f.post(f.a, { action: 'away', from: one.date, to: two.date });
  await f.post(f.a, { action: 'rsvp', date: two.date, answer: 'in' });
  const body = await f.get(f.a);
  const at = (date) => body.sessions.find((s) => s.date === date).attendance[SCH_A];
  return (cleared === 0 && at(one.date).state === 'out' && at(one.date).source === 'away'
    && at(two.date).state === 'in' && at(two.date).source === 'answer')
    || JSON.stringify({ cleared, one: at(one.date), two: at(two.date) });
}));

await check('a new away range supersedes an earlier "coming after all" inside it', () => withSchedule(async (f) => {
  await f.put(f.a, DAILY);
  const [, one] = f.sessions();
  await f.post(f.a, { action: 'away', from: one.date, to: one.date });
  await f.post(f.a, { action: 'rsvp', date: one.date, answer: 'in' });
  const overridden = f.rows('session_rsvps').length;
  await f.post(f.a, { action: 'away', from: one.date, to: sched.addDays(one.date, 3) });
  const body = await f.get(f.a);
  const cell = body.sessions.find((s) => s.date === one.date).attendance[SCH_A];
  return (overridden === 1 && f.rows('session_rsvps').length === 0 && cell.state === 'out')
    || JSON.stringify({ overridden, cell });
}));

await check('away ranges are validated and bounded per person', () => withSchedule(async (f) => {
  const today = sched.localDate('UTC', Date.now());
  const statuses = [
    (await f.post(f.a, { action: 'away', from: '2026-13-01', to: '2026-13-02' })).status,
    (await f.post(f.a, { action: 'away', from: sched.addDays(today, 5), to: sched.addDays(today, 4) })).status,
    (await f.post(f.a, { action: 'away', from: sched.addDays(today, -9), to: sched.addDays(today, -3) })).status,
    (await f.post(f.a, { action: 'away', from: today, to: sched.addDays(today, 400) })).status,
  ];
  for (let i = 0; i < sched.AWAY_LIMIT; i++) {
    await f.post(f.a, { action: 'away', from: sched.addDays(today, i), to: sched.addDays(today, i) });
  }
  const over = await f.post(f.a, { action: 'away', from: today, to: today });
  return (statuses.every((s) => s === 400) && over.status === 409 && f.rows('member_away').length === sched.AWAY_LIMIT)
    || JSON.stringify({ statuses, over: over.status, rows: f.rows('member_away').length });
}));

await check("another group's away range cannot be removed by guessing its id", () => withSchedule(async (f) => {
  await f.put(f.a, DAILY);
  const date = f.sessions()[1].date;
  const added = await (await f.post(f.a, { action: 'away', from: date, to: date })).json();
  const foreign = await f.post(f.other, { action: 'unaway', id: added.id });
  const kept = f.rows('member_away').length;
  const own = await f.post(f.b, { action: 'unaway', id: added.id });
  return (foreign.status === 404 && kept === 1 && own.status === 200 && f.rows('member_away').length === 0)
    || JSON.stringify({ id: added.id, foreign: foreign.status, kept, own: own.status });
}));

await check("one group's schedule never reaches another group's GET", () => withSchedule(async (f) => {
  await f.put(f.a, DAILY);
  const date = f.sessions()[1].date;
  await f.post(f.a, { action: 'rsvp', date, steamId: SCH_B, answer: 'out' });
  await f.post(f.a, { action: 'away', from: date, to: date });
  const other = await f.get(f.other);
  return (other.schedule === null && other.sessions.length === 0 && other.away.length === 0) || JSON.stringify(other);
}));

await check('personal workspaces have no schedule and refuse every write', () => withSchedule(async (f) => {
  const body = await f.get(f.solo);
  const put = await f.put(f.solo, DAILY);
  const post = await f.post(f.solo, { action: 'away', from: '2026-12-01', to: '2026-12-02' });
  const del = await scheduleRoute.onRequestDelete({ env, data: f.solo });
  const rows = sqlite.prepare('SELECT COUNT(*) AS n FROM session_schedules WHERE group_id=5203').get().n;
  return (body.enabled === false && put.status === 409 && post.status === 409 && del.status === 409 && rows === 0)
    || JSON.stringify({ body, put: put.status, post: post.status, del: del.status, rows });
}));

await check('removing the rule keeps answers, which return with the same days', () => withSchedule(async (f) => {
  await f.put(f.a, DAILY);
  const date = f.sessions()[1].date;
  await f.post(f.b, { action: 'rsvp', date, answer: 'out' });
  await scheduleRoute.onRequestDelete({ env, data: f.a });
  const gone = await f.get(f.a);
  await f.put(f.a, DAILY);
  const back = await f.get(f.a);
  return (gone.schedule === null && back.sessions.find((s) => s.date === date)?.attendance[SCH_B].state === 'out')
    || JSON.stringify({ gone: gone.schedule, back: back.sessions[1] });
}));

await check('answers far in the past are pruned on the next write', () => withSchedule(async (f) => {
  await f.put(f.a, DAILY);
  sqlite.prepare("INSERT INTO session_rsvps (group_id,steam_id,session_date,answer) VALUES (5201,?,'2020-01-07','out')").run(SCH_B);
  sqlite.prepare("INSERT INTO member_away (group_id,steam_id,from_date,to_date) VALUES (5201,?,'2020-01-01','2020-01-09')").run(SCH_B);
  await f.post(f.a, { action: 'rsvp', date: f.sessions()[1].date, answer: 'out' });
  const rsvps = f.rows('session_rsvps').map((r) => r.session_date);
  return (rsvps.length === 1 && !rsvps.includes('2020-01-07') && f.rows('member_away').length === 0)
    || JSON.stringify({ rsvps, away: f.rows('member_away') });
}));

await check('claiming a placeholder carries over answers given on its behalf', () => withSchedule(async (f) => {
  await f.put(f.a, DAILY);
  const [, one, two] = f.sessions();
  await f.post(f.a, { action: 'rsvp', date: one.date, steamId: 'seed:5201:zed', answer: 'out' });
  await f.post(f.a, { action: 'rsvp', date: two.date, steamId: 'seed:5201:zed', answer: 'maybe' });
  await f.post(f.a, { action: 'away', steamId: 'seed:5201:zed', from: sched.addDays(two.date, 1), to: sched.addDays(two.date, 2) });
  sqlite.prepare("INSERT INTO memberships (group_id,steam_id,short_name) VALUES (5201,?,'Carol')").run(SCH_C);
  // The real account already answered for `two`; that answer must win.
  sqlite.prepare("INSERT INTO session_rsvps (group_id,steam_id,session_date,answer) VALUES (5201,?,?,'out')").run(SCH_C, two.date);
  const claimed = await claimSeedIdentity(DB, 5201, SCH_C, 'seed:5201:zed');
  const rsvps = sqlite.prepare('SELECT session_date,answer FROM session_rsvps WHERE group_id=5201 AND steam_id=? ORDER BY session_date').all(SCH_C);
  const away = sqlite.prepare('SELECT COUNT(*) AS n FROM member_away WHERE group_id=5201 AND steam_id=?').get(SCH_C).n;
  const orphans = sqlite.prepare("SELECT COUNT(*) AS n FROM session_rsvps WHERE steam_id='seed:5201:zed'").get().n;
  return (claimed === 'Zed' && JSON.stringify(rsvps) === JSON.stringify([
    { session_date: one.date, answer: 'out' }, { session_date: two.date, answer: 'out' },
  ]) && away === 1 && orphans === 0) || JSON.stringify({ claimed, rsvps, away, orphans });
}));

await check('leaving a group removes only that member’s answers and away ranges', () => withSchedule(async (f) => {
  await f.put(f.a, DAILY);
  const date = f.sessions()[1].date;
  await f.post(f.a, { action: 'rsvp', date, answer: 'out' });
  await f.post(f.b, { action: 'rsvp', date, answer: 'maybe' });
  await f.post(f.b, { action: 'away', from: date, to: date });
  sqlite.prepare('DELETE FROM memberships WHERE group_id=5201 AND steam_id=?').run(SCH_B);
  const left = f.rows('session_rsvps').map((r) => r.steam_id);
  return (left.join() === SCH_A && f.rows('member_away').length === 0) || JSON.stringify(left);
}));

await check('schedule migration is additive and idempotent', () => withSchedule(async (f) => {
  await f.put(f.a, DAILY);
  await f.post(f.a, { action: 'rsvp', date: f.sessions()[1].date, answer: 'out' });
  const snapshot = () => JSON.stringify([f.rows('session_schedules'), f.rows('session_rsvps'), f.rows('member_away')]);
  const before = snapshot();
  const migration = fs.readFileSync(path.join(SITE, 'migrations/038-session-schedule.sql'), 'utf8');
  sqlite.exec(migration);
  sqlite.exec(migration);
  return snapshot() === before || 'replay changed schedule data';
}));

await check('deleting a group takes its schedule, answers, away ranges and overrides with it', async () => {
  await withSchedule(async (f) => {
    await f.put(f.a, DAILY);
    const date = f.sessions()[1].date;
    await f.post(f.a, { action: 'rsvp', date, answer: 'out' });
    await f.post(f.b, { action: 'away', from: date, to: date });
    await f.post(f.a, { action: 'cancel', key: f.sessions()[2].key });
  });
  const left = ['session_schedules', 'session_rsvps', 'member_away', 'session_overrides']
    .map((t) => sqlite.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE group_id=5201`).get().n);
  return left.every((n) => n === 0) || left.join(',');
});

console.log('\nOne-off session changes');

const TUESDAYS = { ...DAILY, weekdays: [2] };
const tuesdays = () => sched.upcomingSessions(sched.parseRule(TUESDAYS).rule, Date.now(), 4);

await check('only the owner can move, cancel or restore one session', () => withSchedule(async (f) => {
  await f.put(f.a, TUESDAYS);
  const [, one] = tuesdays();
  const move = await f.post(f.b, { action: 'move', key: one.key, date: sched.addDays(one.key, -1), time: '20:30' });
  const cancel = await f.post(f.b, { action: 'cancel', key: one.key });
  await f.post(f.a, { action: 'cancel', key: one.key });
  const restore = await f.post(f.b, { action: 'restore', key: one.key });
  const rows = f.rows('session_overrides');
  return (move.status === 403 && cancel.status === 403 && restore.status === 403
    && rows.length === 1 && rows[0].cancelled === 1) || JSON.stringify({ move: move.status, cancel: cancel.status, restore: restore.status, rows });
}));

await check('a moved session keeps its key, clears only its own answers, and the rule carries on', () => withSchedule(async (f) => {
  await f.put(f.a, TUESDAYS);
  const [, one, two] = tuesdays();
  await f.post(f.b, { action: 'rsvp', date: one.key, answer: 'out' });
  await f.post(f.b, { action: 'rsvp', date: two.key, answer: 'maybe' });
  const monday = sched.addDays(one.key, -1);
  const r = await f.post(f.a, { action: 'move', key: one.key, date: monday, time: '19:00' });
  const body = await f.get(f.b);
  const moved = body.sessions.find((s) => s.key === one.key);
  const next = body.sessions.find((s) => s.key === two.key);
  return (r.status === 200 && moved.date === monday && moved.moved && moved.time === '19:00'
    && moved.regularStartsAt === one.startsAt && moved.changedBy === SCH_A
    && moved.attendance[SCH_B].state === 'in' && !next.moved && next.attendance[SCH_B].state === 'maybe'
    && body.sessions.filter((s) => !s.cancelled).length === sched.SESSION_COUNT)
    || JSON.stringify({ status: r.status, moved, next });
}));

await check('answers to a moved session use its key; away ranges use the day it is played', () => withSchedule(async (f) => {
  await f.put(f.a, TUESDAYS);
  const [, one] = tuesdays();
  const monday = sched.addDays(one.key, -1);
  await f.post(f.a, { action: 'move', key: one.key, date: monday, time: '20:30' });
  const byNewDate = await f.post(f.b, { action: 'rsvp', date: monday, answer: 'out' });
  await f.post(f.b, { action: 'rsvp', date: one.key, answer: 'maybe' });
  // Away on the original Tuesday only: no longer the day this session is played.
  await f.post(f.a, { action: 'away', from: one.key, to: one.key });
  const body = await f.get(f.a);
  const s = body.sessions.find((x) => x.key === one.key);
  await f.post(f.a, { action: 'away', from: monday, to: monday });
  const after = (await f.get(f.a)).sessions.find((x) => x.key === one.key);
  return (byNewDate.status === 400 && s.attendance[SCH_B].state === 'maybe' && s.attendance[SCH_A].state === 'in'
    && after.attendance[SCH_A].state === 'out' && after.attendance[SCH_A].source === 'away')
    || JSON.stringify({ byNewDate: byNewDate.status, s: s.attendance, after: after.attendance });
}));

await check('cancelling keeps answers, refuses new ones, and restoring brings them back', () => withSchedule(async (f) => {
  await f.put(f.a, TUESDAYS);
  const [, one] = tuesdays();
  await f.post(f.b, { action: 'rsvp', date: one.key, answer: 'out' });
  await f.post(f.a, { action: 'cancel', key: one.key });
  const off = (await f.get(f.a)).sessions.find((s) => s.key === one.key);
  const rsvp = await f.post(f.b, { action: 'rsvp', date: one.key, answer: 'maybe' });
  const twice = await f.post(f.a, { action: 'cancel', key: one.key });
  await f.post(f.a, { action: 'restore', key: one.key });
  const back = (await f.get(f.a)).sessions.find((s) => s.key === one.key);
  return (off.cancelled && Object.keys(off.attendance).length === 0 && rsvp.status === 409 && twice.status === 409
    && !back.cancelled && back.attendance[SCH_B].state === 'out' && f.rows('session_overrides').length === 0)
    || JSON.stringify({ off, rsvp: rsvp.status, twice: twice.status, back });
}));

await check('a cancelled session is listed but does not count towards the upcoming eight', () => withSchedule(async (f) => {
  await f.put(f.a, TUESDAYS);
  const [, one] = tuesdays();
  await f.post(f.a, { action: 'cancel', key: one.key });
  const body = await f.get(f.a);
  return (body.sessions.length === sched.SESSION_COUNT + 1
    && body.sessions.filter((s) => s.cancelled).map((s) => s.key).join() === one.key)
    || body.sessions.map((s) => `${s.key}${s.cancelled ? 'x' : ''}`).join(' ');
}));

await check('restoring a move clears answers given for the moved time', () => withSchedule(async (f) => {
  await f.put(f.a, TUESDAYS);
  const [, one] = tuesdays();
  await f.post(f.a, { action: 'move', key: one.key, date: sched.addDays(one.key, -1), time: '20:30' });
  await f.post(f.b, { action: 'rsvp', date: one.key, answer: 'out' });
  await f.post(f.a, { action: 'restore', key: one.key });
  const s = (await f.get(f.a)).sessions.find((x) => x.key === one.key);
  return (!s.moved && s.date === one.key && s.attendance[SCH_B].state === 'in' && f.rows('session_rsvps').length === 0)
    || JSON.stringify(s);
}));

await check('moves are refused onto another session, into the past, or to where it already is', () => withSchedule(async (f) => {
  await f.put(f.a, TUESDAYS);
  const [, one, two] = tuesdays();
  const statuses = [
    (await f.post(f.a, { action: 'move', key: one.key, date: two.key, time: '18:00' })).status,
    (await f.post(f.a, { action: 'move', key: one.key, date: sched.addDays(one.key, -30), time: '20:30' })).status,
    (await f.post(f.a, { action: 'move', key: one.key, date: one.key, time: '20:30' })).status,
    (await f.post(f.a, { action: 'move', key: one.key, date: 'tomorrow', time: '20:30' })).status,
    (await f.post(f.a, { action: 'move', key: one.key, date: sched.addDays(one.key, 1), time: '25:00' })).status,
    (await f.post(f.a, { action: 'move', key: sched.addDays(one.key, 1), date: sched.addDays(one.key, 2), time: '20:30' })).status,
    (await f.post(f.a, { action: 'restore', key: one.key })).status,
  ];
  // A second session moved onto a day another session was already moved to.
  await f.post(f.a, { action: 'move', key: one.key, date: sched.addDays(one.key, 1), time: '20:30' });
  statuses.push((await f.post(f.a, { action: 'move', key: two.key, date: sched.addDays(one.key, 1), time: '21:00' })).status);
  return statuses.join() === '409,400,409,400,400,400,409,409' || statuses.join();
}));

await check('moving a session back onto its own slot removes the override', () => withSchedule(async (f) => {
  await f.put(f.a, TUESDAYS);
  const [, one] = tuesdays();
  await f.post(f.a, { action: 'move', key: one.key, date: one.key, time: '18:00' });
  const moved = f.rows('session_overrides').length;
  await f.post(f.a, { action: 'move', key: one.key, date: one.key, time: '20:30' });
  return (moved === 1 && f.rows('session_overrides').length === 0) || `${moved} → ${f.rows('session_overrides').length}`;
}));

await check("another group's owner cannot change this group's sessions", () => withSchedule(async (f) => {
  await f.put(f.a, TUESDAYS);
  await f.put(f.other, TUESDAYS);
  const [, one] = tuesdays();
  await f.post(f.other, { action: 'cancel', key: one.key });
  const mine = (await f.get(f.a)).sessions.find((s) => s.key === one.key);
  const before = f.rows('session_overrides').length;
  // Same key in both groups: restoring here must leave the other group's row alone.
  await f.post(f.a, { action: 'cancel', key: one.key });
  await f.post(f.a, { action: 'restore', key: one.key });
  const theirs = sqlite.prepare('SELECT COUNT(*) AS n FROM session_overrides WHERE group_id=5202').get().n;
  return (!mine.cancelled && before === 0 && f.rows('session_overrides').length === 0 && theirs === 1)
    || JSON.stringify({ mine, before, theirs });
}));

await check('session override migration is additive and idempotent', () => withSchedule(async (f) => {
  await f.put(f.a, TUESDAYS);
  const [, one, two] = tuesdays();
  await f.post(f.a, { action: 'cancel', key: one.key });
  await f.post(f.a, { action: 'move', key: two.key, date: sched.addDays(two.key, 1), time: '20:30' });
  const before = JSON.stringify(f.rows('session_overrides'));
  const migration = fs.readFileSync(path.join(SITE, 'migrations/039-session-overrides.sql'), 'utf8');
  sqlite.exec(migration);
  sqlite.exec(migration);
  return JSON.stringify(f.rows('session_overrides')) === before || 'replay changed overrides';
}));

console.log('\nReschedule polls');

const pollsRoute = await import(path.join(SITE, 'functions/api/g/[slug]/polls.js'));
const { carriedParams } = await import(path.join(SITE, 'lib/auth.js'));
const { bestOption } = await import(path.join(SITE, 'lib/polls.js'));
const poll = (data, input) => pollsRoute.onRequestPost({ env, data, request: req(input) });
/** A Tuesday rule, the second upcoming session, and a poll Bob starts for it. */
async function withPoll(f, slots) {
  await f.put(f.a, TUESDAYS);
  const [, one, two] = tuesdays();
  const options = slots || [
    { date: sched.addDays(one.key, -1), time: '20:30' },
    { date: sched.addDays(one.key, 2), time: '19:00' },
  ];
  const created = await (await poll(f.b, { action: 'create', key: one.key, slots: options })).json();
  const read = async (data = f.a) => (await f.get(data)).polls.find((p) => p.id === created.pollId);
  return { one, two, pollId: created.pollId, read };
}
const optionOf = (p, kind, n = 0) => p.options.filter((o) => o.kind === kind)[n];

await check('any member can start a poll; it lists their times plus "as planned" and "skip"', () => withSchedule(async (f) => {
  const { one, pollId, read } = await withPoll(f);
  const p = await read();
  const slots = p.options.filter((o) => o.kind === 'slot');
  const attendance = (await f.get(f.a)).sessions.find((s) => s.key === one.key).attendance[SCH_B];
  return (pollId > 0 && p.status === 'open' && p.createdBy === SCH_B && slots.length === 2
    && p.options.map((o) => o.kind).join() === 'slot,slot,asplanned,skip'
    && slots.every((o) => o.votes[SCH_B]?.answer === 'yes') && p.best === null
    && p.replacesStartsAt === one.startsAt && attendance.state === 'out')
    || JSON.stringify({ pollId, p, attendance });
}));

await check('one open poll per session; a second start returns the existing one', () => withSchedule(async (f) => {
  const { one, pollId } = await withPoll(f);
  const again = await poll(f.a, { action: 'create', key: one.key, slots: [{ date: sched.addDays(one.key, 3), time: '20:00' }] });
  const body = await again.json();
  const count = sqlite.prepare('SELECT COUNT(*) AS n FROM session_polls WHERE group_id=5201').get().n;
  return (again.status === 409 && body.pollId === pollId && count === 1) || JSON.stringify({ status: again.status, body, count });
}));

await check('poll times are validated and a refused poll writes nothing', () => withSchedule(async (f) => {
  await f.put(f.a, TUESDAYS);
  const [, one, two] = tuesdays();
  const slot = (date, time = '20:30') => ({ date, time });
  const cases = [
    [], [1, 2, 3, 4, 5, 6].map((n) => slot(sched.addDays(one.key, n))),
    [slot(sched.addDays(one.key, -30))], [slot(two.key)], [slot(one.key)],
    [slot(sched.addDays(one.key, 1)), slot(sched.addDays(one.key, 1))], [slot('soon')], [slot(sched.addDays(one.key, 1), '7pm')],
  ];
  const statuses = [];
  for (const slots of cases) statuses.push((await poll(f.b, { action: 'create', key: one.key, slots })).status);
  await f.post(f.a, { action: 'cancel', key: two.key });
  statuses.push((await poll(f.b, { action: 'create', key: two.key, slots: [slot(sched.addDays(two.key, 1))] })).status);
  const rows = ['session_polls', 'session_rsvps'].map((t) => sqlite.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE group_id=5201`).get().n);
  return (statuses.join() === '400,400,400,409,409,400,400,400,409' && rows.join() === '0,0') || `${statuses.join()} rows ${rows.join()}`;
}));

await check('votes can be given for any member, are attributed, and can be cleared', () => withSchedule(async (f) => {
  const { pollId, read } = await withPoll(f);
  const first = optionOf(await read(), 'slot');
  await poll(f.a, { action: 'vote', optionId: first.id, answer: 'yes' });
  await poll(f.a, { action: 'vote', optionId: first.id, steamId: 'seed:5201:zed', answer: 'maybe' });
  const p = await read();
  const v = optionOf(p, 'slot').votes;
  await poll(f.a, { action: 'vote', optionId: first.id, answer: null });
  const cleared = optionOf(await read(), 'slot').votes[SCH_A];
  const outsider = await poll(f.a, { action: 'vote', optionId: first.id, steamId: SCH_C, answer: 'yes' });
  const bad = await poll(f.a, { action: 'vote', optionId: first.id, answer: 'definitely' });
  return (v[SCH_A].answer === 'yes' && v['seed:5201:zed'].answer === 'maybe' && v['seed:5201:zed'].setBy === SCH_A
    && p.best === first.id && cleared === undefined && outsider.status === 400 && bad.status === 400 && pollId > 0)
    || JSON.stringify({ v, best: p.best, cleared, outsider: outsider.status, bad: bad.status });
}));

await check("another group's poll options, polls and links are 404 and stay untouched", () => withSchedule(async (f) => {
  const { pollId, read } = await withPoll(f);
  const first = optionOf(await read(), 'slot');
  await f.put(f.other, TUESDAYS);
  const statuses = [
    (await poll(f.other, { action: 'vote', optionId: first.id, answer: 'no' })).status,
    (await poll(f.other, { action: 'add', pollId, date: sched.addDays(first.date, 3), time: '20:00' })).status,
    (await poll(f.other, { action: 'decide', pollId, optionId: first.id })).status,
    (await poll(f.other, { action: 'withdraw', pollId })).status,
  ];
  const otherView = (await f.get(f.other)).polls;
  const p = await read();
  return (statuses.every((s) => s === 404) && otherView.length === 0 && p.status === 'open'
    && p.options.length === 4 && Object.keys(optionOf(p, 'slot').votes).join() === SCH_B)
    || JSON.stringify({ statuses, otherView, p });
}));

await check('any member can add a time, bounded and de-duplicated', () => withSchedule(async (f) => {
  const { one, pollId, read } = await withPoll(f);
  const add = (n, data = f.a) => poll(data, { action: 'add', pollId, date: sched.addDays(one.key, n), time: '21:00' });
  const r = await add(3);
  const dup = await add(3);
  for (const n of [4, 5, 6]) await add(n);
  const over = await add(9);
  const p = await read();
  const added = p.options.find((o) => o.date === sched.addDays(one.key, 3));
  return (r.status === 200 && dup.status === 409 && over.status === 409
    && p.options.filter((o) => o.kind === 'slot').length === 6 && added.addedBy === SCH_A
    && added.votes[SCH_A].answer === 'yes') || JSON.stringify({ r: r.status, dup: dup.status, over: over.status });
}));

await check('only the starter or the owner can settle or withdraw a poll', () => withSchedule(async (f) => {
  sqlite.prepare("INSERT INTO users (steam_id,display_name) VALUES ('76561198000520009','Dee')").run();
  sqlite.prepare("INSERT INTO memberships (group_id,steam_id,short_name) VALUES (5201,'76561198000520009','Dee')").run();
  const d = (await ctxFor('76561198000520009', 'schedule-team')).data;
  const { pollId, read } = await withPoll(f);
  const first = optionOf(await read(), 'slot');
  const decide = await poll(d, { action: 'decide', pollId, optionId: first.id });
  const withdraw = await poll(d, { action: 'withdraw', pollId });
  const still = (await read()).status;
  const starter = await poll(f.b, { action: 'withdraw', pollId });
  sqlite.prepare("DELETE FROM users WHERE steam_id='76561198000520009'").run();
  return (decide.status === 403 && withdraw.status === 403 && still === 'open' && starter.status === 200)
    || JSON.stringify({ decide: decide.status, withdraw: withdraw.status, still, starter: starter.status });
}));

await check('choosing a time moves the session and carries the votes into attendance', () => withSchedule(async (f) => {
  const { one, two, pollId, read } = await withPoll(f);
  const first = optionOf(await read(), 'slot');
  await poll(f.a, { action: 'vote', optionId: first.id, answer: 'no' });
  await poll(f.a, { action: 'vote', optionId: first.id, steamId: 'seed:5201:zed', answer: 'maybe' });
  await f.post(f.a, { action: 'rsvp', date: two.key, answer: 'out' });
  const r = await poll(f.a, { action: 'decide', pollId, optionId: first.id });
  const body = await f.get(f.a);
  const s = body.sessions.find((x) => x.key === one.key);
  const p = body.polls.find((x) => x.id === pollId);
  const next = body.sessions.find((x) => x.key === two.key);
  const vote = await poll(f.b, { action: 'vote', optionId: first.id, answer: 'no' });
  return (r.status === 200 && s.moved && s.date === first.date && s.time === first.time
    && s.attendance[SCH_A].state === 'out' && s.attendance['seed:5201:zed'].state === 'maybe'
    && s.attendance[SCH_B].state === 'in' && p.status === 'decided' && p.decidedOption === first.id
    && p.decidedBy === SCH_A && next.attendance[SCH_A].state === 'out' && vote.status === 409)
    || JSON.stringify({ r: r.status, s, p, next: next.attendance, vote: vote.status });
}));

await check('"as planned" keeps the session and the starter out; "skip" cancels it', () => withSchedule(async (f) => {
  const { one, two, pollId, read } = await withPoll(f);
  await poll(f.b, { action: 'decide', pollId, optionId: optionOf(await read(), 'asplanned').id });
  const kept = (await f.get(f.a)).sessions.find((s) => s.key === one.key);
  const second = await (await poll(f.a, { action: 'create', key: two.key, slots: [{ date: sched.addDays(two.key, 1), time: '20:30' }] })).json();
  const p2 = (await f.get(f.a)).polls.find((p) => p.id === second.pollId);
  await poll(f.a, { action: 'decide', pollId: second.pollId, optionId: optionOf(p2, 'skip').id });
  const skipped = (await f.get(f.a)).sessions.find((s) => s.key === two.key);
  return (!kept.moved && !kept.cancelled && kept.attendance[SCH_B].state === 'out'
    && skipped.cancelled && f.rows('session_rsvps').some((r) => r.session_date === two.key && r.answer === 'out'))
    || JSON.stringify({ kept, skipped });
}));

await check('settling a time the owner already moved the session to just closes the poll', () => withSchedule(async (f) => {
  const { one, pollId, read } = await withPoll(f);
  const first = optionOf(await read(), 'slot');
  await f.post(f.a, { action: 'move', key: one.key, date: first.date, time: first.time });
  await f.post(f.b, { action: 'rsvp', date: one.key, answer: 'maybe' });
  const r = await poll(f.a, { action: 'decide', pollId, optionId: first.id });
  const s = (await f.get(f.a)).sessions.find((x) => x.key === one.key);
  return (r.status === 200 && s.date === first.date && s.attendance[SCH_B].state === 'maybe')
    || JSON.stringify({ status: r.status, s });
}));

await check('a poll is read-only once its session is over', () => withSchedule(async (f) => {
  const { pollId, read } = await withPoll(f);
  const first = optionOf(await read(), 'slot');
  // Its session was yesterday, as far as the rule is concerned.
  const yesterday = sched.addDays(sched.localDate('Europe/Berlin', Date.now()), -1);
  sqlite.prepare('UPDATE session_polls SET session_key=? WHERE id=?').run(yesterday, pollId);
  await f.put(f.a, DAILY);
  const p = await read();
  const vote = await poll(f.a, { action: 'vote', optionId: first.id, answer: 'yes' });
  const decide = await poll(f.b, { action: 'decide', pollId, optionId: first.id });
  return (p.status === 'expired' && p.best === null && vote.status === 409 && decide.status === 409)
    || JSON.stringify({ status: p.status, vote: vote.status, decide: decide.status });
}));

await check('the suggestion ignores the starter\'s own votes and prefers more yes, fewer no', () => {
  const o = (id, votes, startsAt = id) => ({ id, kind: 'slot', startsAt, votes,
    yes: Object.values(votes).filter((v) => v.answer === 'yes').length,
    no: Object.values(votes).filter((v) => v.answer === 'no').length,
    maybe: Object.values(votes).filter((v) => v.answer === 'maybe').length });
  const y = { answer: 'yes' }, n = { answer: 'no' };
  const onlyStarter = bestOption([o(1, { s: y })], 0, 's');
  const tie = bestOption([o(1, { s: y, a: y, b: n }, 10), o(2, { s: y, a: y }, 20)], 0, 's');
  const started = bestOption([o(1, { a: y, b: y }, -5), o(2, { a: y }, 20)], 0, 's');
  return (onlyStarter === null && tie === 2 && started === 2) || JSON.stringify({ onlyStarter, tie, started });
});

await check('claiming a placeholder carries its poll votes; leaving drops a member\'s votes', () => withSchedule(async (f) => {
  const { pollId, read } = await withPoll(f);
  const first = optionOf(await read(), 'slot');
  await poll(f.a, { action: 'vote', optionId: first.id, steamId: 'seed:5201:zed', answer: 'no' });
  sqlite.prepare("INSERT INTO memberships (group_id,steam_id,short_name) VALUES (5201,?,'Carol')").run(SCH_C);
  await claimSeedIdentity(DB, 5201, SCH_C, 'seed:5201:zed');
  const claimed = optionOf(await read(), 'slot').votes[SCH_C]?.answer;
  sqlite.prepare('DELETE FROM memberships WHERE group_id=5201 AND steam_id=?').run(SCH_B);
  const p = await read();
  return (claimed === 'no' && !optionOf(p, 'slot').votes[SCH_B] && p.createdBy === SCH_B && pollId > 0)
    || JSON.stringify({ claimed, votes: optionOf(p, 'slot').votes });
}));

await check('personal workspaces refuse polls', () => withSchedule(async (f) => {
  const r = await poll(f.solo, { action: 'create', key: '2026-12-01', slots: [{ date: '2026-12-02', time: '20:00' }] });
  return r.status === 409 || `got ${r.status}`;
}));

await check('poll migration is additive and idempotent; deleting a group removes its polls', async () => {
  let before;
  await withSchedule(async (f) => {
    const { read } = await withPoll(f);
    await poll(f.a, { action: 'vote', optionId: optionOf(await read(), 'slot').id, answer: 'yes' });
    const snap = () => JSON.stringify(['session_polls', 'poll_options', 'poll_votes'].map((t) => sqlite.prepare(`SELECT * FROM ${t}`).all()));
    before = snap();
    const migration = fs.readFileSync(path.join(SITE, 'migrations/040-session-polls.sql'), 'utf8');
    sqlite.exec(migration);
    sqlite.exec(migration);
    if (snap() !== before) before = 'CHANGED';
  });
  const left = ['session_polls', 'poll_options', 'poll_votes'].map((t) => sqlite.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n);
  return (before !== 'CHANGED' && left.every((n) => n === 0)) || `${before === 'CHANGED' ? 'replay changed data; ' : ''}left ${left}`;
});

await check('only well-formed invite codes and poll links survive the login round-trip', () => {
  const t = (q) => carriedParams(new URLSearchParams(q));
  const cases = {
    'join=ABC234&poll=g4m1ng.12': 'join=ABC234&poll=g4m1ng.12',
    'poll=g4m1ng.0': '', 'poll=https://evil.example/x': '', 'poll=g4m1ng.1&next=//evil': 'poll=g4m1ng.1',
    'join=../../x': '', 'poll=G4M1NG.1': '', 'x=1': '',
  };
  const wrong = Object.entries(cases).filter(([q, want]) => t(q) !== want);
  return !wrong.length || JSON.stringify(wrong.map(([q]) => [q, t(q)]));
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
