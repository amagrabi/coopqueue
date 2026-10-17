import { bad, body, json } from '../../../../lib/http.js';
import { classifyGameType } from '../../../../lib/coop.js';
import {
  getAppDetails, getAppSummaries, ownedGames, wishlistedGames,
} from '../../../../lib/steam.js';

const PAGE = 250;
const MAX_IMPORT = 250;
const DB_BATCH = 50;
const ENRICH_BATCH = 8;
const GAME_TYPES = new Set(['coop', 'multiplayer', 'solo', 'unknown']);

const day = (timestamp) => timestamp
  ? new Date(Number(timestamp) * 1000).toISOString().slice(0, 10)
  : null;
const hours = (minutes) => Math.round((Number(minutes) / 60) * 10) / 10;
const chunks = (items, size = DB_BATCH) => {
  const result = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
};

async function appSummaries(db, appids) {
  const summaries = [];
  // The store-browse helper is intentionally capped at 50 appids. Keep that
  // upstream safety boundary even though one import can now span several D1
  // batches; preview rows already in the shared cache cost no Steam request.
  for (const batch of chunks(appids)) summaries.push(...await getAppSummaries(db, batch));
  return summaries;
}

async function cachedApps(db, appids) {
  const rows = [];
  for (const batch of chunks(appids)) {
    const placeholders = batch.map(() => '?').join(',');
    const result = await db.prepare(
      `SELECT * FROM steam_apps WHERE appid IN (${placeholders})`
    ).bind(...batch).all();
    rows.push(...(result.results || []));
  }
  return rows;
}

async function verifiedCatalogueApps(db, appids) {
  const rows = [];
  for (const batch of chunks(appids)) {
    const placeholders = batch.map(() => '?').join(',');
    const result = await db.prepare(
      `SELECT appid,max_players,coop_note FROM coop_apps
        WHERE appid IN (${placeholders}) AND max_players IS NOT NULL
          AND max_players_src IS NOT NULL`
    ).bind(...batch).all();
    rows.push(...(result.results || []));
  }
  return rows;
}

const parseList = (value) => {
  try {
    const parsed = Array.isArray(value) ? value : JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed.filter((label) => typeof label === 'string') : [];
  }
  catch { return []; }
};

async function classifyApps(db, appids) {
  const evidence = new Map();
  for (const batch of chunks(appids)) {
    const placeholders = batch.map(() => '?').join(',');
    const result = await db.prepare(
      `SELECT appid,coop_categories,tags,NULL AS is_coop,0 AS catalogue
         FROM steam_apps WHERE appid IN (${placeholders})
       UNION ALL
       SELECT appid,coop_categories,tags,is_coop,1 AS catalogue
         FROM coop_apps WHERE appid IN (${placeholders})`
    ).bind(...batch, ...batch).all();
    for (const row of result.results || []) {
      const appid = Number(row.appid);
      const current = evidence.get(appid) || { categories: [], steamTags: [], tags: [], isCoop: null };
      current.categories.push(...parseList(row.coop_categories));
      // Preserve one ranked list; concatenating sources changes the PvP window.
      if (row.catalogue) {
        current.tags = parseList(row.tags);
        current.isCoop = row.is_coop == null ? null : Number(row.is_coop);
      } else current.steamTags = parseList(row.tags);
      evidence.set(appid, current);
    }
  }
  return new Map(appids.map((appid) => {
    const row = evidence.get(Number(appid));
    return [Number(appid), classifyGameType(row ? {
      tags: row.tags.length ? row.tags : row.steamTags,
      categories: row.categories, isCoop: row.isCoop,
    } : undefined)];
  }));
}

function requestedGameTypes(data, input) {
  if (Array.isArray(input.gameTypes)) {
    return new Set(input.gameTypes.map(String).filter((type) => GAME_TYPES.has(type)));
  }
  return data.group.workspace_mode === 'personal'
    ? new Set(GAME_TYPES) : new Set(['coop']);
}

async function steamSources(env, data) {
  const [owned, wishlist] = await Promise.all([
    env.STEAM_API_KEY
      ? ownedGames(env.STEAM_API_KEY, data.user.steam_id, { appInfo: true })
      : Promise.resolve(null),
    wishlistedGames(data.user.steam_id),
  ]);
  const ownedList = Array.isArray(owned) ? owned : [];
  const wishlistList = Array.isArray(wishlist) ? wishlist : [];
  if (owned === null && wishlist === null) {
    return { error: bad('Steam could not be reached — try again later', 502) };
  }
  if (!ownedList.length && !wishlistList.length) {
    return { error: bad('Steam returned no public library or wishlist. Check your Steam privacy settings, then retry.', 409) };
  }
  return {
    owned: ownedList,
    wishlist: wishlistList,
    ownedState: owned === null ? 'unavailable' : ownedList.length ? 'available' : 'empty',
    wishlistState: wishlist === null ? 'unavailable' : wishlistList.length ? 'available' : 'empty',
  };
}

function mergedGames(owned, wishlist) {
  const games = new Map();
  for (const game of owned) games.set(Number(game.appid), {
    ...game, appid: Number(game.appid), owned: true, wishlisted: false,
  });
  for (const item of wishlist) {
    const appid = Number(item.appid);
    const game = games.get(appid) || { appid, minutes: 0, lastPlayed: null, owned: false };
    games.set(appid, {
      ...game, wishlisted: true, wishlistPriority: item.priority,
      wishlistedAt: item.dateAdded,
    });
  }
  return [...games.values()];
}

export async function onRequestPost({ request, env, data }) {
  const input = await body(request);
  if (input.action === 'enrich') return enrichImported(env, data);
  if (!['preview', 'import'].includes(input.action)) return bad('unknown import action');

  const steam = await steamSources(env, data);
  if (steam.error) return steam.error;
  return input.action === 'preview'
    ? preview(env.DB, data, steam, input)
    : importSelected(env, data, steam, input);
}

async function trackedAppids(db, groupId) {
  const rows = await db.prepare(
    'SELECT steam_appid FROM games WHERE group_id = ? AND steam_appid IS NOT NULL'
  ).bind(groupId).all();
  return new Set((rows.results || []).map((row) => Number(row.steam_appid)));
}

async function preview(db, data, steam, input) {
  const tracked = await trackedAppids(db, data.group.group_id);
  const missing = mergedGames(steam.owned, steam.wishlist)
    .filter((game) => !tracked.has(game.appid));
  const sourceFilter = ['owned', 'wishlist'].includes(input.source) ? input.source : 'all';
  const sourceCandidates = missing.filter((game) => {
    const ownedVisible = game.owned && (input.includeUnplayed || Number(game.minutes) > 0);
    if (sourceFilter === 'owned') return ownedVisible;
    if (sourceFilter === 'wishlist') return game.wishlisted;
    return game.wishlisted || ownedVisible;
  });
  const classifications = await classifyApps(db, sourceCandidates.map((game) => game.appid));
  const gameTypes = requestedGameTypes(data, input);
  const source = sourceCandidates.filter((game) => gameTypes.has(classifications.get(game.appid)));
  source.sort((a, b) => Number(Number(b.minutes) > 0) - Number(Number(a.minutes) > 0)
    || Number(b.minutes) - Number(a.minutes)
    || Number(b.wishlistedAt) - Number(a.wishlistedAt)
    || String(a.name || '').localeCompare(String(b.name || '')));

  const offset = Math.max(0, Math.floor(Number(input.offset) || 0));
  const page = source.slice(offset, offset + PAGE);
  const summaries = new Map((await appSummaries(db, page.map((game) => game.appid)))
    .map((summary) => [summary.appid, summary]));
  const items = page.map((game) => {
    const summary = summaries.get(game.appid);
    return {
      appid: game.appid,
      name: game.name || summary?.name || `Steam app ${game.appid}`,
      hours: hours(game.minutes),
      lastPlayed: day(game.lastPlayed),
      played: Number(game.minutes) > 0,
      owned: game.owned,
      wishlisted: game.wishlisted,
      wishlistedAt: day(game.wishlistedAt),
      gameType: classifications.get(game.appid) || 'unknown',
      image: game.iconHash
        ? `https://media.steampowered.com/steamcommunity/public/images/apps/${game.appid}/${game.iconHash}.jpg`
        : summary?.image || null,
    };
  });

  return json({
    items, offset, nextOffset: offset + items.length,
    hasMore: offset + items.length < source.length,
    counts: {
      owned: steam.owned.length, wishlisted: steam.wishlist.length, tracked: tracked.size,
      missingTotal: missing.length,
      missingOwned: missing.filter((game) => game.owned).length,
      missingWishlist: missing.filter((game) => game.wishlisted).length,
      matching: source.length,
      types: Object.fromEntries([...GAME_TYPES].map((type) => [
        type, sourceCandidates.filter((game) => classifications.get(game.appid) === type).length,
      ])),
      playtimeReadable: steam.owned.some((game) => Number(game.minutes) > 0),
      ownedState: steam.ownedState, wishlistState: steam.wishlistState,
    },
  });
}

async function importSelected(env, data, steam, input) {
  const db = env.DB;
  const requested = [...new Set((Array.isArray(input.appids) ? input.appids : [])
    .map(Number).filter((appid) => Number.isInteger(appid) && appid > 0))];
  if (!requested.length) return bad('select at least one game');
  if (requested.length > MAX_IMPORT) return bad(`import at most ${MAX_IMPORT} games at a time`);

  const gid = data.group.group_id;
  const existing = await trackedAppids(db, gid);
  const requestedSet = new Set(requested);
  const selected = mergedGames(steam.owned, steam.wishlist)
    .filter((game) => requestedSet.has(game.appid) && !existing.has(game.appid));
  if (!selected.length) return bad('those games are already in this library', 409);
  const readable = steam.owned.some((game) => Number(game.minutes) > 0);
  if (!readable && selected.some((game) => game.owned && !game.wishlisted
      && !(Number(game.minutes) > 0))
      && !input.acceptAmbiguousZero) {
    return bad('Steam reports zero playtime for every game. Confirm that hidden playtime should be imported as Backlog.', 409);
  }

  const count = await db.prepare('SELECT COUNT(*) AS n FROM games WHERE group_id = ?').bind(gid).first();
  const room = Math.max(0, 2000 - (count?.n ?? 0));
  if (selected.length > room) return bad('this library has hit the 2000-game limit', 429);

  const selectedAppids = selected.map((game) => Number(game.appid));
  const summaries = new Map((await appSummaries(db, selectedAppids))
    .map((summary) => [summary.appid, summary]));
  const cached = new Map((await cachedApps(db, selectedAppids))
    .map((row) => [Number(row.appid), row]));
  const catalogue = new Map((await verifiedCatalogueApps(db, selectedAppids))
    .map((row) => [Number(row.appid), row]));

  const inserts = selected.map((game) => {
    const meta = cached.get(Number(game.appid));
    const summary = summaries.get(Number(game.appid));
    const verified = catalogue.get(Number(game.appid));
    const played = Number(game.minutes) > 0;
    return db.prepare(
      `INSERT OR IGNORE INTO games
         (group_id,name,steam_appid,genre,status,max_players,coop_note,header_image,trailer_url,
          short_description,price,release_date,metacritic,hours,finished,added_by,enriched_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      gid, meta?.name || game.name || summary?.name || `Steam app ${game.appid}`, Number(game.appid),
      meta?.genre || null, played ? 'sampled' : 'backlog',
      verified?.max_players ?? null, verified?.coop_note || null,
      meta?.header_image || summary?.headerImage || null,
      meta?.trailer_url || null, meta?.short_description || null, meta?.price || null,
      meta?.release_date || null, meta?.metacritic ?? null, played ? hours(game.minutes) : null,
      played ? day(game.lastPlayed) : null, data.user.steam_id,
      Number(meta?.fetched_at) > 0 ? Math.floor(Date.now() / 1000) : null
    );
  });
  for (const batch of chunks(inserts)) await db.batch(batch);

  // The watermark below says this whole library was visible. Persist every owned
  // app already tracked here as well as the new selections, or an existing owned
  // game with no older playtime row would be misread as a proven negative.
  const groupApps = new Set([...existing, ...selected.map((game) => Number(game.appid))]);
  const matchedPlaytime = steam.owned.filter((game) => groupApps.has(Number(game.appid)));
  if (steam.owned.length) for (const batch of chunks(matchedPlaytime)) {
    await db.batch(batch.map((game) => db.prepare(
      `INSERT INTO playtime (steam_id,appid,minutes,last_played,fetched_at)
       VALUES (?,?,?,?,unixepoch())
       ON CONFLICT(steam_id,appid) DO UPDATE SET minutes=excluded.minutes,
         last_played=excluded.last_played,fetched_at=unixepoch()`
    ).bind(data.user.steam_id, Number(game.appid), Number(game.minutes) || 0, game.lastPlayed ?? null)));
  }

  const insertedRows = [];
  for (const batch of chunks(selectedAppids)) {
    const placeholders = batch.map(() => '?').join(',');
    const result = await db.prepare(
      `SELECT id,steam_appid,hours,finished FROM games
        WHERE group_id = ? AND steam_appid IN (${placeholders})`
    ).bind(gid, ...batch).all();
    insertedRows.push(...(result.results || []));
  }
  const facts = [];
  for (const game of insertedRows) {
    if (game.hours != null) facts.push(db.prepare(
      `INSERT OR IGNORE INTO game_fact_sources (group_id,game_id,field,source,set_by)
       VALUES (?,?,'hours','steam-hours',?)`
    ).bind(gid, game.id, data.user.steam_id));
    if (game.finished) facts.push(db.prepare(
      `INSERT OR IGNORE INTO game_fact_sources (group_id,game_id,field,source,set_by)
       VALUES (?,?,'finished','steam-last-played',?)`
    ).bind(gid, game.id, data.user.steam_id));
  }
  for (const batch of chunks(facts)) await db.batch(batch);

  if (steam.owned.length) {
    const playedCount = steam.owned.filter((game) => Number(game.minutes) > 0).length;
    await db.batch([
      db.prepare(
        `INSERT INTO playtime_sync (steam_id,games,played,synced_at) VALUES (?,?,?,unixepoch())
         ON CONFLICT(steam_id) DO UPDATE SET games=excluded.games,played=excluded.played,synced_at=unixepoch()`
      ).bind(data.user.steam_id, steam.owned.length, playedCount),
      db.prepare(
        `INSERT INTO group_library_sync (group_id,steam_id,games,played,synced_at)
         VALUES (?,?,?,?,unixepoch())
         ON CONFLICT(group_id,steam_id) DO UPDATE SET games=excluded.games,
           played=excluded.played,synced_at=unixepoch()`
      ).bind(gid, data.user.steam_id, steam.owned.length, playedCount),
    ]);
  }

  const pending = await pendingMetadata(db, gid);
  return json({
    imported: selected.length,
    importedOwned: selected.filter((game) => game.owned).length,
    importedWishlist: selected.filter((game) => game.wishlisted).length,
    importedPlayed: selected.filter((game) => Number(game.minutes) > 0).length,
    names: selected.slice(0, 5).map((game) => game.name
      || summaries.get(game.appid)?.name || `Steam app ${game.appid}`),
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

async function backfillVerifiedCaps(db, groupId) {
  const result = await db.prepare(
    `SELECT id,steam_appid FROM games
      WHERE group_id=? AND archived_at IS NULL AND steam_appid IS NOT NULL
        AND max_players IS NULL`
  ).bind(groupId).all();
  const games = result.results || [];
  const catalogue = new Map((await verifiedCatalogueApps(db, games.map((game) => game.steam_appid)))
    .map((row) => [Number(row.appid), row]));
  const updates = games.flatMap((game) => {
    const verified = catalogue.get(Number(game.steam_appid));
    return verified ? [db.prepare(
      `UPDATE games SET max_players=?,coop_note=COALESCE(coop_note,?)
        WHERE id=? AND group_id=? AND max_players IS NULL`
    ).bind(verified.max_players, verified.coop_note || null, game.id, groupId)] : [];
  });
  let added = 0;
  for (const batch of chunks(updates)) {
    const responses = await db.batch(batch);
    added += responses.reduce((sum, response) =>
      sum + Number(response?.meta?.changes ?? response?.changes ?? 0), 0);
  }
  return added;
}

async function enrichImported(env, data) {
  const gid = data.group.group_id;
  const playerCapsAdded = await backfillVerifiedCaps(env.DB, gid);
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
  return json({
    processed: games.length, enriched, playerCapsAdded,
    remaining: await pendingMetadata(env.DB, gid),
  });
}
