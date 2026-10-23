import { redirect } from '../../../lib/http.js';
import { carriedParams } from '../../../lib/auth.js';

/** Kick off Steam OpenID 2.0. Steam sends the user back to /api/auth/callback. */
export function onRequestGet({ request }) {
  const url = new URL(request.url);
  const origin = url.origin;
  // Carry an invite code or poll link across the Steam round-trip.
  const carried = carriedParams(url.searchParams);
  const returnTo = `${origin}/api/auth/callback${carried ? `?${carried}` : ''}`;
  const params = new URLSearchParams({
    'openid.ns': 'http://specs.openid.net/auth/2.0',
    'openid.mode': 'checkid_setup',
    'openid.return_to': returnTo,
    'openid.realm': origin,
    'openid.identity': 'http://specs.openid.net/auth/2.0/identifier_select',
    'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select',
  });
  return redirect(`https://steamcommunity.com/openid/login?${params}`);
}
