export const SECURITY_HEADERS = {
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
};

export const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...SECURITY_HEADERS,
      ...headers,
    },
  });

export const bad = (message, status = 400) => json({ error: message }, status);

export const redirect = (location, headers = {}) =>
  new Response(null, { status: 302, headers: { location, ...SECURITY_HEADERS, ...headers } });

export class RequestBodyError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'RequestBodyError';
    this.status = status;
  }
}

/** Read a deliberately small JSON body without ever buffering an unbounded request. */
export async function body(request, maxBytes = 32 * 1024) {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new RequestBodyError(`request body must be under ${maxBytes / 1024} KB`, 413);
  }

  try {
    if (!request.body) return {};
    const reader = request.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new RequestBodyError(`request body must be under ${maxBytes / 1024} KB`, 413);
      }
      chunks.push(value);
    }

    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const t = new TextDecoder().decode(bytes);
    return t ? JSON.parse(t) : {};
  } catch (error) {
    if (error instanceof RequestBodyError) throw error;
    throw new RequestBodyError('request body must be valid JSON');
  }
}

/** Clamp a rating to the 1–10 scale in half-point steps. Returns null if unusable. */
export function cleanScore(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const r = Math.round(n * 2) / 2;
  return r >= 1 && r <= 10 ? r : null;
}
