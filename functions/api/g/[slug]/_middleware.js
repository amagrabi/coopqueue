import { json } from '../../../../lib/http.js';
import { membership } from '../../../../lib/groups.js';

/**
 * The tenancy boundary. Every route below this point can assume
 * `data.group` exists and that the caller is a member of it — and every query
 * they write must still filter on `data.group.group_id`, because a game id is
 * globally unique and guessable.
 *
 * A non-member gets 404 rather than 403 so the existence of a private group
 * cannot be probed by URL.
 */
export async function onRequest(context) {
  const { env, params, data, next } = context;
  const slug = String(params.slug || '').toLowerCase();

  const group = await membership(env.DB, slug, data.user.steam_id);
  if (!group) return json({ error: 'no such group' }, 404);

  data.group = group;
  return next();
}
