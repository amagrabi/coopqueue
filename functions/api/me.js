import { json } from '../../lib/http.js';
import { myGroups } from '../../lib/groups.js';

export async function onRequestGet({ env, data }) {
  const groups = await myGroups(env.DB, data.user.steam_id);
  // Cheap presence tracking; also tells you whether an invite ever got used.
  await env.DB.prepare('UPDATE users SET last_seen_at = unixepoch() WHERE steam_id = ?')
    .bind(data.user.steam_id)
    .run();

  return json({
    user: {
      steamId: data.user.steam_id,
      displayName: data.user.display_name,
      avatar: data.user.avatar,
    },
    groups,
  });
}
