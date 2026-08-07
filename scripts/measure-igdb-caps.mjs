#!/usr/bin/env node
/**
 * Measure IGDB coverage for this Steam catalogue without changing any cap.
 *
 *   TWITCH_CLIENT_ID=... TWITCH_CLIENT_SECRET=... npm run measure:caps -- \
 *     --from migrations/002-coop-seed.sql --out igdb-cap-coverage.json
 *
 * A result is only "usable" when the Steam app maps to one IGDB game and its PC
 * multiplayer rows agree on a positive `onlinecoopmax`. Ambiguous values are
 * reported, never guessed. Review the JSON and compare conflicts with the curated
 * caps before creating any migration: IGDB coverage is evidence, not verification.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};
const from = arg('from', 'migrations/002-coop-seed.sql');
const out = arg('out', 'igdb-cap-coverage.json');
const verifiedFrom = arg('verified', 'migrations/003-player-caps.sql');
const limit = Math.max(0, Number(arg('limit', 0)) || 0);
const clientId = process.env.TWITCH_CLIENT_ID;
const clientSecret = process.env.TWITCH_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error('Set TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET from a confidential Twitch developer app.');
  process.exit(2);
}

const source = readFileSync(from, 'utf8');
let catalogue = [...source.matchAll(/VALUES \((\d+), '((?:[^']|'')*)'/g)].map((match) => ({
  appid: Number(match[1]),
  name: match[2].replace(/''/g, "'"),
}));
if (limit) catalogue = catalogue.slice(0, limit);
if (!catalogue.length) throw new Error(`No catalogue rows found in ${from}`);

const verified = new Map();
for (const statement of readFileSync(verifiedFrom, 'utf8').split(';')) {
  const cap = statement.match(/max_players\s*=\s*(\d+)/)?.[1];
  const appid = statement.match(/WHERE\s+appid\s*=\s*(\d+)/i)?.[1];
  if (cap != null && appid != null) verified.set(Number(appid), Number(cap));
}

const tokenResponse = await fetch('https://id.twitch.tv/oauth2/token', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'client_credentials',
  }),
  signal: AbortSignal.timeout(15_000),
});
if (!tokenResponse.ok) throw new Error(`Twitch token request failed (${tokenResponse.status})`);
const token = (await tokenResponse.json()).access_token;
if (!token) throw new Error('Twitch returned no access token');

let lastIgdbRequest = 0;
async function igdb(endpoint, query) {
  // Official limit is four requests/second. Serial 275 ms spacing leaves margin
  // for clock jitter and makes the script polite even when responses are instant.
  const wait = Math.max(0, 275 - (Date.now() - lastIgdbRequest));
  if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
  lastIgdbRequest = Date.now();
  const response = await fetch(`https://api.igdb.com/v4/${endpoint}`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'client-id': clientId,
      authorization: `Bearer ${token}`,
    },
    body: query,
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`IGDB ${endpoint} failed (${response.status}): ${detail}`);
  }
  return response.json();
}

async function igdbAll(endpoint, query) {
  const rows = [];
  for (let offset = 0; ; offset += 500) {
    const page = await igdb(endpoint, `${query} limit 500; offset ${offset};`);
    rows.push(...page);
    if (page.length < 500) return rows;
  }
}

const sources = await igdb('external_game_sources', 'fields id,name; limit 500;');
const steamSource = sources.find((sourceRow) => String(sourceRow.name).toLowerCase() === 'steam');
if (!steamSource) throw new Error('IGDB did not return a Steam external-game source');

const external = [];
for (const apps of chunks(catalogue, 100)) {
  const ids = apps.map((game) => `"${game.appid}"`).join(',');
  external.push(...await igdbAll('external_games',
    `fields uid,game,name,platform; where external_game_source = ${steamSource.id} & uid = (${ids});`));
}

const byApp = new Map();
for (const row of external) {
  const appid = Number(row.uid);
  if (!byApp.has(appid)) byApp.set(appid, []);
  byApp.get(appid).push(row);
}
const gameIds = [...new Set(external.map((row) => row.game).filter(Number.isInteger))];
const modes = [];
for (const ids of chunks(gameIds, 100)) {
  modes.push(...await igdbAll('multiplayer_modes',
    `fields game,platform,onlinecoop,onlinecoopmax; where game = (${ids.join(',')});`));
}

const measured = catalogue.map((game) => {
  const matches = byApp.get(game.appid) || [];
  const igdbIds = [...new Set(matches.map((match) => match.game))];
  if (igdbIds.length !== 1) {
    return { ...game, status: igdbIds.length ? 'ambiguous-game-match' : 'no-steam-match', igdbIds };
  }
  const platforms = new Set(matches.map((match) => match.platform).filter(Number.isInteger));
  const rows = modes.filter((mode) => mode.game === igdbIds[0]
    && (!platforms.size || platforms.has(mode.platform)));
  const caps = [...new Set(rows
    .filter((mode) => mode.onlinecoop === true && Number(mode.onlinecoopmax) > 0)
    .map((mode) => Number(mode.onlinecoopmax)))];
  const verifiedCap = verified.get(game.appid) ?? null;
  return {
    ...game,
    igdbId: igdbIds[0],
    status: caps.length === 1 ? 'usable-candidate'
      : caps.length > 1 ? 'ambiguous-cap' : rows.length ? 'no-online-coop-cap' : 'no-multiplayer-row',
    caps,
    verifiedCap,
    verifiedComparison: caps.length === 1 && verifiedCap != null
      ? caps[0] === verifiedCap ? 'agrees' : 'conflicts'
      : null,
    modes: rows,
  };
});

const count = (status) => measured.filter((row) => row.status === status).length;
const report = {
  measuredAt: new Date().toISOString(),
  source: from,
  verifiedSource: verifiedFrom,
  catalogueGames: catalogue.length,
  summary: {
    steamMatched: measured.filter((row) => row.igdbId).length,
    usableCandidates: count('usable-candidate'),
    ambiguousGameMatches: count('ambiguous-game-match'),
    ambiguousCaps: count('ambiguous-cap'),
    verifiedCompared: measured.filter((row) => row.verifiedComparison).length,
    verifiedConflicts: measured.filter((row) => row.verifiedComparison === 'conflicts').length,
    noSteamMatch: count('no-steam-match'),
    noMultiplayerRow: count('no-multiplayer-row'),
    noOnlineCoopCap: count('no-online-coop-cap'),
  },
  // Explicit warning for whoever consumes the output later: this is the result
  // of a coverage probe, not authorization to write `max_players`.
  decision: 'measurement only — manually verify usable candidates before generating a migration',
  games: measured,
};

writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
console.log(`${report.summary.usableCandidates}/${catalogue.length} unambiguous IGDB cap candidates -> ${out}`);
console.log(JSON.stringify(report.summary, null, 2));

function chunks(values, size) {
  const result = [];
  for (let i = 0; i < values.length; i += size) result.push(values.slice(i, i + size));
  return result;
}
