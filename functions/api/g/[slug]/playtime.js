import { json, bad } from '../../../../lib/http.js';
import { ownedGames } from '../../../../lib/steam.js';

/**
 * Group co-op hours, estimated from each member's Steam playtime.
 *
 * The honest framing first: Steam exposes lifetime minutes per person per game and
 * nothing about *when* or *with whom*. There is no session or concurrency data in
 * the public API, so time-played-together cannot be measured. What can be computed
 * is an upper bound — you cannot all have played together for longer than whoever
 * played least — and that is what this stores, labelled as an estimate.
 *
 * estimate = min(minutes) over members who actually played it, 0 below two of them.
 *
 * That single rule covers the three cases the group asked about:
 *   - one person plays Rocket League alone -> one participant -> 0
 *   - co-op Elden Ring plus somebody's solo hours -> the solo overflow sits above
 *     the minimum and cannot inflate it
 *   - three of four played -> the fourth is not a participant, so their zero
 *     cannot drag the number down
 *
 * `games.hours` — a number a human typed — always wins. The estimate is only ever
 * shown in its absence.
 */

/** Below this, "playing" is a launch and a look around rather than a session. */
const PARTICIPANT_MINUTES = 60;

export async function onRequestGet({ env, data }) {
  const gid = data.group.group_id;
  /* Report on the account we would actually read. For a placeholder member that is
     whatever SteamID64 the owner pre-assigned to it — reporting on the placeholder
     would say "no Steam account yet" about somebody whose real problem is hidden
     playtime, and that is the one thing here a person can act on. */
  const rows = await env.DB.prepare(
    `SELECT m.steam_id, m.short_name, m.is_seed,
            COALESCE(a.steam_id, m.steam_id) AS account,
            s.games, s.played, s.synced_at
       FROM memberships m
       LEFT JOIN seed_assignments a
              ON a.group_id = m.group_id AND a.seed_steam_id = m.steam_id
       LEFT JOIN playtime_sync s ON s.steam_id = COALESCE(a.steam_id, m.steam_id)
      WHERE m.group_id = ? ORDER BY m.short_name COLLATE NOCASE`
  ).bind(gid).all();

  return json({
    members: (rows.results || []).map((m) => ({
      steamId: m.steam_id,
      name: m.short_name,
      // Only a placeholder with no assignment truly has no account to read.
      seed: !!m.is_seed && m.account === m.steam_id,
      syncedAt: m.synced_at ?? null,
      owned: m.games ?? null,
      played: m.played ?? null,
      /* Two different privacy switches, so two different failures. An empty list
         means "Game details" is not public. A full list with no minutes anywhere
         means the separate "always keep my total playtime private" checkbox is
         set — measured on this group: 455 games, 0 minutes on every one. Only
         `played` tells us the sync actually learned something. */
      readable: (!!m.is_seed && m.account === m.steam_id) ? null : (m.played ?? 0) > 0,
      reason: (!!m.is_seed && m.account === m.steam_id) || (m.played ?? 0) > 0 ? null
        : (m.games ?? 0) > 0
          ? 'playtime hidden — untick "Always keep my total playtime private" in Steam privacy'
          : 'game library hidden — set Steam → Privacy → Game details to Public',
    })),
  });
}

export async function onRequestPost({ env, data }) {
  if (!env.STEAM_API_KEY) return bad('STEAM_API_KEY is not configured', 500);
  const gid = data.group.group_id;

  // Placeholder identities are skipped: 'seed:1:leo' is not a SteamID64 and asking
  // Steam about it just wastes a call.
  const members = await env.DB.prepare(
    `SELECT steam_id, short_name FROM memberships
      WHERE group_id = ?1 AND is_seed = 0 AND steam_id NOT LIKE 'seed:%'
     UNION
     SELECT a.steam_id, m.short_name FROM seed_assignments a
       JOIN memberships m ON m.group_id = a.group_id AND m.steam_id = a.seed_steam_id
      WHERE a.group_id = ?1`
  ).bind(gid).all();

  const report = [];
  for (const m of members.results || []) {
    const owned = await ownedGames(env.STEAM_API_KEY, m.steam_id);
    if (owned === null) {
      report.push({ name: m.short_name, steamId: m.steam_id, ok: false, reason: 'Steam API error' });
      continue;
    }

    // Only games this group actually has are stored. A member's full library can
    // run to hundreds of titles and none of the rest can affect any estimate here.
    const mine = await env.DB.prepare(
      'SELECT steam_appid FROM games WHERE group_id = ? AND steam_appid IS NOT NULL').bind(gid).all();
    const wanted = new Set((mine.results || []).map((g) => g.steam_appid));
    const keep = owned.filter((g) => wanted.has(g.appid));

    if (keep.length) {
      // Chunked: D1 caps how many statements one batch may carry, and a 400-game
      // library would otherwise build a batch big enough to be rejected.
      for (let i = 0; i < keep.length; i += 50) {
        await env.DB.batch(keep.slice(i, i + 50).map((g) => env.DB.prepare(
          `INSERT INTO playtime (steam_id, appid, minutes, fetched_at)
           VALUES (?,?,?,unixepoch())
           ON CONFLICT(steam_id, appid) DO UPDATE SET
             minutes = excluded.minutes, fetched_at = unixepoch()`
        ).bind(m.steam_id, g.appid, g.minutes)));
      }
    }

    const played = owned.filter((g) => g.minutes > 0).length;
    await env.DB.prepare(
      `INSERT INTO playtime_sync (steam_id, games, played, synced_at) VALUES (?,?,?,unixepoch())
       ON CONFLICT(steam_id) DO UPDATE SET
         games = excluded.games, played = excluded.played, synced_at = unixepoch()`
    ).bind(m.steam_id, owned.length, played).run();

    report.push({
      name: m.short_name, steamId: m.steam_id,
      ok: played > 0, owned: owned.length, played, matched: keep.length,
      reason: played > 0 ? null
        : owned.length > 0
          ? 'playtime hidden (untick "Always keep my total playtime private")'
          : 'library hidden (Steam → Privacy → Game details → Public)',
    });
  }

  const updated = await recomputeEstimates(env, gid);
  return json({ ok: true, members: report, gamesEstimated: updated });
}

/**
 * Recompute every estimate in the group from whatever playtime we hold.
 *
 * Deliberately tolerant of partial data — the group asked for it to work with
 * "whatever we have". Two members synced is enough to produce a number; the
 * participant count travels with it so a 2-of-4 estimate is visibly weaker than a
 * 4-of-4 one rather than silently equal to it.
 */
export async function recomputeEstimates(env, gid) {
  /* A member's Steam account is usually their membership row, but not always: a
     seeded group starts with placeholders like 'seed:1:leo' that own no playtime.
     Where the owner has pre-assigned a real SteamID64 to a placeholder we already
     know whose account it is, so resolve through seed_assignments too. Without
     this, a group that has imported its history but whose friends have not signed
     in yet sees one participant everywhere and therefore zero hours for every
     game — technically correct and completely useless. */
  const rows = await env.DB.prepare(
    `WITH accounts(steam_id) AS (
        SELECT steam_id FROM memberships WHERE group_id = ?1 AND is_seed = 0
        UNION
        SELECT a.steam_id FROM seed_assignments a
          JOIN memberships m ON m.group_id = a.group_id AND m.steam_id = a.seed_steam_id
         WHERE a.group_id = ?1
     )
     SELECT g.id, p.minutes
       FROM games g
       JOIN accounts acc
       JOIN playtime p ON p.steam_id = acc.steam_id AND p.appid = g.steam_appid
      WHERE g.group_id = ?1 AND g.steam_appid IS NOT NULL AND p.minutes >= ?2`
  ).bind(gid, PARTICIPANT_MINUTES).all();

  const byGame = new Map();
  for (const r of rows.results || []) {
    if (!byGame.has(r.id)) byGame.set(r.id, []);
    byGame.get(r.id).push(r.minutes);
  }

  const stmts = [];
  for (const [id, mins] of byGame) {
    // Fewer than two participants is not co-op, whatever the hours say.
    const hours = mins.length >= 2 ? Math.round((Math.min(...mins) / 60) * 10) / 10 : 0;
    stmts.push(env.DB.prepare(
      'UPDATE games SET hours_estimated = ?, hours_participants = ? WHERE id = ? AND group_id = ?'
    ).bind(hours, mins.length, id, gid));
  }
  // Games nobody qualifying played get an explicit 0 rather than a stale number.
  stmts.push(env.DB.prepare(
    `UPDATE games SET hours_estimated = 0, hours_participants = 0
      WHERE group_id = ?1 AND steam_appid IS NOT NULL
        AND id NOT IN (
          WITH accounts(steam_id) AS (
            SELECT steam_id FROM memberships WHERE group_id = ?1 AND is_seed = 0
            UNION
            SELECT a.steam_id FROM seed_assignments a
              JOIN memberships m ON m.group_id = a.group_id AND m.steam_id = a.seed_steam_id
             WHERE a.group_id = ?1
          )
          SELECT g.id FROM games g
            JOIN accounts acc
            JOIN playtime p ON p.steam_id = acc.steam_id AND p.appid = g.steam_appid
           WHERE g.group_id = ?1 AND p.minutes >= ?2)`
  ).bind(gid, PARTICIPANT_MINUTES));

  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  return byGame.size;
}
