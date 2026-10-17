#!/usr/bin/env node
/**
 * Fetch Steam user tags for catalogue rows that have none, and emit a migration.
 *
 * The cron crawler already does this, nine games an hour, which is the right pace
 * for keeping a catalogue fresh and the wrong one for filling it. A newly added
 * co-op filter defaults to ON, and untagged rows are deliberately kept visible
 * (hiding them would empty a fresh catalogue) — so until every row is tagged, the
 * filter silently lets PvP games through. This closes that gap in one pass.
 *
 * Tags are read off each game's store page. They appear in no Steam JSON API, and
 * `genres` is too coarse to substitute (235 of 337 rows are "Action"). SteamSpy
 * publishes them as JSON and was tried first, but had tag data for none of the 118
 * newest rows here — see lib/coop.js. The store host throttles at roughly
 * 200 requests / 5 min per IP, hence the default spacing.
 *
 *   node scripts/backfill-tags.mjs --out migrations/015-steam-tags.sql
 *   node scripts/backfill-tags.mjs --limit 20 --dry     # try a few, write nothing
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { storeTagsUrl, STORE_HEADERS, parseStoreTags, classifyCoop } from '../lib/coop.js';

const argv = process.argv.slice(2);
const arg = (k, d = null) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? (argv[i + 1] ?? true) : d;
};
const OUT = arg('out', 'migrations/015-steam-tags.sql');
const LIMIT = Number(arg('limit', 1000));
const DRY = !!arg('dry');
const GAP = Number(arg('gap', 1700));   // store host: ~200 requests / 5 min per IP
/* Re-read rows that already have tags. Needed once, to replace tags that came from
   SteamSpy: it and Steam order the same tags differently, and the classifier's
   window was calibrated on Steam's order, so a table holding both is a table where
   the co-op flag means two different things. */
const ALL = !!arg('all');
/* `--library` reads the OTHER tag home: `steam_apps` rows some group has in its
   library that the co-op catalogue does not list. Those games taught the
   recommender nothing until migration 031 — 45 of group 1's 103 rated games. The
   cron crawler now keeps up with them four an hour, which is the right pace for
   maintenance and the wrong one for filling the gap, exactly as with the
   catalogue itself. */
const LIBRARY = !!arg('library');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sqlStr = (s) => (s == null ? 'NULL' : `'${String(s).replace(/'/g, "''")}'`);

const query = LIBRARY
  ? `SELECT s.appid, s.name FROM steam_apps s
      WHERE ${ALL ? '1=1' : 's.tags IS NULL'}
        AND EXISTS (SELECT 1 FROM games g WHERE g.steam_appid = s.appid)
        AND NOT EXISTS (SELECT 1 FROM coop_apps c WHERE c.appid = s.appid AND c.tags IS NOT NULL)
      ORDER BY s.appid LIMIT ${LIMIT}`
  : `SELECT appid, name, coop_categories FROM coop_apps ${ALL ? '' : 'WHERE tags IS NULL'} `
    + `ORDER BY popularity_rank LIMIT ${LIMIT}`;

const raw = execFileSync('npx', [
  'wrangler', 'd1', 'execute', 'g4m1ng', '--remote', '--yes', '--json', '--command', query,
], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
const todo = JSON.parse(raw.slice(raw.indexOf('[')))[0]?.results ?? [];
console.log(`${todo.length} rows to read (${LIBRARY ? 'library' : 'catalogue'}, ${ALL ? 'all' : 'untagged only'})`);

const rows = [];
let failed = 0;
for (const [i, g] of todo.entries()) {
  process.stderr.write(`  ${i + 1}/${todo.length} ${g.name.slice(0, 40)}\x1b[K\r`);
  try {
    const res = await fetch(storeTagsUrl(g.appid), { headers: STORE_HEADERS, redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const parsed = parseStoreTags(await res.text());
    // A page with no tag block — an age gate, or a delisted app — must stay NULL
    // rather than be recorded as "no tags", or the crawler will never retry it.
    if (parsed) {
      let categories;
      try { categories = JSON.parse(g.coop_categories || '[]'); } catch { categories = []; }
      rows.push({ ...g, ...parsed,
        isCoop: classifyCoop(parsed.tags, Array.isArray(categories) ? categories : []) });
    } else failed++;
  } catch (e) {
    failed++;
    process.stderr.write(`\n  ! ${g.name}: ${e.message}\n`);
  }
  if (i < todo.length - 1) await sleep(GAP);
}
process.stderr.write('\n');

const coop = rows.filter((r) => r.isCoop);
if (LIBRARY) {
  // No co-op verdict is written in this mode, so do not report one. These rows
  // never reach the browsable catalogue; they exist to teach the recommender, and
  // a group's singleplayer and PvP games are part of its taste like anything else.
  console.log(`tagged ${rows.length} library rows; ${failed} had no tags to fetch`);
} else {
  console.log(`tagged ${rows.length}: ${coop.length} co-op, ${rows.length - coop.length} not co-op`
            + `; ${failed} had no tags to fetch`);
  if (rows.length - coop.length) {
    console.log(`excluded: ${rows.filter((r) => !r.isCoop).map((r) => r.name).join(', ')}`);
  }
}
if (DRY || !rows.length) process.exit(0);

writeFileSync(OUT, LIBRARY ? [
  '-- Steam user tags for library games the co-op catalogue does not list.',
  '--',
  '-- Generated by scripts/backfill-tags.mjs --library. Idempotent: every statement',
  '-- is a plain UPDATE keyed on appid.',
  '--',
  '-- No is_coop here, deliberately. That flag decides what the browsable catalogue',
  '-- shows and belongs to coop_apps; these rows only need to remember what the game',
  `-- plays like, so the recommender can learn from it. ${rows.length} rows.`,
  '',
  ...rows.map((r) => `UPDATE steam_apps SET tags = ${sqlStr(JSON.stringify(r.tags))}, `
    + `tags_at = unixepoch() WHERE appid = ${r.appid};`),
  '',
].join('\n') : [
  '-- Steam user tags, and the co-op flag derived from them by classifyCoop.',
  '--',
  '-- Generated by scripts/backfill-tags.mjs. Idempotent: every statement is a plain',
  '-- UPDATE keyed on appid, and re-running it just rewrites the same values.',
  `-- ${rows.length} rows, ${coop.length} co-op, ${rows.length - coop.length} not co-op.`,
  '',
  ...rows.map((r) => `UPDATE coop_apps SET tags = ${sqlStr(JSON.stringify(r.tags))}, `
    + `is_coop = ${r.isCoop ? 1 : 0}, tags_at = unixepoch() WHERE appid = ${r.appid};`),
  '',
].join('\n'));
console.log(`wrote ${OUT}`);
