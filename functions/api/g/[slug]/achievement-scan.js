import { bad, body, json } from '../../../../lib/http.js';
import { playerAchievements } from '../../../../lib/steam.js';
import { completionEvidence } from '../../../../lib/completion.js';
import { achievementStartDate } from '../../../../lib/history.js';

const BATCH = 4;
const STALE_AFTER = 30 * 86400;

export async function onRequestPost({ request, env, data }) {
  if (data.group.workspace_mode !== 'personal') {
    return bad('Library achievement analysis is available in personal workspaces', 409);
  }
  if (!env.STEAM_API_KEY) return bad('STEAM_API_KEY is not configured', 500);
  const input = await body(request);
  const afterId = Math.max(0, Math.floor(Number(input.afterId) || 0));
  const cutoff = Math.floor(Date.now() / 1000) - STALE_AFTER;
  const gid = data.group.group_id;

  const pending = await env.DB.prepare(
    `SELECT g.id,g.name,g.steam_appid,g.status,g.started,g.finished,g.finished_estimated,
            g.release_date,p.fetched_at
       FROM games g
       LEFT JOIN achievement_progress p
         ON p.steam_id=?2 AND p.appid=g.steam_appid
      WHERE g.group_id=?1 AND g.archived_at IS NULL AND g.steam_appid IS NOT NULL
        AND g.status<>'backlog' AND g.id>?3 AND (p.fetched_at IS NULL OR p.fetched_at<?4)
      ORDER BY g.id LIMIT ?5`
  ).bind(gid, data.user.steam_id, afterId, cutoff, BATCH).all();

  const games = pending.results || [];
  const results = await Promise.all(games.map((game) =>
    playerAchievements(env.STEAM_API_KEY, data.user.steam_id, game.steam_appid)));
  const report = [];
  for (let i = 0; i < games.length; i++) {
    const game = games[i];
    const result = results[i];
    if (!result?.available) {
      if (result?.invalidateZero) {
        await env.DB.prepare(
          'DELETE FROM achievement_progress WHERE steam_id=? AND appid=? AND achieved=0'
        ).bind(data.user.steam_id, game.steam_appid).run();
      }
      report.push({ id: game.id, name: game.name, ok: false, reason: result?.reason || 'No achievement data' });
      continue;
    }
    const unlocked = result.achievements.filter((achievement) => achievement.achieved)
      .map(({ key, name, unlocktime }) => ({ key, name, unlocktime }));
    const approximateStart = game.started ? null : achievementStartDate(game, unlocked);
    const statements = [env.DB.prepare(
      `INSERT INTO achievement_progress (steam_id,appid,achieved,total,unlocked,fetched_at)
       VALUES (?,?,?,?,?,unixepoch())
       ON CONFLICT(steam_id,appid) DO UPDATE SET achieved=excluded.achieved,total=excluded.total,
         unlocked=excluded.unlocked,fetched_at=unixepoch()`
    ).bind(data.user.steam_id, game.steam_appid, unlocked.length,
      result.achievements.length, JSON.stringify(unlocked))];
    if (approximateStart) statements.push(
      env.DB.prepare(
        'UPDATE games SET started=? WHERE id=? AND group_id=? AND started IS NULL'
      ).bind(approximateStart, game.id, gid),
      // `changes()` refers to the preceding UPDATE inside this transactional D1
      // batch, so a concurrent/manual first-played value never gets approximate
      // provenance painted over it.
      env.DB.prepare(
        `INSERT INTO game_fact_sources (group_id,game_id,field,source,set_by,updated_at)
         SELECT ?,?,'started','achievement',?,unixepoch() WHERE changes()>0
         ON CONFLICT(group_id,game_id,field) DO UPDATE SET source='achievement',
           set_by=excluded.set_by,updated_at=unixepoch()`
      ).bind(gid, game.id, data.user.steam_id),
      env.DB.prepare(
        `DELETE FROM history_nudges
          WHERE group_id=? AND game_id=? AND field='started' AND changes()>0`
      ).bind(gid, game.id),
    );
    await env.DB.batch(statements);
    const evidence = game.status === 'sampled' ? completionEvidence(game.steam_appid, unlocked) : null;
    report.push({
      id: game.id, name: game.name, ok: true, achieved: unlocked.length,
      total: result.achievements.length, completion: evidence?.label || null,
      started: approximateStart,
    });
  }

  const nextCursor = games.at(-1)?.id || afterId;
  const more = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM games g
       LEFT JOIN achievement_progress p ON p.steam_id=?2 AND p.appid=g.steam_appid
      WHERE g.group_id=?1 AND g.archived_at IS NULL AND g.steam_appid IS NOT NULL
        AND g.status<>'backlog' AND g.id>?3 AND (p.fetched_at IS NULL OR p.fetched_at<?4)`
  ).bind(gid, data.user.steam_id, nextCursor, cutoff).first();

  return json({
    processed: games.length,
    synced: report.filter((item) => item.ok).length,
    report, nextCursor, hasMore: (more?.n ?? 0) > 0,
  });
}
