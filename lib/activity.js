// Group-scoped at every join, even though event and game ids are globally unique.
// No score, rating comment, replay answer or comment body ever enters this feed.
export async function activityFeed(db, groupId, steamId) {
  const head = await db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM group_activity WHERE group_id=?')
    .bind(groupId).first();
  const latestId = head.id;
  const result = await db.prepare(
    `WITH grouped AS (
       SELECT MIN(a.id) AS first_id, MAX(a.id) AS id, a.actor_id, a.kind,
              COUNT(DISTINCT a.game_id) AS game_count, COUNT(*) AS actions,
              MAX(a.created_at) AS created_at,
              MAX(a.id > COALESCE(r.last_read_id,0)) AS unread
         FROM group_activity a
         JOIN games g ON g.id=a.game_id AND g.group_id=a.group_id
         LEFT JOIN activity_reads r ON r.group_id=a.group_id AND r.steam_id=?2
        WHERE a.group_id=?1 AND a.actor_id IS NOT ?2 AND a.id<=?3
          AND a.created_at >= unixepoch()-7776000
        GROUP BY a.actor_id, a.kind, a.created_at/600,
                 CASE WHEN a.kind IN ('rating','game_added') THEN 0 ELSE a.game_id END
     )
     SELECT b.*, first.from_status, last.to_status, g.id AS game_id, g.name AS game_name,
            COALESCE(m.short_name,u.display_name,'Former member') AS actor_name,
            SUM(b.unread) OVER () AS unread_count
       FROM grouped b
       JOIN group_activity first ON first.id=b.first_id AND first.group_id=?1
       JOIN group_activity last ON last.id=b.id AND last.group_id=?1
       JOIN games g ON g.id=last.game_id AND g.group_id=?1
       LEFT JOIN memberships m ON m.group_id=?1 AND m.steam_id=b.actor_id
       LEFT JOIN users u ON u.steam_id=b.actor_id
      ORDER BY b.id DESC LIMIT 40`
  ).bind(groupId, steamId, latestId).all();
  const rows = result.results || [];
  return {
    latestId,
    unreadCount: rows[0]?.unread_count || 0,
    items: rows.map((row) => ({
      id: row.id, kind: row.kind, actor: row.actor_name,
      gameId: row.game_id, gameName: row.game_name, gameCount: row.game_count,
      actions: row.actions, fromStatus: row.from_status, toStatus: row.to_status,
      createdAt: row.created_at, unread: !!row.unread,
    })),
  };
}

export async function markActivityRead(db, groupId, steamId, throughId) {
  // The supplied snapshot must belong to this group. Never acknowledge events
  // arriving after that snapshot, and never move backwards from another device.
  if (throughId !== 0 && !await db.prepare('SELECT 1 FROM group_activity WHERE group_id=? AND id=?')
    .bind(groupId, throughId).first()) return false;
  await db.prepare(
    `INSERT INTO activity_reads (group_id,steam_id,last_read_id) VALUES (?,?,?)
     ON CONFLICT(group_id,steam_id) DO UPDATE SET
       last_read_id=MAX(activity_reads.last_read_id,excluded.last_read_id)`
  ).bind(groupId, steamId, throughId).run();
  return true;
}

// The actor is known to the PATCH handler, unlike a database status trigger.
// Put this BEFORE the status UPDATE in the same D1 batch, so from_status is the
// actual old value and a failed update cannot leave behind a false notification.
export function statusActivity(db, groupId, steamId, gameId, nextStatus) {
  return db.prepare(
    `INSERT INTO group_activity (group_id,actor_id,game_id,kind,from_status,to_status)
     SELECT g.group_id,?,g.id,'status_changed',g.status,? FROM games g
     JOIN memberships m ON m.group_id=g.group_id AND m.steam_id=? AND m.is_seed=0
     WHERE g.id=? AND g.group_id=? AND g.status<>?
       AND NOT EXISTS (SELECT 1 FROM workspace_settings w WHERE w.group_id=g.group_id AND w.mode='personal')`
  ).bind(steamId, nextStatus, steamId, gameId, groupId, nextStatus);
}
