/** Group helpers: slugs, invite codes, and the membership lookup every
 *  group-scoped route depends on. */

const RESERVED = new Set([
  'api', 'admin', 'new', 'join', 'about', 'login', 'logout', 'settings',
  'help', 'terms', 'privacy', 'static', 'assets', 'public', 'www',
]);

/** URL-safe slug from a group name; falls back to 'group' if nothing survives. */
export function slugify(name) {
  const base = String(name || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return base || 'group';
}

/** Find a free slug, suffixing -2, -3, … on collision or a reserved word. */
export async function uniqueSlug(db, name) {
  const base = slugify(name);
  for (let i = 1; i <= 50; i++) {
    const candidate = i === 1 ? base : `${base}-${i}`;
    if (RESERVED.has(candidate)) continue;
    const hit = await db.prepare('SELECT 1 FROM groups WHERE slug = ?').bind(candidate).first();
    if (!hit) return candidate;
  }
  // Give up guessing politely and use something that cannot collide.
  return `${base}-${randomToken(6).toLowerCase()}`;
}

/** Unambiguous alphabet — no O/0, I/1, so codes survive being read aloud. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function randomToken(len = 10) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join('');
}

/** The caller's membership of a group, or null. Also returns the group row. */
export async function membership(db, slug, steamId) {
  const row = await db
    .prepare(
      `SELECT g.id AS group_id, g.slug, g.name, g.invite_code, g.max_players, g.created_by,
              m.short_name, m.role, m.is_seed
         FROM groups g
         JOIN memberships m ON m.group_id = g.id AND m.steam_id = ?
        WHERE g.slug = ?`
    )
    .bind(steamId, slug)
    .first();
  return row || null;
}

/** Every group the caller belongs to, with a couple of numbers for the switcher. */
export async function myGroups(db, steamId) {
  const res = await db
    .prepare(
      `SELECT g.slug, g.name, m.role, m.short_name,
              (SELECT COUNT(*) FROM memberships mm WHERE mm.group_id = g.id) AS members,
              (SELECT COUNT(*) FROM games gg WHERE gg.group_id = g.id)       AS games,
              (SELECT COUNT(*) FROM games gg
                 WHERE gg.group_id = g.id
                   AND NOT EXISTS (SELECT 1 FROM ratings r WHERE r.game_id = gg.id AND r.steam_id = ?1)
                   AND NOT EXISTS (SELECT 1 FROM skips  s WHERE s.game_id = gg.id AND s.steam_id = ?1)
              ) AS unrated
         FROM groups g
         JOIN memberships m ON m.group_id = g.id
        WHERE m.steam_id = ?1
        ORDER BY g.name COLLATE NOCASE`
    )
    .bind(steamId)
    .all();
  return res.results || [];
}
