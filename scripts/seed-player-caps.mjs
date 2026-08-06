#!/usr/bin/env node
/**
 * Emit verified online co-op player caps for the catalogue.
 *
 *   node scripts/seed-player-caps.mjs \
 *     --from migrations/002-coop-seed.sql --out migrations/003-player-caps.sql
 *
 * Why this exists: Steam publishes no reliable machine-readable co-op player
 * count, and its own co-op categories are wrong often enough to be dangerous
 * (invariant 6). `viability()` — the check the whole product turns on — needs a
 * real number, so somebody has to write it down. This file is that somebody.
 *
 * Rules the list below follows:
 *
 *  - The number is max *simultaneous online co-op* players, host included. Not
 *    the store's headline figure, not PvP lobby size, not couch co-op.
 *  - Where a game means two different things by "co-op" — a 4-player party but a
 *    32-slot dedicated server — the smaller, always-true number goes in
 *    max_players and the nuance goes in coop_note. Overstating it makes the
 *    viability check lie in the one direction that costs someone money.
 *  - Anything genuinely ambiguous is LEFT OUT rather than guessed. A NULL cap
 *    renders as "player count unverified" and is honest; a wrong cap is not.
 *
 * Caps are matched by name against the crawl output so the appids come from
 * Steam rather than from memory. Unmatched entries are reported, not silently
 * dropped.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const FROM = arg('from', 'migrations/002-coop-seed.sql');
const OUT = arg('out', 'migrations/003-player-caps.sql');

/** name (lowercased, punctuation-insensitive) -> [cap, note] */
const CAPS = [
  ['stardew valley',                4,  null],
  ['portal 2',                      2,  'Co-op campaign is exactly two players'],
  ['valheim',                       10, null],
  ['baldurs gate 3',                4,  null],
  ['deep rock galactic',            4,  null],
  ['lethal company',                4,  null],
  ['dont starve together',          6,  'Default server cap; a dedicated server can raise it'],
  ['terraria',                      8,  'Typical server default; dedicated servers can go higher'],
  ['left 4 dead 2',                 4,  null],
  ['payday 2',                      4,  null],
  ['payday 3',                      4,  null],
  ['borderlands 2',                 4,  null],
  ['borderlands 3',                 4,  null],
  ['it takes two',                  2,  'Two players only, and the second copy is free'],
  ['a way out',                     2,  'Two players only, and the second copy is free'],
  ['split fiction',                 2,  'Two players only, and the second copy is free'],
  ['helldivers 2',                  4,  null],
  ['grounded',                      4,  null],
  ['grounded 2',                    4,  null],
  ['raft',                          8,  null],
  ['green hell',                    4,  null],
  ['phasmophobia',                  4,  null],
  ['overcooked 2',                  4,  null],
  ['risk of rain 2',                4,  null],
  ['warhammer vermintide 2',        4,  null],
  ['warhammer 40000 darktide',      4,  null],
  ['gtfo',                          4,  null],
  ['sea of thieves',                4,  'A galleon crews four; sloops and brigantines fewer'],
  ['monster hunter world',          4,  null],
  ['monster hunter rise',           4,  null],
  ['monster hunter wilds',          4,  null],
  ['elden ring',                    3,  'Host plus two phantoms'],
  ['dark souls iii',                3,  'Host plus two phantoms'],
  ['remnant ii',                    3,  null],
  ['back 4 blood',                  4,  null],
  ['the ascent',                    4,  null],
  ['trine 4 the nightmare prince',  4,  null],
  ['trine 5 a clockwork conspiracy', 4, null],
  ['enshrouded',                    16, 'Dedicated server default'],
  ['palworld',                      4,  'Four in co-op; up to 32 on a dedicated server'],
  ['v rising',                      4,  'Clan size on a default server'],
  ['satisfactory',                  4,  'Commonly played at four; no hard engine limit'],
  ['no rest for the wicked',        4,  null],
  ['content warning',              4,  null],
  ['repo',                          6,  null],
  ['dying light 2 stay human',      4,  null],
  ['dying light',                   4,  null],
  ['generation zero',               4,  null],
  ['outriders',                     3,  null],
  ['tiny tinas wonderlands',        4,  null],
  ['halo the master chief collection', 4, null],
  ['icarus',                        8,  null],
  ['astroneer',                     4,  null],
  ['pico park 2',                   8,  null],
  ['escape simulator',              4,  null],
  ['keep talking and nobody explodes', 2, 'One copy needed; the other player reads the manual'],
  ['lovers in a dangerous spacetime', 0, 'Couch co-op only — works for 4 via Remote Play Together'],
  ['unravel two',                   0,  'Couch co-op only — works for 2 via Remote Play Together'],
  ['dungeon defenders',             4,  null],
  ['dungeon of the endless',        4,  null],
  ['divinity original sin 2 definitive edition', 2, 'Two players online; four characters in the party'],
  ['wo long fallen dynasty',        3,  null],
  ['nioh 2 the complete edition',   3,  null],
  ['barotrauma',                    16, null],
  ['project zomboid',               4,  'Four is typical; a dedicated server allows more'],
  ['the forest',                    8,  null],
  ['sons of the forest',            8,  null],
  // ── more of what a popularity-ranked crawl actually surfaces ──────────────
  ['counter strike 2',              0,  'Competitive PvP, not co-op'],
  ['warframe',                      4,  null],
  ['the finals',                    0,  'PvP, not co-op'],
  ['marvel rivals',                 0,  'PvP, not co-op'],
  ['apex legends',                  0,  'Battle royale PvP, not co-op'],
  ['bloons td 6',                   4,  null],
  ['vampire survivors',             0,  'Couch co-op only — works via Remote Play Together'],
  ['schedule i',                    4,  null],
  ['borderlands the pre sequel',    4,  null],
  ['borderlands 4',                 4,  null],
  ['gears 5',                       3,  'Campaign co-op is three; Horde is five'],
  ['risk of rain returns',          4,  null],
  ['castle crashers',               4,  null],
  ['halo infinite',                 4,  'Campaign co-op is four'],
  ['the outlast trials',            4,  null],
  ['ready or not',                  5,  null],
  ['sea of stars',                  0,  'Single player only'],
  ['dave the diver',                0,  'Single player only'],
  ['stumble guys',                  0,  'PvP party game'],
  ['fall guys',                     0,  'PvP party game'],
  ['subnautica below zero',         0,  'No co-op — single player only'],
];

// Apostrophes are DELETED, not collapsed to a space: turning them into spaces
// makes "Baldur's Gate 3" normalise to "baldur s gate 3", which silently fails to
// match "baldurs gate 3" and quietly loses the cap for every possessive title —
// Garry's Mod, Don't Starve Together, Tiny Tina's Wonderlands.
const norm = (s) => s.toLowerCase()
  .replace(/[™®©'’`]/g, '')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

// Pull appid/name pairs straight out of the crawl so appids are Steam's, not mine.
const src = readFileSync(FROM, 'utf8');
const catalogue = new Map();
for (const m of src.matchAll(/VALUES \((\d+), '((?:[^']|'')*)'/g)) {
  catalogue.set(norm(m[2].replace(/''/g, "'")), { appid: Number(m[1]), name: m[2].replace(/''/g, "'") });
}

const sq = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const matched = [];
const missing = [];
for (const [name, cap, note] of CAPS) {
  const hit = catalogue.get(norm(name));
  if (!hit) { missing.push(name); continue; }
  matched.push({ ...hit, cap, note });
}

const sql = `-- CoopQ — verified online co-op player caps.
-- Generated by scripts/seed-player-caps.mjs from the curated list in that file.
--
-- ${matched.length} of ${CAPS.length} curated entries matched the catalogue.
-- Everything not listed keeps max_players = NULL, which the UI shows as
-- "player count unverified" and viability() treats as unknown rather than
-- blocked. That is deliberate: a missing cap is honest, a wrong one is not.

${matched.map((g) => `-- ${g.name}
UPDATE coop_apps SET max_players = ${g.cap}, max_players_src = 'manual',
       coop_note = ${sq(g.note)}
 WHERE appid = ${g.appid};`).join('\n\n')}
`;

writeFileSync(OUT, sql);
console.log(`${matched.length}/${CAPS.length} caps matched -> ${OUT}`);
if (missing.length) {
  console.log(`\nnot in the catalogue (no UPDATE emitted for these):`);
  for (const m of missing) console.log(`  - ${m}`);
}
