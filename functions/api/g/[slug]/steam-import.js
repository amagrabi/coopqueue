import { bad, body, json } from '../../../../lib/http.js';
import { getAppDetails, ownedGames } from '../../../../lib/steam.js';

const PAGE = 50;
const MAX_IMPORT = 50;
const ENRICH_BATCH = 3;

const day = (timestamp) => timestamp
  ? new Date(Number(timestamp) * 1000).toISOString().slice(0, 10)
  : null;
const hours = (minutes) => Math.round((Number(minutes) / 60) * 10) / 10;

function personalOnly(data) {
  return data.group.workspace_mode === 'personal'
    ? null
    : bad('Steam library import is available in personal workspaces', 409);
}

async function library(env, data) {
  if (!env.STEAM_API_KEY) return { error: bad('STEAM_API_KEY is not configured', 500) };
  const games = await ownedGames(env.STEAM_API_KEY, data.user.steam_id, { appInfo: true });
  if (games === null) return { error: bad('Steam could not be reached — try again later', 502) };
  if (!games.length) {
    return { error: bad('Steam returned no public library. Set Steam → Privacy → Game details to Public, then retry.', 409) };
  }
  return { games };
}

export async function onRequestPost({ request, env, data }) {
  const blocked = personalOnly(data);
  if (blocked) return blocked;
  const input = await body(request);
  if (input.action === 'enrich') return enrichImported(env, data);
  if (!['preview', 'import'].includes(input.action)) return bad('unknown import action');

  const steam = await library(env, data);
  if (steam.error) return steam.error;
  return input.action === 'preview'
    ? preview(env.DB, data, steam.games, input)
    : importSelected(env.DB, data, steam.games, input);
}

async function trackedAppids(db, groupId) {
  const rows = await db.prepare(
    'SELECT steam_appid FROM games WHERE group_id = ? AND steam_appid IS NOT NULL'
  ).bind(groupId).all();
  return new Set((rows.results || []).map((row) => Number(row.steam_appid)));
}

async function preview(db, data, owned, input) {
  const tracked = await trackedAppids(db, data.group.group_id);
  const missing = owned.filter((game) => !tracked.has(Number(game.appid)));
  const played = missing.filter((game) => Number(game.minutes) > 0);
  const unplayed = missing.filter((game) => !(Number(game.minutes) > 0));
  const source = input.includeUnplayed ? missing : played;
  source.sort((a, b) => Number(b.minutes) - Number(a.minutes)
    || String(a.name || '').localeCompare(String(b.name || '')));

  const offset = Math.max(0, Math.floor(Number(input.offset) || 0));
  const items = source.slice(offset, offset + PAGE).map((game) => ({
    appid: Number(game.appid),
    name: game.name || `Steam app ${game.appid}`,
    hours: hours(game.minutes),
    lastPlayed: day(game.lastPlayed),
    played: Number(game.minutes) > 0,
    image: game.iconHash
      ? `https://media.steampowered.com/steamcommunity/public/images/apps/${Number(game.appid)}/${game.iconHash}.jpg`
      : null,
  }));

  return json({
    items, offset, nextOffset: offset + items.length,
    hasMore: offset + items.length < source.length,
    counts: {
      owned: owned.length, tracked: tracked.size,
      missingPlayed: played.length, missingUnplayed: unplayed.length,
      playtimeReadable: owned.some((game) => Number(game.minutes) > 0),
    },
  });
}

async function importSelected(db, data, owned, input) {
  const requested = [...new Set((Array.isArray(input.appids) ? input.appids : [])
    .map(Number).filter((appid) => Number.isInteger(appid) && appid > 0))];
  if (!requested.length) return bad('select at least one game');
  if (requested.length > MAX_IMPORT) return bad(`import at most ${MAX_IMPORT} games at a time`);

  const gid = data.group.group_id;
  const existing = await trackedAppids(db, gid);
  const requestedSet = new Set(requested);
  const selected = owned.filter((game) => requestedSet.has(Number(game.appid))
    && !existing.has(Number(game.appid)));
  if (!selected.length) return bad('those games are already in this library', 409);
  const readable = owned.some((game) => Number(game.minutes) > 0);
  if (!readable && selected.some((game) => !(Number(game.minutes) > 0))
      && !input.acceptAmbiguousZero) {
    return bad('Steam reports zero playtime for every game. Confirm that hidden playtime should be imported as Backlog.', 409);
  }

  const count = await db.prepare('SELECT COUNT(*) AS n FROM games WHERE group_id = ?').bind(gid).first();
  const room = Math.max(0, 2000 - (count?.n ?? 0));
  if (selected.length > room) return bad('this library has hit the 2000-game limit', 429);

  const placeholders = selected.map(() => '?').join(',');
  const cachedRows = await db.prepare(
    `SELECT * FROM steam_apps WHERE appid IN (${placeholders})`
  ).bind(...selected.map((game) => Number(game.appid))).all();
  const cached = new Map((cachedRows.results || []).map((row) => [Number(row.appid), row]));

  await db.batch(selected.map((game) => {
    const meta = cached.get(Number(game.appid));
    const played = Number(game.minutes) > 0;
    return db.prepare(
      `INSERT OR IGNORE INTO games
         (group_id,name,steam_appid,genre,status,header_image,trailer_url,short_description,
          price,release_date,metacritic,hours,finished,added_by,enriched_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      gid, meta?.name || game.name || `Steam app ${game.appid}`, Number(game.appid),
      meta?.genre || null, played ? 'sampled' : 'backlog', meta?.header_image || null,
      meta?.trailer_url || null, meta?.short_description || null, meta?.price || null,
      meta?.release_date || null, meta?.metacritic ?? null, played ? hours(game.minutes) : null,
      played ? day(game.lastPlayed) : null, data.user.steam_id,
      meta ? Math.floor(Date.now() / 1000) : null
    );
  }));

  // The watermark below says this whole library was visible. Persist every owned
  // app already tracked here as well as the new selections, or an existing owned
  // game with no older playtime row would be misread as a proven negative.
  const groupApps = new Set([...existing, ...selected.map((game) => Number(game.appid))]);
  const matchedPlaytime = owned.filter((game) => groupApps.has(Number(game.appid)));
  for (let i = 0; i < matchedPlaytime.length; i += 50) {
    await db.batch(matchedPlaytime.slice(i, i + 50).map((game) => db.prepare(
      `INSERT INTO playtime (steam_id,appid,minutes,last_played,fetched_at)
       VALUES (?,?,?,?,unixepoch())
       ON CONFLICT(steam_id,appid) DO UPDATE SET minutes=excluded.minutes,
         last_played=excluded.last_played,fetched_at=unixepoch()`
    ).bind(data.user.steam_id, Number(game.appid), Number(game.minutes) || 0, game.lastPlayed ?? null)));
  }

  const insertedRows = await db.prepare(
    `SELECT id,steam_appid,hours,finished FROM games
      WHERE group_id = ? AND steam_appid IN (${placeholders})`
  ).bind(gid, ...selected.map((game) => Number(game.appid))).all();
  const facts = [];
  for (const game of insertedRows.results || []) {
    if (game.hours != null) facts.push(db.prepare(
      `INSERT OR IGNORE INTO game_fact_sources (group_id,game_id,field,source,set_by)
       VALUES (?,?,'hours','steam-hours',?)`
    ).bind(gid, game.id, data.user.steam_id));
    if (game.finished) facts.push(db.prepare(
      `INSERT OR IGNORE INTO game_fact_sources (group_id,game_id,field,source,set_by)
       VALUES (?,?,'finished','steam-last-played',?)`
    ).bind(gid, game.id, data.user.steam_id));
  }
  for (let i = 0; i < facts.length; i += 50) await db.batch(facts.slice(i, i + 50));

  const playedCount = owned.filter((game) => Number(game.minutes) > 0).length;
  await db.batch([
    db.prepare(
      `INSERT INTO playtime_sync (steam_id,games,played,synced_at) VALUES (?,?,?,unixepoch())
       ON CONFLICT(steam_id) DO UPDATE SET games=excluded.games,played=excluded.played,synced_at=unixepoch()`
    ).bind(data.user.steam_id, owned.length, playedCount),
    db.prepare(
      `INSERT INTO group_library_sync (group_id,steam_id,games,played,synced_at)
       VALUES (?,?,?,?,unixepoch())
       ON CONFLICT(group_id,steam_id) DO UPDATE SET games=excluded.games,
         played=excluded.played,synced_at=unixepoch()`
    ).bind(gid, data.user.steam_id, owned.length, playedCount),
  ]);

  const pending = await pendingMetadata(db, gid);
  return json({
    imported: selected.length,
    names: selected.slice(0, 5).map((game) => game.name || `Steam app ${game.appid}`),
    metadataRemaining: pending,
  }, 201);
}

async function pendingMetadata(db, groupId) {
  const row = await db.prepare(
    `SELECT COUNT(*) AS n FROM games
      WHERE group_id = ? AND archived_at IS NULL AND steam_appid IS NOT NULL AND enriched_at IS NULL`
  ).bind(groupId).first();
  return row?.n ?? 0;
}

async function enrichImported(env, data) {
  const gid = data.group.group_id;
  const rows = await env.DB.prepare(
    `SELECT id,steam_appid FROM games
      WHERE group_id = ? AND archived_at IS NULL AND steam_appid IS NOT NULL AND enriched_at IS NULL
      ORDER BY id LIMIT ?`
  ).bind(gid, ENRICH_BATCH).all();
  let enriched = 0;
  const games = rows.results || [];
  const metadata = await Promise.all(games.map((game) => getAppDetails(env.DB, game.steam_appid)));
  for (let i = 0; i < games.length; i++) {
    const game = games[i];
    const meta = metadata[i];
    if (!meta) continue;
    await env.DB.prepare(
      `UPDATE games SET name=?,genre=COALESCE(genre,?),header_image=?,trailer_url=?,
                        short_description=?,price=?,release_date=?,metacritic=?,enriched_at=unixepoch()
        WHERE id=? AND group_id=?`
    ).bind(meta.name, meta.genre, meta.header_image, meta.trailer_url, meta.short_description,
      meta.price, meta.release_date, meta.metacritic, game.id, gid).run();
    enriched++;
  }
  return json({ processed: games.length, enriched, remaining: await pendingMetadata(env.DB, gid) });
}
