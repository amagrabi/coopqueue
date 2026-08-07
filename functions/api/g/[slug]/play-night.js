import { json, bad, body } from '../../../../lib/http.js';
import { ownershipForGames } from '../../../../lib/ownership.js';
import { viability } from '../../../../lib/score.js';

/**
 * Build a shortlist for one actual session, not the group's usual headcount.
 *
 * Player cap and minimum useful session length are both hard gates: unknown is
 * excluded rather than treated as a fit. The score is the plain mean of only the
 * attendees' ratings, preserving the product's deliberately uncalibrated model.
 */
export async function onRequestPost({ request, env, data }) {
  const input = await body(request);
  const attendees = Array.isArray(input.attendees) ? input.attendees.map(String) : [];
  const unique = [...new Set(attendees)];
  const minutes = Number(input.minutes);
  const requireOwnership = !!input.requireOwnership;
  const excludeEarlyAccess = input.excludeEarlyAccess !== false;

  if (unique.length !== attendees.length) return bad('each attendee can only be selected once');
  if (unique.length < 2 || unique.length > 64) return bad('select 2–64 attendees');
  if (!Number.isInteger(minutes) || minutes < 30 || minutes > 720) {
    return bad('available time must be a whole number from 30 to 720 minutes');
  }

  const gid = data.group.group_id;
  const [gamesRes, membersRes] = await Promise.all([
    env.DB.prepare(
      `SELECT g.*, CASE WHEN c.tags LIKE '%"Early Access"%' THEN 1 ELSE 0 END AS early_access
         FROM games g LEFT JOIN coop_apps c ON c.appid = g.steam_appid
        WHERE g.group_id = ? AND g.archived_at IS NULL AND g.status = 'backlog'`
    ).bind(gid).all(),
    env.DB.prepare(
      `SELECT m.steam_id, m.short_name, m.is_seed,
              COALESCE(a.steam_id, m.steam_id) AS account,
              s.games AS synced_games, s.synced_at
         FROM memberships m
         LEFT JOIN seed_assignments a
                ON a.group_id = m.group_id AND a.seed_steam_id = m.steam_id
         LEFT JOIN group_library_sync s
                ON s.group_id = m.group_id AND s.steam_id = COALESCE(a.steam_id, m.steam_id)
        WHERE m.group_id = ? ORDER BY m.short_name COLLATE NOCASE`
    ).bind(gid).all(),
  ]);
  const games = gamesRes.results || [];
  const members = membersRes.results || [];
  const memberIds = new Set(members.map((member) => member.steam_id));
  if (unique.some((steamId) => !memberIds.has(steamId))) return bad('every attendee must belong to this group');

  const marks = unique.map(() => '?').join(',');
  const [ratingsRes, ownership] = await Promise.all([
    env.DB.prepare(
      `SELECT r.game_id, r.steam_id, r.score FROM ratings r
         JOIN games g ON g.id = r.game_id
        WHERE g.group_id = ? AND r.steam_id IN (${marks})`
    ).bind(gid, ...unique).all(),
    requireOwnership
      ? ownershipForGames(env.DB, gid, games, members)
      : Promise.resolve({ byGame: new Map() }),
  ]);

  const ratings = new Map();
  for (const rating of ratingsRes.results || []) {
    if (!ratings.has(rating.game_id)) ratings.set(rating.game_id, []);
    ratings.get(rating.game_id).push(rating);
  }

  const excluded = {
    earlyAccess: 0,
    playerCountUnknown: 0,
    tooFewPlayers: 0,
    sessionLengthUnknown: 0,
    tooLong: 0,
    noAttendeeRatings: 0,
    ownershipUnknown: 0,
    notOwnedByEveryone: 0,
  };
  const shortlist = [];
  for (const game of games) {
    if (excludeEarlyAccess && game.early_access) { excluded.earlyAccess++; continue; }
    const fit = viability(game, unique.length);
    if (fit.ok == null) { excluded.playerCountUnknown++; continue; }
    if (fit.ok === false) { excluded.tooFewPlayers++; continue; }
    if (game.min_session_minutes == null) { excluded.sessionLengthUnknown++; continue; }
    if (game.min_session_minutes > minutes) { excluded.tooLong++; continue; }

    const votes = ratings.get(game.id) || [];
    if (!votes.length) { excluded.noAttendeeRatings++; continue; }

    const ownershipStates = requireOwnership ? ownership.byGame.get(game.id) || {} : {};
    if (requireOwnership) {
      const selectedStates = unique.map((steamId) => ownershipStates[steamId]);
      if (selectedStates.some((state) => state == null)) { excluded.ownershipUnknown++; continue; }
      if (selectedStates.some((state) => state === false)) { excluded.notOwnedByEveryone++; continue; }
    }

    const score = votes.reduce((sum, vote) => sum + vote.score, 0) / votes.length;
    shortlist.push({
      id: game.id,
      score: Math.round(score * 100) / 100,
      votes: votes.length,
      minSessionMinutes: game.min_session_minutes,
      ownership: ownershipStates,
      workaround: fit.ok === 'workaround',
    });
  }

  const names = new Map(games.map((game) => [game.id, game.name]));
  shortlist.sort((a, b) => b.score - a.score || b.votes - a.votes
    || String(names.get(a.id)).localeCompare(String(names.get(b.id))));

  return json({
    games: shortlist.slice(0, 30),
    attendees: unique,
    minutes,
    requireOwnership,
    excluded,
  });
}
