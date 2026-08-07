import { json } from '../../lib/http.js';
import { myGroups } from '../../lib/groups.js';

export async function onRequestGet(context) {
  const { env, data } = context;
  const groups = await myGroups(env.DB, data.user.steam_id);
  // Presence is useful, but it is not part of this response. Sample it hourly and
  // keep the D1 write off the page-load path; Pages binds waitUntil to `context`.
  context.waitUntil(env.DB.prepare(
    `UPDATE users SET last_seen_at = unixepoch()
      WHERE steam_id = ? AND (last_seen_at IS NULL OR last_seen_at < unixepoch() - 3600)`
  ).bind(data.user.steam_id).run().catch((error) => {
    console.error(JSON.stringify({
      event: 'presence_update_failed', error: error instanceof Error ? error.message : String(error),
    }));
  }));

  return json({
    user: {
      steamId: data.user.steam_id,
      displayName: data.user.display_name,
      avatar: data.user.avatar,
    },
    groups,
  });
}
