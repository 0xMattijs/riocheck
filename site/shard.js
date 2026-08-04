// Shared between the build script (Node) and the browser, so both agree on
// which shard a domain lives in. Changing anything here invalidates every
// published shard, so the build writes SHARD_COUNT into meta.json and the
// client refuses to use an index built with a different value.

export const SHARD_COUNT = 256;

/** FNV-1a, 32-bit. Small, dependency-free, and stable across runtimes. */
export function shardOf(name) {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ((h >>> 0) % SHARD_COUNT).toString(16).padStart(2, '0');
}

/**
 * Reduce whatever the user pasted to a bare hostname: URLs, e-mail addresses,
 * "www.", ports, trailing dots and unicode (IDN) all collapse to the lowercase
 * punycode host that the register itself uses as a key.
 */
export function normaliseHost(input) {
  let s = String(input || '').trim().toLowerCase();
  if (!s) return '';
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''); // scheme
  s = s.split(/[/?#]/)[0]; // path, query, fragment
  if (s.includes('@')) s = s.slice(s.lastIndexOf('@') + 1); // e-mail / userinfo
  s = s.replace(/:\d+$/, ''); // port
  s = s.replace(/\.+$/, ''); // root dot
  if (!s) return '';
  try {
    // Round-trips unicode labels to punycode the same way a browser would.
    const host = new URL('http://' + s).hostname;
    if (host) s = host;
  } catch {
    /* keep the cleaned string; validation happens on the caller's side */
  }
  return s;
}

/** every candidate from the full host up to the shortest usable parent */
export function parentChain(host) {
  const labels = host.split('.');
  const out = [];
  for (let i = 0; i + 1 < labels.length; i++) out.push(labels.slice(i).join('.'));
  return out;
}
