import { redirect } from '../../../lib/http.js';
import { makeSessionCookie, isAllowed } from '../../../lib/auth.js';
import { playerSummary } from '../../../lib/steam.js';

/**
 * Steam bounces the user back here. We hand every openid.* parameter straight
 * back to Steam with mode=check_authentication; only Steam can tell us whether
 * it really signed them, so nothing here is trusted until that returns true.
 */
export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const params = new URLSearchParams(url.search);

  if (params.get('openid.mode') !== 'id_res') return redirect('/?error=cancelled');

  params.set('openid.mode', 'check_authentication');
  const verify = await fetch('https://steamcommunity.com/openid/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: params,
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!verify?.ok) return redirect('/?error=steam_unavailable');
  const text = await verify.text();
  if (!/is_valid\s*:\s*true/i.test(text)) return redirect('/?error=steam_rejected');

  const claimed = url.searchParams.get('openid.claimed_id') || '';
  const steamId = claimed.match(/\/openid\/id\/(\d{17})\/?$/)?.[1];
  if (!steamId) return redirect('/?error=no_steamid');

  if (!isAllowed(env, steamId)) return redirect(`/?error=not_allowed&id=${steamId}`);

  const profile = await playerSummary(env.STEAM_API_KEY, steamId);
  const name = profile?.displayName || `Player ${steamId.slice(-4)}`;

  await env.DB.prepare(
    `INSERT INTO users (steam_id, display_name, avatar, last_seen_at)
     VALUES (?,?,?,unixepoch())
     ON CONFLICT(steam_id) DO UPDATE SET
       display_name = excluded.display_name,
       avatar       = excluded.avatar,
       last_seen_at = unixepoch()`
  ).bind(steamId, name, profile?.avatar || null).run();

  // Preserve an invite code carried through the login round-trip, so clicking
  // an invite while signed out still lands you in the right group.
  const back = url.searchParams.get('join') ? `/?join=${encodeURIComponent(url.searchParams.get('join'))}` : '/';
  return redirect(back, { 'set-cookie': await makeSessionCookie(steamId, env.SESSION_SECRET) });
}
