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
  if (!live) return cached ? shape(cached) : null;

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
export async function ownedGames(apiKey, steamId) {
  if (!apiKey) return null;
  const url = 'https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/'
    + `?key=${apiKey}&steamid=${steamId}&include_played_free_games=1&format=json`;
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
    minutes: g.playtime_forever || 0,
    lastPlayed: g.rtime_last_played > 0 ? g.rtime_last_played : null,
  }));
}

/**
 * One member's achievement progress for one game.
 *
 * Deliberately one game at a time. Fetching every member × every library game
 * would turn one click into hundreds of Steam subrequests and make a private
 * profile indistinguishable from a half-finished bulk sync. The route caches this
 * result and lets each member refresh their own row from the game detail panel.
 */
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
      return { available: false, retryable: true, reason: 'Steam rejected the site’s API key' };
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
