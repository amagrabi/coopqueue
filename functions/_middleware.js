import { readSession } from '../lib/auth.js';
import { json, RequestBodyError } from '../lib/http.js';

/** Endpoints reachable without a session. */
const PUBLIC = [/^\/api\/auth\//, /^\/api\/health$/];

/**
 * Root middleware: establishes *who* the caller is. It deliberately says
 * nothing about what they may see — that is the group middleware's job
 * (functions/api/g/[slug]/_middleware.js).
 */
export async function onRequest(context) {
  const started = Date.now();
  try {
    const response = await authenticatedRequest(context);
    const elapsed = Date.now() - started;
    if (elapsed >= 1000) {
      const url = new URL(context.request.url);
      console.warn(JSON.stringify({
        event: 'slow_request', method: context.request.method,
        path: url.pathname, status: response.status, elapsedMs: elapsed,
      }));
    }
    return response;
  } catch (error) {
    const url = new URL(context.request.url);
    console.error(JSON.stringify({
      event: 'request_error', method: context.request.method, path: url.pathname,
      error: error instanceof Error ? error.message : String(error),
    }));
    if (error instanceof RequestBodyError) return json({ error: error.message }, error.status);
    return json({ error: 'request failed' }, 500);
  }
}

async function authenticatedRequest(context) {
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

  const limit = rateLimitFor(request.method, pathname);
  if (limit) {
    const hit = await takeRateLimit(env.DB, `${steamId}:${limit.bucket}`, limit.windowSeconds);
    if (hit > limit.max) {
      const retry = limit.windowSeconds - (Math.floor(Date.now() / 1000) % limit.windowSeconds);
      return json({ error: 'too many requests — try again shortly' }, 429, {
        'retry-after': String(retry),
      });
    }
  }

  return next();
}

function rateLimitFor(method, pathname) {
  if (method === 'GET' && pathname === '/api/steam/search') {
    return { bucket: 'steam-search', max: 30, windowSeconds: 60 };
  }
  if (method === 'GET' && /^\/api\/g\/[^/]+\/invites$/.test(pathname)) {
    // Registered-account search is intentionally useful but must not become an
    // unbounded directory scraper. The owner sees at most twelve matches per
    // request and normal typeahead stays comfortably under this ceiling.
    return { bucket: 'account-search', max: 30, windowSeconds: 60 };
  }
  const expensive = (method === 'POST' && /\/(games|enrich|playtime|achievements|steam-import|achievement-scan)$/.test(pathname))
    || (method === 'PUT' && /\/games\/\d+$/.test(pathname));
  if (expensive) return { bucket: 'steam-write', max: 20, windowSeconds: 300 };
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    return { bucket: 'write', max: 60, windowSeconds: 60 };
  }
  return null;
}

/** Fixed-window, per-account limits. One row per account/category; no cleanup job. */
async function takeRateLimit(db, bucket, windowSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = Math.floor(now / windowSeconds) * windowSeconds;
  const row = await db.prepare(
    `INSERT INTO rate_limits (bucket, window_start, hits) VALUES (?, ?, 1)
     ON CONFLICT(bucket) DO UPDATE SET
       hits = CASE WHEN window_start = excluded.window_start THEN hits + 1 ELSE 1 END,
       window_start = excluded.window_start
     RETURNING hits`
  ).bind(bucket, windowStart).first();
  return row?.hits ?? 1;
}
