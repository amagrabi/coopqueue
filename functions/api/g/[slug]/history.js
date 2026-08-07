import { json, bad, body } from '../../../../lib/http.js';
import { buildHistoryItems, HISTORY_FIELDS } from '../../../../lib/history.js';

const ACTIONS = new Set(['accept', 'dismiss', 'snooze']);
const COLUMNS = { started: 'started', finished: 'finished', hours: 'hours' };
const SNOOZE_SECONDS = 7 * 24 * 60 * 60;

/** Everything here is group-scoped even where a game id or appid would be enough.
 * Both are global and guessable; neither is a tenancy boundary. */
async function historyData(db, gid, steamId) {
  const [games, achievements, nudges] = await Promise.all([
    db.prepare(
      `SELECT g.id, g.name, g.status, g.header_image, g.steam_appid, g.release_date,
              g.started, g.hours, g.hours_estimated, g.hours_participants,
              g.finished, g.finished_estimated, g.archived_at,
              r.score AS my_rating, p.minutes AS my_minutes,
              CASE WHEN g.added_by = ?2 THEN 1 ELSE 0 END AS i_added,
              COALESCE(s.not_played, 0) AS sat_out
         FROM games g
         LEFT JOIN ratings r
                ON r.game_id = g.id AND r.steam_id = ?2
         LEFT JOIN playtime p
                ON p.appid = g.steam_appid AND p.steam_id = ?2
         LEFT JOIN skips s
                ON s.game_id = g.id AND s.steam_id = ?2
        WHERE g.group_id = ?1 AND g.archived_at IS NULL AND g.status <> 'backlog'`
    ).bind(gid, steamId).all(),
    db.prepare(
      `WITH accounts(steam_id) AS (
         SELECT steam_id FROM memberships WHERE group_id = ?1 AND is_seed = 0
         UNION
         SELECT a.steam_id FROM seed_assignments a
           JOIN memberships m
             ON m.group_id = a.group_id AND m.steam_id = a.seed_steam_id
          WHERE a.group_id = ?1
       )
       SELECT p.appid, p.unlocked
         FROM achievement_progress p
         JOIN accounts a ON a.steam_id = p.steam_id
         JOIN games g ON g.steam_appid = p.appid AND g.group_id = ?1
        WHERE g.archived_at IS NULL`
    ).bind(gid).all(),
    db.prepare(
      `SELECT game_id, field, state, snoozed_until
         FROM history_nudges
        WHERE group_id = ? AND steam_id = ?`
    ).bind(gid, steamId).all(),
  ]);
  return {
    games: games.results || [],
    achievements: achievements.results || [],
    nudges: nudges.results || [],
  };
}

async function view(db, gid, steamId) {
  const data = await historyData(db, gid, steamId);
  const items = buildHistoryItems(data.games, data.achievements, data.nudges);
  return { total: items.length, items: items.slice(0, 20) };
}

export async function onRequestGet({ env, data }) {
  return json(await view(env.DB, data.group.group_id, data.user.steam_id));
}

export async function onRequestPost({ request, env, data }) {
  const input = await body(request);
  const gameId = Number(input.gameId);
  const field = String(input.field || '');
  const action = String(input.action || '');
  if (!Number.isInteger(gameId)) return bad('need a game id');
  if (!HISTORY_FIELDS.has(field)) return bad('field must be started, finished, or hours');
  if (!ACTIONS.has(action)) return bad('action must be accept, dismiss, or snooze');

  const gid = data.group.group_id;
  const steamId = data.user.steam_id;
  const exists = await env.DB.prepare(
    'SELECT 1 FROM games WHERE id = ? AND group_id = ?'
  ).bind(gameId, gid).first();
  if (!exists) return bad('no such game', 404);

  // Ignore an existing personal dismissal while validating the fact itself.
  // Otherwise a delayed double click on "later" turns into a misleading 409.
  const loaded = await historyData(env.DB, gid, steamId);
  const candidates = buildHistoryItems(loaded.games, loaded.achievements, []);
  const item = candidates.find((candidate) => candidate.gameId === gameId && candidate.field === field);
  if (!item) return bad('that history field is already filled or does not need a prompt', 409);

  if (action === 'dismiss' || action === 'snooze') {
    const until = action === 'snooze' ? Math.floor(Date.now() / 1000) + SNOOZE_SECONDS : null;
    await env.DB.prepare(
      `INSERT INTO history_nudges
         (group_id, game_id, field, steam_id, state, snoozed_until, updated_at)
       VALUES (?,?,?,?,?,?,unixepoch())
       ON CONFLICT(group_id, game_id, field, steam_id) DO UPDATE SET
         state = excluded.state, snoozed_until = excluded.snoozed_until,
         updated_at = unixepoch()`
    ).bind(gid, gameId, field, steamId,
           action === 'snooze' ? 'snoozed' : 'dismissed', until).run();
    return json({ ok: true, action });
  }

  if (!item.suggestion) return bad('there is no automatic suggestion for this field', 409);
  const column = COLUMNS[field];
  // D1 batches are transactional. Keeping the value, provenance and stale nudge
  // cleanup together prevents a suggestion from becoming an unexplained "manual"
  // fact if one statement fails.
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE games SET ${column} = ? WHERE id = ? AND group_id = ? AND ${column} IS NULL`
    ).bind(item.suggestion.value, gameId, gid),
    env.DB.prepare(
      `INSERT INTO game_fact_sources (group_id, game_id, field, source, set_by, updated_at)
       SELECT ?,?,?,?,?,unixepoch() WHERE changes() > 0
       ON CONFLICT(group_id, game_id, field) DO UPDATE SET
         source = excluded.source, set_by = excluded.set_by, updated_at = unixepoch()`
    ).bind(gid, gameId, field, item.suggestion.source, steamId),
    env.DB.prepare(
      `DELETE FROM history_nudges
        WHERE group_id = ? AND game_id = ? AND field = ? AND changes() > 0`
    ).bind(gid, gameId, field),
  ]);
  const changed = Number(results[0]?.meta?.changes ?? results[0]?.changes ?? 0);
  if (!changed) return bad('that history field was filled while you were answering', 409);

  return json({
    ok: true,
    action: 'accept',
    accepted: { gameId, field, value: item.suggestion.value, source: item.suggestion.source },
  });
}
