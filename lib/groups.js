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
              g.blind_rating, COALESCE(w.mode, 'coop') AS workspace_mode,
              m.short_name, m.role, m.is_seed,
              COALESCE(p.history_prompts, 0) AS history_prompts
         FROM groups g
         LEFT JOIN workspace_settings w ON w.group_id = g.id
         JOIN memberships m ON m.group_id = g.id AND m.steam_id = ?
         LEFT JOIN member_preferences p
           ON p.group_id = m.group_id AND p.steam_id = m.steam_id
        WHERE g.slug = ?`
    )
    .bind(steamId, slug)
    .first();
  return row || null;
}

/** Pending invitations addressed to one signed-in account. */
export async function pendingInvites(db, steamId) {
  const result = await db.prepare(
    `SELECT i.id, g.name AS group_name, inviter.display_name AS inviter_name,
            inviter.avatar AS inviter_avatar, i.created_at
       FROM group_invites i
       JOIN groups g ON g.id = i.group_id
       LEFT JOIN workspace_settings w ON w.group_id = g.id
       JOIN users inviter ON inviter.steam_id = i.invited_by
      WHERE i.invited_steam_id = ? AND i.status = 'pending'
        AND COALESCE(w.mode, 'coop') = 'coop'
      ORDER BY i.created_at DESC, i.id DESC`
  ).bind(steamId).all();
  return (result.results || []).map((invite) => ({
    id: invite.id,
    groupName: invite.group_name,
    inviterName: invite.inviter_name || 'A player',
    inviterAvatar: invite.inviter_avatar || null,
    createdAt: invite.created_at,
  }));
}

/** Every group the caller belongs to, with a couple of numbers for the switcher. */
export async function myGroups(db, steamId) {
  const res = await db
    .prepare(
      `SELECT g.slug, g.name, m.role, m.short_name,
              COALESCE(w.mode, 'coop') AS mode,
              COALESCE(p.default_workspace, 0) AS is_default,
              (SELECT COUNT(*) FROM memberships mm WHERE mm.group_id = g.id) AS members,
              (SELECT COUNT(*) FROM games gg
                 WHERE gg.group_id = g.id AND gg.archived_at IS NULL)        AS games,
              (SELECT COUNT(*) FROM games gg
                 WHERE gg.group_id = g.id
                   AND gg.archived_at IS NULL
                   AND NOT EXISTS (SELECT 1 FROM ratings r WHERE r.game_id = gg.id AND r.steam_id = ?1)
                   AND NOT EXISTS (SELECT 1 FROM skips  s WHERE s.game_id = gg.id AND s.steam_id = ?1)
              ) AS unrated
         FROM groups g
         LEFT JOIN workspace_settings w ON w.group_id = g.id
         JOIN memberships m ON m.group_id = g.id
         LEFT JOIN member_preferences p
           ON p.group_id = m.group_id AND p.steam_id = m.steam_id
        WHERE m.steam_id = ?1
        ORDER BY g.name COLLATE NOCASE`
    )
    .bind(steamId)
    .all();
  return res.results || [];
}

/**
 * Hand a placeholder identity to a real Steam account: repoint every rating,
 * skip and added_by, adopt the placeholder's name and role, then delete it.
 *
 * Order matters and is the reason this is shared rather than duplicated. The
 * real membership row must already exist before ratings are repointed, or D1's
 * foreign keys fire — D1 enforces them even though SQLite does not by default.
 * Every caller must therefore create the membership first.
 *
 * Returns the adopted short name, or null when there is nothing to claim —
 * either the placeholder is gone, or the caller already has ratings here, and
 * merging two rating histories is never something to do implicitly.
 */
export async function claimSeedIdentity(db, gid, realSteamId, seedId) {
  if (!/^seed:\d+:[a-z0-9_-]+$/i.test(seedId || '')) return null;

  const seed = await db
    .prepare('SELECT steam_id, short_name, role FROM memberships WHERE group_id = ? AND steam_id = ? AND is_seed = 1')
    .bind(gid, seedId).first();
  if (!seed) return null;

  const mine = await db.prepare(
    `SELECT COUNT(*) AS n FROM ratings r JOIN games g ON g.id = r.game_id
      WHERE g.group_id = ? AND r.steam_id = ?`
  ).bind(gid, realSteamId).first();
  if ((mine?.n ?? 0) > 0) return null;

  await db.batch([
    db.prepare(
      `UPDATE ratings SET steam_id = ? WHERE steam_id = ?
         AND game_id IN (SELECT id FROM games WHERE group_id = ?)`
    ).bind(realSteamId, seedId, gid),
    db.prepare(
      `UPDATE skips SET steam_id = ? WHERE steam_id = ?
         AND game_id IN (SELECT id FROM games WHERE group_id = ?)`
    ).bind(realSteamId, seedId, gid),
    db.prepare('UPDATE games SET added_by = ? WHERE added_by = ? AND group_id = ?')
      .bind(realSteamId, seedId, gid),
    // Attendance somebody entered on the placeholder's behalf belongs to the person.
    // OR IGNORE: an answer the real account already gave for that date wins, and the
    // placeholder's copy then cascades away with its membership below.
    db.prepare('UPDATE OR IGNORE session_rsvps SET steam_id = ? WHERE group_id = ? AND steam_id = ?')
      .bind(realSteamId, gid, seedId),
    db.prepare('UPDATE member_away SET steam_id = ? WHERE group_id = ? AND steam_id = ?')
      .bind(realSteamId, gid, seedId),
    db.prepare('UPDATE OR IGNORE poll_votes SET steam_id = ? WHERE group_id = ? AND steam_id = ?')
      .bind(realSteamId, gid, seedId),
    db.prepare('UPDATE memberships SET short_name = ?, role = ? WHERE group_id = ? AND steam_id = ?')
      .bind(seed.short_name, seed.role, gid, realSteamId),
    db.prepare('DELETE FROM memberships WHERE group_id = ? AND steam_id = ?').bind(gid, seedId),
    // The placeholder user row is only ever used by this one group.
    db.prepare('DELETE FROM users WHERE steam_id = ?').bind(seedId),
  ]);

  return seed.short_name;
}

/**
 * Apply a pre-registered identity assignment, if one exists for this person in
 * this group. Lets an owner decide in advance that a given SteamID64 is "Leo",
 * so the friend never sees the "which one are you?" prompt.
 *
 * Safe to call on every group load: it is a no-op once the placeholder is gone.
 * The membership must already exist (see claimSeedIdentity).
 */
export async function applySeedAssignment(db, gid, realSteamId) {
  const row = await db
    .prepare('SELECT seed_steam_id FROM seed_assignments WHERE group_id = ? AND steam_id = ?')
    .bind(gid, realSteamId).first();
  if (!row) return null;
  return claimSeedIdentity(db, gid, realSteamId, row.seed_steam_id);
}
