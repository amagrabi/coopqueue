/**
 * Session handling. A session is a signed, expiring cookie — no session table,
 * so there is nothing to clean up and nothing extra to read on each request.
 * Token format:  <steamid>.<expiry-unix>.<base64url HMAC-SHA256>
 */
const COOKIE = 'g4_session';
const TTL_DAYS = 90;
const enc = new TextEncoder();

const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function hmac(secret, payload) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(payload)));
}

/** Constant-time-ish string compare, so a wrong signature leaks no timing signal. */
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function makeSessionCookie(steamId, secret) {
  const exp = Math.floor(Date.now() / 1000) + TTL_DAYS * 86400;
  const payload = `${steamId}.${exp}`;
  const token = `${payload}.${await hmac(secret, payload)}`;
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${TTL_DAYS * 86400}`;
}

export const clearSessionCookie = () =>
  `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

/** Returns the SteamID64 from a valid, unexpired cookie, else null. */
export async function readSession(request, secret) {
  const raw = request.headers.get('cookie') || '';
  const hit = raw.split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`));
  if (!hit) return null;
  const [steamId, exp, sig] = hit.slice(COOKIE.length + 1).split('.');
  if (!steamId || !exp || !sig) return null;
  if (Number(exp) * 1000 < Date.now()) return null;
  const expected = await hmac(secret, `${steamId}.${exp}`);
  return safeEqual(sig, expected) ? steamId : null;
}

/**
 * Optional signup gate for a private or closed-beta instance. Set
 * ALLOWED_STEAM_IDS to a comma-separated list of SteamID64s and only those
 * accounts can sign in at all. Leave it unset for a public site — access to
 * any actual data is controlled per group by membership, not by this list.
 */
export function allowlist(env) {
  return (env.ALLOWED_STEAM_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function isAllowed(env, steamId) {
  const list = allowlist(env);
  return list.length === 0 || list.includes(steamId);
}
