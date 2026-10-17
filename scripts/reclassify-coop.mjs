#!/usr/bin/env node
/**
 * Recompute `coop_apps.is_coop` from tags already stored, and emit it as a
 * migration.
 *
 * The crawler sets this flag when it fetches a game's tags, so a rule change
 * eventually propagates on its own — but "eventually" is days at one hourly batch
 * of nine games, and until then the browse page filters on the old rule. This
 * reclassifies every already-tagged row in one pass without spending a single
 * Steam or SteamSpy request, because the tags are the input and they are local.
 *
 * Reads through `wrangler d1 execute`, in chunks: a single SELECT of every tag
 * array is large enough that the D1 HTTP API rejects the response.
 *
 *   node scripts/reclassify-coop.mjs --out migrations/016-reclassify.sql
 *   node scripts/reclassify-coop.mjs --local        # against the local D1 copy
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { classifyCoop } from '../lib/coop.js';

const argv = process.argv.slice(2);
const arg = (k, d = null) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? (argv[i + 1] ?? true) : d;
};
const OUT = arg('out', 'migrations/016-reclassify.sql');
const REMOTE = arg('local') ? '--local' : '--remote';
const CHUNKS = Number(arg('chunks', 8));

/** One SELECT, returning parsed rows. `--json` still prints human noise first. */
function query(sql) {
  const raw = execFileSync('npx', [
    'wrangler', 'd1', 'execute', 'g4m1ng', REMOTE, '--yes', '--json', '--command', sql,
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const parsed = JSON.parse(raw.slice(raw.indexOf('[')));
  return parsed[0]?.results ?? [];
}

const rows = [];
for (let c = 0; c < CHUNKS; c++) {
  process.stderr.write(`  chunk ${c + 1}/${CHUNKS}\r`);
  rows.push(...query(
    'SELECT appid, name, tags, coop_categories FROM coop_apps '
    + `WHERE tags IS NOT NULL AND appid % ${CHUNKS} = ${c}`
  ));
}
process.stderr.write('\n');

const flips = [];
for (const r of rows) {
  let tags;
  try { tags = JSON.parse(r.tags); } catch { continue; }
  if (!Array.isArray(tags) || !tags.length) continue;
  // Preserve vote order for the PvP window. Modes only rescue multiplayer
  // evidence lost by the older 12-tag parser; they cannot override that window.
  let categories;
  try { categories = JSON.parse(r.coop_categories || '[]'); } catch { categories = []; }
  flips.push({ appid: r.appid, name: r.name,
    isCoop: classifyCoop(tags, Array.isArray(categories) ? categories : []) });
}

const coop = flips.filter((f) => f.isCoop);
const not = flips.filter((f) => !f.isCoop);

const sql = [
  '-- 015: recompute is_coop under the PvP-exclusion rule.',
  '--',
  '-- The previous rule required a co-op tag in a game\'s top 5, which was validated',
  '-- on four games and wrongly hid 20 of 42 games group 1 actually plays together',
  '-- — Terraria, Stardew Valley, Elden Ring and Baldur\'s Gate 3 among them. See',
  '-- classifyCoop in lib/coop.js for the measurement. Idempotent: it only ever',
  '-- restates a flag derivable from the tags in the same row.',
  '',
  ...(not.length
    ? [`UPDATE coop_apps SET is_coop = 0 WHERE appid IN (${not.map((f) => f.appid).join(',')});`]
    : []),
  '',
  ...(coop.length
    ? [`UPDATE coop_apps SET is_coop = 1 WHERE appid IN (${coop.map((f) => f.appid).join(',')});`]
    : []),
  '',
].join('\n');

writeFileSync(OUT, sql);
console.log(`${flips.length} tagged rows: ${coop.length} co-op, ${not.length} not co-op`);
console.log(`excluded: ${not.slice(0, 12).map((f) => f.name).join(', ')}`);
console.log(`wrote ${OUT}`);
