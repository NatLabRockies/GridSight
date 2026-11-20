/**
 * apiFetch — centralized fetch wrapper used by every loader.
 *
 * Handles the boilerplate every loader was duplicating:
 *   - credentials: 'include' so the auth cookie always rides along
 *   - non-2xx → throw with a useful "[loaders] <name> failed: <status> <body>"
 *     message (caller passes the name)
 *   - automatic JSON / text / arrayBuffer parse based on responseType
 *   - lets callers pass through fetch options for body, headers, signal,
 *     duplex (streaming uploads)
 *
 * Returns the parsed body. For 204 No Content responses returns ``null``.
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {string} [opts.method='GET']
 * @param {object|FormData|ReadableStream|Blob|string|null} [opts.body]
 * @param {object} [opts.headers]
 * @param {AbortSignal} [opts.signal]
 * @param {'half'} [opts.duplex]  — for streaming request bodies
 * @param {string} [opts.name='apiFetch']  — used in error messages
 * @param {'json'|'text'|'arrayBuffer'|'response'} [opts.responseType='json']
 *        — 'response' returns the raw Response object (for streaming).
 * @param {RequestCache} [opts.cache]
 * @returns {Promise<any>}
 */
export async function apiFetch(url, opts = {}) {
  const {
    method = 'GET',
    body,
    headers = {},
    signal,
    duplex,
    name = 'apiFetch',
    responseType = 'json',
    cache,
  } = opts;

  const finalHeaders = { ...headers };
  let finalBody = body;
  // Auto-stringify plain objects (but NOT FormData / ReadableStream / Blob /
  // ArrayBuffer / string / null).
  const isJsonBody = body
    && typeof body === 'object'
    && !(body instanceof FormData)
    && !(body instanceof Blob)
    && !(body instanceof ArrayBuffer)
    && !(typeof ReadableStream !== 'undefined' && body instanceof ReadableStream)
    && !ArrayBuffer.isView(body);
  if (isJsonBody) {
    finalBody = JSON.stringify(body);
    if (!finalHeaders['Content-Type'] && !finalHeaders['content-type']) {
      finalHeaders['Content-Type'] = 'application/json';
    }
  }

  const response = await fetch(url, {
    method,
    credentials: 'include',
    headers: finalHeaders,
    body: finalBody,
    signal,
    ...(cache ? { cache } : {}),
    ...(duplex ? { duplex } : {}),
  });

  if (!response.ok) {
    let detail = '';
    try { detail = await response.text(); } catch { /* swallow */ }
    const trimmed = detail ? detail.slice(0, 500) : '';
    throw new Error(`[loaders] ${name} failed: ${response.status}${trimmed ? ' ' + trimmed : ''}`);
  }

  if (response.status === 204) return null;
  if (responseType === 'response') return response;
  if (responseType === 'arrayBuffer') return response.arrayBuffer();
  if (responseType === 'text') return response.text();
  return response.json();
}
