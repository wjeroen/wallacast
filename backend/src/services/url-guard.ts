import dns from 'dns';
import net from 'net';
import fetch, { type RequestInit, type Response } from 'node-fetch';
import { gotScraping } from 'got-scraping';

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

// Podcast audio URLs route through long measurement chains (seen live 2026-07-26: pdst.fm ->
// pscrb.fm -> mgln.ai -> claritaspod.com -> podderapp.com -> mgln.ai -> flightcast, ~7 hops),
// so the default cap of 5 blocks legitimate episodes. Audio call sites (the proxy and the
// transcription download) pass this higher cap; every hop is still SSRF-validated.
export const AUDIO_REDIRECT_HOPS = 12;

// A site that never answers must not hang the caller forever. Washington Post does exactly
// that to suspected bots (seen live 2026-09-03): it accepts the connection and then stays
// silent, and with no timeout the save request from the app spun forever. This timeout only
// covers the wait for the response HEADERS of one hop. It is cleared the moment the server
// starts answering, so big slow body downloads (podcast audio, huge pages) keep unlimited
// time to stream.
export const RESPONSE_HEADERS_TIMEOUT_MS = 30_000;

// One fetch attempt guarded by the headers timeout above. A caller-provided abort signal
// (the image downloader passes one) is forwarded, so either the caller or our timer can
// cancel. A timer-caused abort is rethrown as a plain Error with a clear message, because
// node-fetch's own AbortError would read as if the caller cancelled.
async function fetchWithHeadersTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const callerSignal = options.signal;
  const forwardAbort = () => controller.abort();
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort();
    else callerSignal.addEventListener('abort', forwardAbort);
  }
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error: any) {
    if (error?.name === 'AbortError' && !callerSignal?.aborted) {
      throw new Error(
        `Fetch timeout: no response from ${new URL(url).hostname} within ${timeoutMs / 1000}s`
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
    if (callerSignal) callerSignal.removeEventListener('abort', forwardAbort);
  }
}

// node-fetch wrapper that validates the initial URL and re-validates every redirect Location,
// then follows up to `maxHops` redirects manually. node-fetch's automatic redirect following
// would skip our per-hop check, so we set redirect:'manual' and drive it ourselves. Drop-in
// replacement for `fetch(url, options)` at every user-supplied-URL call site.
export async function safeFetch(
  rawUrl: string,
  options: RequestInit = {},
  maxHops = 5,
  headersTimeoutMs = RESPONSE_HEADERS_TIMEOUT_MS
): Promise<Response> {
  let currentUrl = rawUrl;
  let method = (options.method || 'GET').toUpperCase();
  let body = options.body;
  for (let hop = 0; hop <= maxHops; hop++) {
    await assertPublicHttpUrl(currentUrl);
    const res = await fetchWithHeadersTimeout(
      currentUrl,
      { ...options, method, body, redirect: 'manual' },
      headersTimeoutMs
    );
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

// Fetch with got-scraping's realistic browser headers, for sites whose bot walls answer the
// plain fetch with a 403 (openai.com behind Cloudflare, seen live 2026-09-03). Redirects are
// followed manually so every hop passes the same SSRF check as safeFetch. HTTP error statuses
// do not throw, the caller decides what a 4xx/5xx means.
export async function browserHeadersFetch(
  rawUrl: string,
  maxHops = 5
): Promise<{ statusCode: number; body: string; headers: Record<string, string | string[] | undefined> }> {
  let currentUrl = rawUrl;
  for (let hop = 0; hop <= maxHops; hop++) {
    await assertPublicHttpUrl(currentUrl);
    const res = await gotScraping({
      url: currentUrl,
      followRedirect: false,
      throwHttpErrors: false,
      responseType: 'text',
      timeout: { request: RESPONSE_HEADERS_TIMEOUT_MS },
      headerGeneratorOptions: {
        browsers: [{ name: 'chrome', minVersion: 120 }],
        devices: ['desktop'],
        locales: ['en-US', 'en'],
        operatingSystems: ['windows', 'macos'],
      },
      // Explicit navigation headers on top of the generated set, matching what a browser
      // sends when a person opens a page (the forum GraphQL path also hand-sets its own).
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      retry: { limit: 0 },
    });
    const location = res.headers?.location;
    if (res.statusCode >= 300 && res.statusCode < 400 && location) {
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }
    return { statusCode: res.statusCode, body: res.body ?? '', headers: res.headers ?? {} };
  }
  throw new Error(`Blocked URL: too many redirects (>${maxHops})`);
}

// Last-resort fetch through the r.jina.ai reader proxy, for pages whose bot wall serves a
// JavaScript challenge that no server-side header set can ever pass (openai.com does this to
// Railway's datacenter address, verified via cf-mitigated=challenge on 2026-09-03). The proxy
// opens the page in its own real browser and returns the rendered HTML. Only the public
// article URL is sent to the proxy, and it is SSRF-validated first so an internal address
// can never be handed to the proxy either. The proxy needs time to render, so the headers
// timeout is raised to 90s for this one call.
export async function readerProxyFetch(rawUrl: string): Promise<string> {
  await assertPublicHttpUrl(rawUrl);
  const res = await safeFetch(
    `https://r.jina.ai/${rawUrl}`,
    { headers: { 'X-Return-Format': 'html' } },
    5,
    90_000
  );
  if (!res.ok) {
    throw new Error(`reader proxy answered HTTP ${res.status}`);
  }
  const html = await res.text();
  if (html.length < 1000) {
    throw new Error(`reader proxy returned only ${html.length} bytes`);
  }
  return html;
}
