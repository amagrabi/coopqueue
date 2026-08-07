import { json, bad, body } from '../../../../lib/http.js';
import { playerAchievements } from '../../../../lib/steam.js';

export async function onRequestGet({ request, env, data }) {
  const gameId = Number(new URL(request.url).searchParams.get('gameId'));
  if (!Number.isInteger(gameId)) return bad('need a game id');
  return achievementView(env.DB, data.group.group_id, gameId);
}

export async function onRequestPost({ request, env, data }) {
  if (!env.STEAM_API_KEY) return bad('STEAM_API_KEY is not configured', 500);
  const { gameId } = await body(request);
  const id = Number(gameId);
  if (!Number.isInteger(id)) return bad('need a game id');

  const game = await env.DB.prepare(
    'SELECT id, steam_appid FROM games WHERE id = ? AND group_id = ?'
  ).bind(id, data.group.group_id).first();
  if (!game) return bad('no such game', 404);
  if (!game.steam_appid) return bad('link this game to Steam first', 409);

  const result = await playerAchievements(env.STEAM_API_KEY, data.user.steam_id, game.steam_appid);
  if (result === null) return bad('Steam did not answer — try again later', 502);
  if (!result.available) return bad(result.reason, 409);

  const unlocked = result.achievements
    .filter((achievement) => achievement.achieved)
    .map(({ key, name, unlocktime }) => ({ key, name, unlocktime }));
  await env.DB.prepare(
    `INSERT INTO achievement_progress (steam_id, appid, achieved, total, unlocked, fetched_at)
     VALUES (?,?,?,?,?,unixepoch())
     ON CONFLICT(steam_id, appid) DO UPDATE SET
       achieved = excluded.achieved, total = excluded.total,
       unlocked = excluded.unlocked, fetched_at = unixepoch()`
  ).bind(
    data.user.steam_id, game.steam_appid, unlocked.length,
    result.achievements.length, JSON.stringify(unlocked)
  ).run();

  return achievementView(env.DB, data.group.group_id, id);
}

async function achievementView(db, groupId, gameId) {
  const game = await db.prepare(
    'SELECT id, steam_appid FROM games WHERE id = ? AND group_id = ?'
  ).bind(gameId, groupId).first();
  if (!game) return bad('no such game', 404);
  if (!game.steam_appid) return json({ supported: false, members: [] });

  const result = await db.prepare(
    `SELECT m.steam_id, m.short_name, m.is_seed,
            COALESCE(a.steam_id, m.steam_id) AS account,
            p.achieved, p.total, p.unlocked, p.fetched_at
       FROM memberships m
       LEFT JOIN seed_assignments a
              ON a.group_id = m.group_id AND a.seed_steam_id = m.steam_id
       LEFT JOIN achievement_progress p
              ON p.steam_id = COALESCE(a.steam_id, m.steam_id) AND p.appid = ?2
      WHERE m.group_id = ?1 ORDER BY m.short_name COLLATE NOCASE`
  ).bind(groupId, game.steam_appid).all();

  const members = (result.results || []).map((row) => {
    const unlocked = parseUnlocked(row.unlocked);
    return {
      steamId: row.steam_id,
      name: row.short_name,
      account: !(row.is_seed && row.account === row.steam_id),
      achieved: row.achieved ?? null,
      total: row.total ?? null,
      fetchedAt: row.fetched_at ?? null,
      unlocked,
    };
  });
  const eligible = members.filter((member) => member.account);
  const synced = eligible.filter((member) => member.total != null);
  const total = Math.max(0, ...synced.map((member) => member.total));
  const unlockedByKey = new Map();
  for (const member of synced) {
    for (const achievement of member.unlocked) {
      const entry = unlockedByKey.get(achievement.key) || {
        key: achievement.key, name: achievement.name, members: [], latest: 0,
      };
      entry.members.push(member.steamId);
      entry.latest = Math.max(entry.latest, achievement.unlocktime || 0);
      unlockedByKey.set(achievement.key, entry);
    }
  }

  const completeGroup = eligible.length >= 2 && synced.length === eligible.length;
  const unanimous = completeGroup
    ? [...unlockedByKey.values()].filter((achievement) => achievement.members.length === eligible.length).length
    : null;
  const nearSweep = completeGroup ? [...unlockedByKey.values()]
    .filter((achievement) => achievement.members.length === eligible.length - 1)
    .map((achievement) => ({
      name: achievement.name,
      missing: eligible.find((member) => !achievement.members.includes(member.steamId))?.name,
    })).slice(0, 3) : [];
  const latest = members.flatMap((member) => member.unlocked.map((achievement) => ({
    name: achievement.name,
    member: member.name,
    unlocktime: achievement.unlocktime,
  }))).filter((achievement) => achievement.unlocktime > 0)
    .sort((a, b) => b.unlocktime - a.unlocktime).slice(0, 3);

  return json({
    supported: total > 0,
    members: members.map(({ unlocked, ...member }) => member),
    relay: {
      unlocked: unlockedByKey.size,
      total,
      synced: synced.length,
      eligible: eligible.length,
      unanimous,
      nearSweep,
      latest,
    },
  });
}

function parseUnlocked(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}
