import { json, bad } from '../../../lib/http.js';
import { searchStore, getAppDetails, parseAppId } from '../../../lib/steam.js';

/** Type-ahead for the add-a-game box. Also resolves a pasted store URL directly. */
export async function onRequestGet({ request, env }) {
  const q = new URL(request.url).searchParams.get('q')?.trim();
  if (!q || q.length < 2) return json({ results: [] });

  const appid = parseAppId(q);
  if (appid) {
    // env.DB is required: getAppDetails is cache-first against steam_apps, which
    // is what keeps a pasted store link from costing a Steam request every time.
    const meta = await getAppDetails(env.DB, appid);
    return json({
      results: meta
        ? [{ appid, name: meta.name, image: meta.header_image, price: meta.price, release: meta.release_date }]
        : [],
    });
  }

  return json({ results: await searchStore(q) });
}
