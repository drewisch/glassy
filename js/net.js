// Network accounting: every API / terrain request goes through fetchCounted so the
// UI can show how many bytes the app has transferred (sustainable-web transparency).

let total = 0;
const listeners = new Set();

function emit() {
  for (const cb of listeners) {
    try { cb(total); } catch (e) { /* a broken listener must not break networking */ }
  }
}

/** Add n bytes to the counter (used for bytes fetched inside the worker). */
export function addBytes(n) {
  n = Number(n);
  if (!Number.isFinite(n) || n <= 0) return;
  total += n;
  emit();
}

/** Total bytes transferred so far. */
export function bytesUsed() {
  return total;
}

/** Subscribe to byte counter changes; cb(total). Returns an unsubscribe function. */
export function onBytes(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * fetch() wrapper that reads the whole body, counts its size and returns a new
 * Response carrying the same body, status and headers.
 */
export async function fetchCounted(url, opts) {
  const res = await fetch(url, opts);
  const buf = await res.arrayBuffer();
  let n = buf.byteLength;
  if (!n) {
    const cl = Number(res.headers.get('content-length'));
    if (Number.isFinite(cl) && cl > 0) n = cl;
  }
  addBytes(n);
  // 204/304 etc. must not carry a body.
  const nullBody = res.status === 204 || res.status === 205 || res.status === 304;
  return new Response(nullBody ? null : buf, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}
