/**
 * Steam integration. Two public endpoints, both free:
 *   - the Web API (needs a key) for player profiles
 *   - the store's undocumented JSON endpoints (no key) for game metadata
 *
 * The store endpoints throttle at roughly 200 requests / 5 min per IP. That is
 * generous for one group and the hard ceiling for a public site, so every
 * lookup goes through `steam_apps`, a cache shared across all groups: the
 * thousandth group to add Terraria costs zero requests.
 */
const UA = { 'user-agent': 'CoopQueue (co-op game tracker)' };
const CACHE_TTL = 14 * 86400; // seconds — prices drift, nothing else really does
const STEAM_TIMEOUT = 10_000;

const steamFetch = (url, options = {}) => fetch(url, {
  ...options,
  headers: { ...UA, ...options.headers },
  signal: AbortSignal.timeout(STEAM_TIMEOUT),
}).catch(() => null);

const https = (u) => (typeof u === 'string' ? u.replace(/^http:\/\//, 'https://') : null);
const stripTags = (s) => (typeof s === 'string' ? s.replace(/<[^>]*>/g, '').trim() : null);

/** Steam persona name + avatar for a SteamID64. */
export async function playerSummary(apiKey, steamId) {
  if (!apiKey) return null;
  const url = `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${apiKey}&steamids=${steamId}`;
  const r = await steamFetch(url);
  if (!r?.ok) return null;
  const j = await r.json().catch(() => null);
  const p = j?.response?.players?.[0];
  return p ? { displayName: p.personaname, avatar: https(p.avatarfull) } : null;
}

/** Store search by free text. Not cached — the query space is unbounded. */
export async function searchStore(term, cc = 'de') {
  const url = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(term)}&l=english&cc=${cc}`;
  const r = await steamFetch(url);
  if (!r?.ok) return [];
  const j = await r.json().catch(() => null);
  return (j?.items || []).slice(0, 12).map((i) => ({
    appid: i.id,
    name: i.name,
    image: https(i.tiny_image),
    price: formatPrice(i.price),
  }));
}

/**
 * Metadata for one appid, cache-first. Returns null only if Steam has nothing
 * *and* we have no cached copy; a stale cache entry beats a failed fetch.
 */
export async function getAppDetails(db, appid, cc = 'de') {
  const cached = await db.prepare('SELECT * FROM steam_apps WHERE appid = ?').bind(appid).first();
  const fresh = cached && Date.now() / 1000 - cached.fetched_at < CACHE_TTL;
  if (fresh) return shape(cached);

  const live = await fetchAppDetails(appid, cc);
  // Wishlist previews cache only a name and image with fetched_at=0. That row is
  // useful for the picker, but it is not a trustworthy fallback for full
  // enrichment: treating it as one would mark every missing field complete after
  // a transient store failure and prevent a later retry.
  if (!live) return cached && Number(cached.fetched_at) > 0 ? shape(cached) : null;

  await db.prepare(
    `INSERT INTO steam_apps (appid, name, genre, header_image, trailer_url, short_description,
                             price, release_date, metacritic, coop_categories, fetched_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,unixepoch())
     ON CONFLICT(appid) DO UPDATE SET
       name = excluded.name, genre = excluded.genre, header_image = excluded.header_image,
       trailer_url = excluded.trailer_url, short_description = excluded.short_description,
       price = excluded.price, release_date = excluded.release_date,
       metacritic = excluded.metacritic, coop_categories = excluded.coop_categories,
       fetched_at = unixepoch()`
  ).bind(
    appid, live.name, live.genre, live.header_image, live.trailer_url, live.short_description,
    live.price, live.release_date, live.metacritic, JSON.stringify(live.coop_categories || [])
  ).run();

  return live;
}

const shape = (row) => ({
  appid: row.appid,
  name: row.name,
  genre: row.genre,
  header_image: row.header_image,
  trailer_url: row.trailer_url,
  short_description: row.short_description,
  price: row.price,
  release_date: row.release_date,
  metacritic: row.metacritic,
  coop_categories: safeParse(row.coop_categories),
});

const safeParse = (s) => { try { return JSON.parse(s || '[]'); } catch { return []; } };

async function fetchAppDetails(appid, cc) {
  const url = `https://store.steampowered.com/api/appdetails?appids=${appid}&cc=${cc}&l=english`;
  const r = await steamFetch(url);
  if (!r?.ok) return null;
  const j = await r.json().catch(() => null);
  const entry = j?.[String(appid)];
  if (!entry?.success || !entry.data) return null;
  const d = entry.data;
  const movie = (d.movies || []).find((m) => m.highlight) || (d.movies || [])[0];
  return {
    appid,
    name: d.name,
    genre: d.genres?.[0]?.description || null,
    header_image: https(d.header_image),
    // Steam retired the flat mp4/webm trailer files in favour of adaptive
    // streams, so `movies[].mp4.max` is now absent and this silently produced
    // null for every game. Prefer a progressive file when one is still offered
    // (older entries), then fall back to the HLS manifest — the only remaining
    // single URL a <video> element can consume without a streaming library.
    // Chrome and Firefox cannot play HLS natively; app.js feature-detects and
    // shows the header image instead of a video that never starts.
    trailer_url: https(movie?.mp4?.max || movie?.mp4?.['480'] ||
                       movie?.webm?.max || movie?.hls_h264) || null,
    short_description: stripTags(d.short_description),
    price: d.is_free ? 'Free' : formatPrice(d.price_overview),
    release_date: d.release_date?.date || null,
    metacritic: d.metacritic?.score ?? null,
    // Steam's own co-op tags — a hint, never the source of truth for a player cap.
    coop_categories: (d.categories || []).map((c) => c.description).filter((c) => /co-?op|multi-?player/i.test(c)),
  };
}

function formatPrice(p) {
  if (!p) return null;
  if (typeof p.final_formatted === 'string') return p.final_formatted;
  if (typeof p.final === 'number') return `${(p.final / 100).toFixed(2)} ${p.currency || 'EUR'}`;
  return null;
}

/** Pull an appid out of anything a person might paste. */
export function parseAppId(input) {
  if (!input) return null;
  const s = String(input).trim();
  if (/^\d+$/.test(s)) return Number(s);
  const m = s.match(/store\.steampowered\.com\/app\/(\d+)/i) || s.match(/[?&]appid=(\d+)/i);
  return m ? Number(m[1]) : null;
}

/**
 * Every game a person owns, with lifetime minutes played.
 *
 * One call covers their whole library, which is why the playtime sync is a button
 * rather than a crawl. Requires the account's *Game details* privacy to be Public:
 * Steam answers a hidden profile with an empty list and HTTP 200, not an error, so
 * `[]` genuinely cannot be distinguished from "owns nothing" — callers must record
 * the attempt to tell a private profile from an empty one.
 */
export async function ownedGames(apiKey, steamId, { appInfo = false } = {}) {
  if (!apiKey) return null;
  const url = 'https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/'
    + `?key=${apiKey}&steamid=${steamId}&include_played_free_games=1`
    + `${appInfo ? '&include_appinfo=1' : ''}&format=json`;
  const r = await steamFetch(url);
  if (!r?.ok) return null;
  const j = await r.json().catch(() => null);
  const games = j?.response?.games;
  if (!Array.isArray(games)) return [];
  /* rtime_last_played is the only time-shaped field Steam offers here — there is no
     first-played or acquired date, so a start date can never be derived. 0 means
     "owned but never launched", which is not a date. */
  return games.map((g) => ({
    appid: g.appid,
    name: appInfo && g.name ? String(g.name).slice(0, 120) : null,
    iconHash: appInfo && /^[a-f0-9]+$/i.test(g.img_icon_url || '') ? g.img_icon_url : null,
    minutes: g.playtime_forever || 0,
    lastPlayed: g.rtime_last_played > 0 ? g.rtime_last_played : null,
  }));
}

/**
 * Public wishlist rows for one SteamID64.
 *
 * Valve exposes this service without a Web API key, but does not list it in the
 * published Web API reference. Keep the response deliberately small and treat an
 * empty array like GetOwnedGames: it can mean either genuinely empty or hidden.
 */
export async function wishlistedGames(steamId) {
  const url = 'https://api.steampowered.com/IWishlistService/GetWishlist/v1/'
    + `?steamid=${encodeURIComponent(steamId)}`;
  const r = await steamFetch(url);
  if (!r?.ok) return null;
  const j = await r.json().catch(() => null);
  const items = j?.response?.items;
  if (!Array.isArray(items)) return [];
  return items.slice(0, 5000).map((item) => ({
    appid: Number(item.appid),
    priority: Number(item.priority) || 0,
    dateAdded: Number(item.date_added) > 0 ? Number(item.date_added) : null,
  })).filter((item) => Number.isInteger(item.appid) && item.appid > 0);
}

/**
 * Cache-first names and artwork for a bounded list of appids.
 *
 * GetWishlist returns only ids, while showing fifty anonymous numbers would make
 * selective import unusable. Steam's store browse service can resolve the whole
 * page in one request. Its partial rows are cached with fetched_at=0, deliberately
 * stale, so getAppDetails still performs the authoritative full enrichment later.
 */
export async function getAppSummaries(db, appids) {
  const ids = [...new Set((appids || []).map(Number)
    .filter((appid) => Number.isInteger(appid) && appid > 0))].slice(0, 50);
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(',');
  const [steamRows, catalogueRows] = await Promise.all([
    db.prepare(
      `SELECT appid,name,header_image FROM steam_apps WHERE appid IN (${placeholders})`
    ).bind(...ids).all(),
    db.prepare(
      `SELECT appid,name,header_image FROM coop_apps WHERE appid IN (${placeholders})`
    ).bind(...ids).all(),
  ]);
  const summaries = new Map();
  for (const row of steamRows.results || []) if (row.name) {
    summaries.set(Number(row.appid), {
      appid: Number(row.appid), name: row.name, image: row.header_image,
      headerImage: row.header_image,
    });
  }
  for (const row of catalogueRows.results || []) if (!summaries.has(Number(row.appid))) {
    summaries.set(Number(row.appid), {
      appid: Number(row.appid), name: row.name, image: row.header_image,
      headerImage: row.header_image,
    });
  }

  const missing = ids.filter((appid) => !summaries.has(appid));
  if (missing.length) {
    const input = {
      ids: missing.map((appid) => ({ appid })),
      context: { language: 'english', country_code: 'DE', steam_realm: 1 },
      data_request: { include_assets: true },
    };
    const url = 'https://api.steampowered.com/IStoreBrowseService/GetItems/v1/'
      + `?input_json=${encodeURIComponent(JSON.stringify(input))}`;
    const r = await steamFetch(url);
    const j = r?.ok ? await r.json().catch(() => null) : null;
    const live = (j?.response?.store_items || []).map((item) => {
      const assets = item.assets || {};
      const asset = (filename) => assets.asset_url_format && filename
        ? `https://shared.fastly.steamstatic.com/store_item_assets/${assets.asset_url_format.replace('${FILENAME}', filename)}`
        : null;
      return {
        appid: Number(item.appid),
        name: typeof item.name === 'string' ? item.name.slice(0, 120) : null,
        image: asset(assets.small_capsule || assets.header),
        headerImage: asset(assets.header || assets.main_capsule),
      };
    }).filter((item) => Number.isInteger(item.appid) && item.appid > 0 && item.name);
    for (const item of live) summaries.set(item.appid, item);
    if (live.length) await db.batch(live.map((item) => db.prepare(
      `INSERT INTO steam_apps (appid,name,header_image,fetched_at) VALUES (?,?,?,0)
       ON CONFLICT(appid) DO UPDATE SET
         name=COALESCE(steam_apps.name,excluded.name),
         header_image=COALESCE(steam_apps.header_image,excluded.header_image)`
    ).bind(item.appid, item.name, item.headerImage)));
  }
  return ids.map((appid) => summaries.get(appid)).filter(Boolean);
}

/**
 * One member's achievement progress for one game.
 *
 * Deliberately one game at a time. Fetching every member × every library game
 * would turn one click into hundreds of Steam subrequests and make a private
 * profile indistinguishable from a half-finished bulk sync. The route caches this
 * result and lets each member refresh their own row from the game detail panel.
 */
async function communityAchievements(steamId, appid) {
  const url = `https://steamcommunity.com/profiles/${encodeURIComponent(steamId)}`
    + `/stats/${encodeURIComponent(appid)}/?xml=1`;
  const r = await steamFetch(url);
  if (!r?.ok) return null;
  const xml = await r.text().catch(() => null);
  if (!xml || !/<playerstats\b/i.test(xml)) return null;

  const privacy = xmlText(xml, 'privacyState')?.toLowerCase();
  if (privacy && privacy !== 'public') {
    return {
      available: false,
      retryable: false,
      reason: 'Steam achievement data is private for this account',
    };
  }
  const error = xmlText(xml, 'error');
  if (error) return { available: false, retryable: false, reason: error };
  if (!/<achievements\b/i.test(xml)) return null;

  const achievements = [...xml.matchAll(/<achievement\b([^>]*)>([\s\S]*?)<\/achievement>/gi)]
    .map((match) => {
      const key = xmlText(match[2], 'apiname') || '';
      return {
        key,
        name: (xmlText(match[2], 'name') || key || 'Achievement').slice(0, 200),
        achieved: /\bclosed=(['"])1\1/i.test(match[1]),
        unlocktime: Number(xmlText(match[2], 'unlockTimestamp')) || 0,
      };
    }).filter((achievement) => achievement.key);

  /* `privacyState=public` describes the profile, not necessarily Game details.
     When Game details are hidden, Steam still returns the full achievement schema
     but marks every item locked (and hoursPlayed as zero). That is
     indistinguishable from a genuine 0/N account, so only positive unlocks are
     evidence. Never turn privacy-masked absence into a confident zero. */
  if (achievements.length && !achievements.some((achievement) => achievement.achieved)) {
    return {
      available: false,
      retryable: false,
      invalidateZero: true,
      reason: 'Steam exposed the achievement list but no unlock status. If you have played this game, set Steam → Edit Profile → Privacy Settings → Game details to Public, make sure the game is not marked Private, then retry.',
    };
  }

  return {
    available: true,
    gameName: xmlText(xml, 'gameName'),
    achievements,
  };
}

function xmlText(source, tag) {
  const match = source.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  if (!match) return null;
  const value = match[1].trim();
  const cdata = value.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/);
  return decodeXml(cdata ? cdata[1] : value.replace(/<[^>]*>/g, '')).trim();
}

function decodeXml(value) {
  return value.replace(/&(amp|lt|gt|quot|apos|#(\d+)|#x([\da-f]+));/gi, (entity, name, dec, hex) => {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (named[name.toLowerCase()]) return named[name.toLowerCase()];
    const point = Number.parseInt(dec || hex, hex ? 16 : 10);
    return Number.isInteger(point) && point >= 0 && point <= 0x10ffff
      ? String.fromCodePoint(point)
      : entity;
  });
}

export async function playerAchievements(apiKey, steamId, appid) {
  if (!apiKey) return null;
  // This app has a regular user Web API key, so it must use the public host.
  // Valve's reference pages print partner.steam-api.com, but that host rejects
  // user keys with 403 and is reserved for publisher keys.
  const url = 'https://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v1/'
    + `?key=${apiKey}&steamid=${steamId}&appid=${appid}&l=english`;
  const r = await steamFetch(url);
  if (!r) {
    return { available: false, retryable: true, reason: 'Steam could not be reached — try again later' };
  }
  const j = await r.json().catch(() => null);
  const stats = j?.playerstats;
  // Steam commonly uses HTTP 400 for a perfectly valid negative answer (private
  // game details, a game the account does not own, or an app with no stats).
  // Read the body before checking `ok`, or all of those collapse into the old and
  // misleading "Steam didn't answer" message.
  if (!r.ok) {
    if (r.status === 400) {
      return {
        available: false,
        retryable: false,
        reason: stats?.error || 'Steam has no public achievement data for this account and game',
      };
    }
    if (r.status === 401 || r.status === 403) {
      /* A valid user key can work for IPlayerService and still be refused by this
         ISteamUserStats method. Steam's public Community view carries the same
         per-game achievement state and privacy boundary, so use it only as a
         fallback rather than telling the user the whole site's key is invalid. */
      const fallback = await communityAchievements(steamId, appid);
      return fallback || {
        available: false,
        retryable: true,
        reason: 'Steam refused achievement access — try again later',
      };
    }
    if (r.status === 429) {
      return { available: false, retryable: true, reason: 'Steam is rate-limiting requests — try again later' };
    }
    return { available: false, retryable: true, reason: `Steam returned an error (${r.status})` };
  }
  if (!stats?.success || !Array.isArray(stats.achievements)) {
    return {
      available: false,
      retryable: false,
      reason: stats?.error || 'Achievements are private or unavailable for this game',
    };
  }
  return {
    available: true,
    gameName: stats.gameName || null,
    achievements: stats.achievements.map((achievement) => ({
      key: String(achievement.apiname || ''),
      name: String(achievement.name || achievement.apiname || 'Achievement').slice(0, 200),
      achieved: !!achievement.achieved,
      unlocktime: Number(achievement.unlocktime) || 0,
    })).filter((achievement) => achievement.key),
  };
}
