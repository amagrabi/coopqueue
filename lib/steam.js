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
const UA = { 'user-agent': 'g4m1ng (co-op game tracker)' };
const CACHE_TTL = 14 * 86400; // seconds — prices drift, nothing else really does

const https = (u) => (typeof u === 'string' ? u.replace(/^http:\/\//, 'https://') : null);
const stripTags = (s) => (typeof s === 'string' ? s.replace(/<[^>]*>/g, '').trim() : null);

/** Steam persona name + avatar for a SteamID64. */
export async function playerSummary(apiKey, steamId) {
  if (!apiKey) return null;
  const url = `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${apiKey}&steamids=${steamId}`;
  const r = await fetch(url, { headers: UA });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  const p = j?.response?.players?.[0];
  return p ? { displayName: p.personaname, avatar: https(p.avatarfull) } : null;
}

/** Store search by free text. Not cached — the query space is unbounded. */
export async function searchStore(term, cc = 'de') {
  const url = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(term)}&l=english&cc=${cc}`;
  const r = await fetch(url, { headers: UA });
  if (!r.ok) return [];
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
  const r = await fetch(url, { headers: UA });
  if (!r.ok) return null;
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
    trailer_url: https(movie?.mp4?.max || movie?.mp4?.['480'] || movie?.webm?.max) || null,
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
