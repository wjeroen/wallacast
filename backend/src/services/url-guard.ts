import dns from 'dns';
import net from 'net';
import fetch, { type RequestInit, type Response } from 'node-fetch';

// SSRF guard. The server fetches user-supplied URLs (article URLs, RSS/podcast feeds, images
// scraped from fetched pages, podcast audio, and the unauthenticated audio proxy). Without a
// guard, a user could point any of those at the internal Railway network, localhost, or the
// cloud metadata endpoint (169.254.169.254). The audio proxy is the sharpest edge: it streams
// the upstream response straight back to the caller, turning that into a read primitive.
//
// We validate the URL's scheme and its RESOLVED IP before every request, and re-validate on
// every redirect hop (a public URL that 302s to an internal address must still be blocked).

// Is a resolved IP one we must never fetch from (loopback / private / link-local / reserved)?
function isBlockedIp(ip: string): boolean {
  const type = net.isIP(ip); // 4, 6, or 0 (not an IP)
  if (type === 4) {
    const p = ip.split('.').map(Number);
    if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true;
    const [a, b] = p;
    if (a === 0) return true; // 0.0.0.0/8 "this host"
    if (a === 10) return true; // 10.0.0.0/8 private
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (incl. cloud metadata)
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
    if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 carrier-grade NAT
    if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
    return false;
  }
  if (type === 6) {
    const low = ip.toLowerCase();
    if (low === '::' || low === '::1') return true; // unspecified / loopback
    if (low.startsWith('fe80')) return true; // fe80::/10 link-local
    if (low.startsWith('fc') || low.startsWith('fd')) return true; // fc00::/7 unique-local
    // IPv4-mapped IPv6 (::ffff:a.b.c.d): pull out the v4 part and re-check it.
    const m = low.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (m) return isBlockedIp(m[1]);
    return false;
  }
  return true; // not a valid IP literal = block, defensively
}

// Parse and validate a user-supplied URL. Rejects non-http(s) schemes and any host that
// resolves to a blocked IP. Returns the parsed URL on success; throws (message prefixed
// "Blocked URL:") otherwise, so callers surface a clean error instead of hitting the intranet.
export async function assertPublicHttpUrl(rawUrl: string): Promise<URL> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error('Blocked URL: not a valid URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`Blocked URL: only http/https is allowed (got ${u.protocol})`);
  }
  const host = u.hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  // If the host is already an IP literal, check it directly (no DNS lookup).
  if (net.isIP(host)) {
    if (isBlockedIp(host)) throw new Error(`Blocked URL: ${host} is a private/reserved address`);
    return u;
  }
  // Otherwise resolve ALL addresses and block if ANY is private (a hostname can deliberately
  // resolve to both a public and a private IP to slip past a naive check).
  let addrs: dns.LookupAddress[];
  try {
    addrs = await dns.promises.lookup(host, { all: true });
  } catch {
    throw new Error(`Blocked URL: could not resolve host ${host}`);
  }
  if (addrs.length === 0) throw new Error(`Blocked URL: host ${host} did not resolve`);
  for (const a of addrs) {
    if (isBlockedIp(a.address)) {
      throw new Error(`Blocked URL: ${host} resolves to a private/reserved address`);
    }
  }
  return u;
}

// node-fetch wrapper that validates the initial URL and re-validates every redirect Location,
// then follows up to `maxHops` redirects manually. node-fetch's automatic redirect following
// would skip our per-hop check, so we set redirect:'manual' and drive it ourselves. Drop-in
// replacement for `fetch(url, options)` at every user-supplied-URL call site.
export async function safeFetch(
  rawUrl: string,
  options: RequestInit = {},
  maxHops = 5
): Promise<Response> {
  let currentUrl = rawUrl;
  let method = (options.method || 'GET').toUpperCase();
  let body = options.body;
  for (let hop = 0; hop <= maxHops; hop++) {
    await assertPublicHttpUrl(currentUrl);
    const res = await fetch(currentUrl, { ...options, method, body, redirect: 'manual' });
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      // Resolve relative Location against the current URL.
      currentUrl = new URL(location, currentUrl).toString();
      // 303, and 301/302 on a POST, switch the follow-up to GET and drop the body.
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
        method = 'GET';
        body = undefined;
      }
      continue;
    }
    return res;
  }
  throw new Error(`Blocked URL: too many redirects (>${maxHops})`);
}
