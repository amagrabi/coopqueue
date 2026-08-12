/**
 * Ownership inferred from the already-synced Steam library.
 *
 * `playtime` contains owned games, including never-launched games at 0 minutes.
 * Absence is only a trustworthy "not owned" when the member's public library was
 * synced after this group linked the game. An empty/private or older sync stays
 * unknown; presenting either as "doesn't own" would be a claim the data cannot
 * support.
 *
 * The same rows answer a second question for free: who has already PLAYED it.
 * That is the input to the replay question on the rating card, and asking Steam
 * beats asking the person — nobody should be typing in a fact the app already
 * synced. It is one-directional evidence only: minutes prove play, but hidden
 * playtime looks exactly like never having launched it (one member of group 1
 * returns 455 games with 0 minutes on every one), so an empty result is silence
 * rather than "they have not played it".
 */

/** An hour, the same floor lib/history.js uses before counting somebody as a
 *  participant. Below that is a look, not a play. */
const PLAYED_MINUTES = 60;
export async function ownershipForGames(db, groupId, games, knownMembers = null) {
  const members = knownMembers || (await db.prepare(
    `SELECT m.steam_id, m.short_name, m.is_seed,
            COALESCE(a.steam_id, m.steam_id) AS account,
            s.games AS synced_games, s.synced_at
       FROM memberships m
       LEFT JOIN seed_assignments a
              ON a.group_id = m.group_id AND a.seed_steam_id = m.steam_id
       LEFT JOIN group_library_sync s
              ON s.group_id = m.group_id AND s.steam_id = COALESCE(a.steam_id, m.steam_id)
      WHERE m.group_id = ? ORDER BY m.short_name COLLATE NOCASE`
  ).bind(groupId).all()).results || [];
  if (!games.length || !members.length) {
    return { members, byGame: new Map(), playedByGame: new Map() };
  }

  /* Only true rows travel out of SQLite. False/unknown are derived from the sync
     watermark below, so a 2,000-game × 64-member group does not materialise a
     cross product just to repeat nulls. */
  const ownedRes = await db.prepare(
    `WITH accounts(member_id, account) AS (
       SELECT m.steam_id, COALESCE(a.steam_id, m.steam_id)
         FROM memberships m
         LEFT JOIN seed_assignments a
                ON a.group_id = m.group_id AND a.seed_steam_id = m.steam_id
        WHERE m.group_id = ?1
     )
     SELECT g.id AS game_id, a.member_id, p.minutes
       FROM games g
       JOIN playtime p ON p.appid = g.steam_appid
       JOIN accounts a ON a.account = p.steam_id
      WHERE g.group_id = ?1`
  ).bind(groupId).all();

  const owned = new Map();
  const playedByGame = new Map();
  for (const row of ownedRes.results || []) {
    if (!owned.has(row.game_id)) owned.set(row.game_id, new Set());
    owned.get(row.game_id).add(row.member_id);
    if (Number(row.minutes) >= PLAYED_MINUTES) {
      if (!playedByGame.has(row.game_id)) playedByGame.set(row.game_id, []);
      playedByGame.get(row.game_id).push(row.member_id);
    }
  }

  const byGame = new Map();
  for (const game of games) {
    const trueFor = owned.get(game.id) || new Set();
    const linkedAt = game.enriched_at ?? game.created_at;
    const states = {};
    for (const member of members) {
      if (!game.steam_appid) {
        states[member.steam_id] = null;
      } else if (trueFor.has(member.steam_id)) {
        states[member.steam_id] = true;
      } else {
        const unresolvedSeed = !!member.is_seed && member.account === member.steam_id;
        const currentPublicSync = !unresolvedSeed && member.synced_games > 0
          && member.synced_at != null && linkedAt != null && member.synced_at >= linkedAt;
        states[member.steam_id] = currentPublicSync ? false : null;
      }
    }
    byGame.set(game.id, states);
  }

  return { members, byGame, playedByGame };
}
