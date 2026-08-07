import { json, bad, body } from '../../../../lib/http.js';
import { viability } from '../../../../lib/score.js';

/**
 * Rank the backlog for the people who are actually playing.
 *
 * A verified cap below the selected headcount is a hard exclusion. Unknown caps
 * stay visible as unknown rather than emptying a list whose catalogue coverage is
 * still incomplete. The score is the plain mean of only the selected members'
 * ratings, preserving the deliberately uncalibrated model.
 */
export async function onRequestPost({ request, env, data }) {
  const input = await body(request);
  const attendees = Array.isArray(input.attendees) ? input.attendees.map(String) : [];
  const unique = [...new Set(attendees)];
  const excludeEarlyAccess = input.excludeEarlyAccess !== false;

  if (unique.length !== attendees.length) return bad('each attendee can only be selected once');
  if (unique.length < 1 || unique.length > 64) return bad('select 1–64 players');

  const gid = data.group.group_id;
  const [gamesRes, membersRes] = await Promise.all([
    env.DB.prepare(
      `SELECT g.*, CASE WHEN c.tags LIKE '%"Early Access"%' THEN 1 ELSE 0 END AS early_access
         FROM games g LEFT JOIN coop_apps c ON c.appid = g.steam_appid
        WHERE g.group_id = ? AND g.archived_at IS NULL AND g.status = 'backlog'`
    ).bind(gid).all(),
    env.DB.prepare(
      `SELECT m.steam_id, m.short_name
         FROM memberships m
        WHERE m.group_id = ? ORDER BY m.short_name COLLATE NOCASE`
    ).bind(gid).all(),
  ]);
  const games = gamesRes.results || [];
  const members = membersRes.results || [];
  const memberIds = new Set(members.map((member) => member.steam_id));
  if (unique.some((steamId) => !memberIds.has(steamId))) return bad('every attendee must belong to this group');

  const marks = unique.map(() => '?').join(',');
  const ratingsRes = await env.DB.prepare(
    `SELECT r.game_id, r.steam_id, r.score FROM ratings r
       JOIN games g ON g.id = r.game_id
      WHERE g.group_id = ? AND r.steam_id IN (${marks})`
  ).bind(gid, ...unique).all();

  const ratings = new Map();
  for (const rating of ratingsRes.results || []) {
    if (!ratings.has(rating.game_id)) ratings.set(rating.game_id, []);
    ratings.get(rating.game_id).push(rating);
  }

  const excluded = {
    earlyAccess: 0,
    tooFewPlayers: 0,
    noAttendeeRatings: 0,
  };
  const shortlist = [];
  for (const game of games) {
    if (excludeEarlyAccess && game.early_access) { excluded.earlyAccess++; continue; }
    const fit = viability(game, unique.length);
    if (fit.ok === false) { excluded.tooFewPlayers++; continue; }

    const votes = ratings.get(game.id) || [];
    if (!votes.length) { excluded.noAttendeeRatings++; continue; }

    const score = votes.reduce((sum, vote) => sum + vote.score, 0) / votes.length;
    shortlist.push({
      id: game.id,
      score: Math.round(score * 100) / 100,
      votes: votes.length,
      playerCountVerified: fit.ok != null,
      workaround: fit.ok === 'workaround',
    });
  }

  const names = new Map(games.map((game) => [game.id, game.name]));
  shortlist.sort((a, b) => b.score - a.score || b.votes - a.votes
    || String(names.get(a.id)).localeCompare(String(names.get(b.id))));

  return json({
    games: shortlist.slice(0, 30),
    attendees: unique,
    excluded,
  });
}
