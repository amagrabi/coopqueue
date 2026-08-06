import { readSession } from '../lib/auth.js';
import { json } from '../lib/http.js';

/** Endpoints reachable without a session. */
const PUBLIC = [/^\/api\/auth\//, /^\/api\/health$/];

/**
 * Root middleware: establishes *who* the caller is. It deliberately says
 * nothing about what they may see — that is the group middleware's job
 * (functions/api/g/[slug]/_middleware.js).
 */
export async function onRequest(context) {
  const { request, env, next } = context;
  const { pathname } = new URL(request.url);

  if (!pathname.startsWith('/api/')) return next();

  if (!env.SESSION_SECRET) {
    return json({ error: 'SESSION_SECRET is not configured. See README step 4.' }, 500);
  }
  if (!env.DB) {
    return json({ error: 'D1 binding "DB" is missing. See README step 2.' }, 500);
  }

  const steamId = await readSession(request, env.SESSION_SECRET);
  context.data.steamId = steamId;

  if (PUBLIC.some((re) => re.test(pathname))) return next();
  if (!steamId) return json({ error: 'not signed in' }, 401);

  const user = await env.DB.prepare('SELECT * FROM users WHERE steam_id = ?').bind(steamId).first();
  if (!user) return json({ error: 'unknown user' }, 401);
  context.data.user = user;

  return next();
}
