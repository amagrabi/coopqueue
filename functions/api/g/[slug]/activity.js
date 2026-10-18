import { json, bad, body } from '../../../../lib/http.js';
import { activityFeed, markActivityRead, markActivityItemRead } from '../../../../lib/activity.js';

export async function onRequestGet({ env, data }) {
  return json(await activityFeed(env.DB, data.group.group_id, data.user.steam_id));
}

export async function onRequestPost({ request, env, data }) {
  const { throughId, itemId } = await body(request);
  if (itemId !== undefined) {
    if (throughId !== undefined || !Number.isSafeInteger(itemId) || itemId <= 0) return bad('invalid activity item');
    if (!await markActivityItemRead(env.DB, data.group.group_id, data.user.steam_id, itemId)) {
      return bad('no such activity item', 404);
    }
    return json({ ok: true });
  }
  if (!Number.isSafeInteger(throughId) || throughId < 0) return bad('invalid activity snapshot');
  if (!await markActivityRead(env.DB, data.group.group_id, data.user.steam_id, throughId)) {
    return bad('no such activity snapshot', 404);
  }
  return json({ ok: true });
}
