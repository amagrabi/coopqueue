export const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });

export const bad = (message, status = 400) => json({ error: message }, status);

export const redirect = (location, headers = {}) =>
  new Response(null, { status: 302, headers: { location, ...headers } });

/** Read and JSON-parse a request body, tolerating an empty one. */
export async function body(request) {
  try {
    const t = await request.text();
    return t ? JSON.parse(t) : {};
  } catch {
    return {};
  }
}

/** Clamp a rating to the 1–10 scale in half-point steps. Returns null if unusable. */
export function cleanScore(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const r = Math.round(n * 2) / 2;
  return r >= 1 && r <= 10 ? r : null;
}
