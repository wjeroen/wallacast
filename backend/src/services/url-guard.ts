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

// safeFetch that keeps the cookies each host sets and sends them back to that host on the next
// hops, the way a browser does. For a consent gate that hands over to the site through a redirect
// whose cookie the next hop needs: DPG Media's privacy gate continue link sets it, then sends the
// browser on to the article (hln.be, demorgen.be, 2026-10-07). Cookies are kept per exact host,
// so none ever travels to another site.
export async function safeFetchWithCookies(rawUrl: string, maxHops = 8): Promise<Response> {
  const jar = new Map<string, Map<string, string>>();
  let currentUrl = rawUrl;
  for (let hop = 0; hop <= maxHops; hop++) {
    await assertPublicHttpUrl(currentUrl);
    const host = new URL(currentUrl).host;
    const hostCookies = jar.get(host) || new Map<string, string>();
    const cookie = Array.from(hostCookies, ([name, value]) => `${name}=${value}`).join('; ');
    const res = await fetchWithHeadersTimeout(
      currentUrl,
      { redirect: 'manual', headers: cookie ? { cookie } : {} },
      RESPONSE_HEADERS_TIMEOUT_MS
    );
    for (const setCookie of res.headers.raw()['set-cookie'] || []) {
      const pair = setCookie.split(';')[0];
      const eq = pair.indexOf('=');
      if (eq > 0) hostCookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    jar.set(host, hostCookies);
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      currentUrl = new URL(location, currentUrl).toString();
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

// The same reader proxy asked for Markdown, its default answer. Without an API key the proxy
// builds its HTML answer from a plain request, which a Cloudflare JavaScript challenge stops,
// while it renders the Markdown answer in a real browser, which gets through. Tested on
// axios.com 2026-10-01: three fresh HTML answers were all the "Just a moment..." page, the
// fresh Markdown answer was the article. The answer opens with "Title:", "URL Source:" and
// "Published Time:" lines, then "Markdown Content:" and the article body. It names no author.
export async function readerProxyMarkdown(
  rawUrl: string
): Promise<{ title: string | null; publishedTime: string | null; markdown: string }> {
  await assertPublicHttpUrl(rawUrl);
  const res = await safeFetch(`https://r.jina.ai/${rawUrl}`, {}, 5, 90_000);
  if (!res.ok) {
    throw new Error(`reader proxy Markdown answered HTTP ${res.status}`);
  }
  const text = await res.text();
  const marker = text.indexOf('Markdown Content:');
  const header = marker >= 0 ? text.slice(0, marker) : '';
  const markdown = (marker >= 0 ? text.slice(marker + 'Markdown Content:'.length) : text).trim();
  if (markdown.length < 500) {
    throw new Error(`reader proxy Markdown returned only ${markdown.length} characters`);
  }
  const field = (name: string) => header.match(new RegExp(`^${name}:[ \\t]*(.+)$`, 'm'))?.[1].trim() || null;
  return { title: field('Title'), publishedTime: field('Published Time'), markdown };
}

// The newest archive.today copy of a page (archive.ph and its mirror domains). archive.ph keeps
// the full text of paywalled articles, where the Wayback Machine holds what the site shows
// anyone, often only the free preview (wsj.com, 2026-10-06).
//
// The timemap comes first: a few hundred bytes listing every copy, or 404 when there is none
// (null here). `/newest/<url>` would download the whole copy just to learn that (1.27 MB for one
// WSJ copy). Each copy is a line `<http://archive.md/<timestamp>/<url>>; rel="...memento";
// datetime="..."`, the newest one marked `last memento`. The copy is then fetched from
// archive.ph itself, with 45 seconds to start answering, since archive.ph is often slow (a NYT
// copy took over 20 seconds on Railway, 2026-10-07).
//
// archive.ph limits automated requests: after about 10 in 10 minutes from one address it answers
// HTTP 429 with a captcha page, for about half an hour. The answer can also be a server
// placeholder instead of the snapshot, so the caller checks it (isArchiveSnapshot). Returns the
// snapshot's address too, because an archive copy is read like a pasted archive link (its own
// markup, its own base URL).
const ARCHIVE_PH_HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36' };

/** The archive.ph address of the newest copy of a page (from its timemap), or null when there is none. */
export async function archiveTodayNewestCopy(rawUrl: string): Promise<string | null> {
  await assertPublicHttpUrl(rawUrl);
  const map = await safeFetch(`https://archive.ph/timemap/${rawUrl}`, { headers: ARCHIVE_PH_HEADERS }, 5, 20_000);
  if (map.status === 404) return null;
  if (!map.ok) {
    throw new Error(`archive.ph timemap answered HTTP ${map.status}`);
  }
  return newestArchiveCopy(await map.text());
}

/** One archive.ph copy (an address from archiveTodayNewestCopy): its HTML and its final address. */
export async function archiveTodayCopyFetch(copyUrl: string): Promise<{ html: string; url: string }> {
  const res = await safeFetch(copyUrl, { headers: ARCHIVE_PH_HEADERS }, 5, 45_000);
  if (!res.ok) {
    throw new Error(`archive.ph answered HTTP ${res.status}`);
  }
  return { html: await res.text(), url: res.url };
}

/** The archive.ph address of the newest copy in an archive.today timemap, or null when it lists none. */
export function newestArchiveCopy(timemap: string): string | null {
  const copies = timemap
    .split('\n')
    .filter(line => /rel="[^"]*\bmemento\b/.test(line))
    .map(line => ({ url: line.match(/<([^>]+)>/)?.[1] || '', last: /rel="[^"]*\blast memento\b/.test(line) }))
    .filter(copy => /^https?:\/\/archive\.[a-z]+\/\d{14}\//.test(copy.url));
  const newest = copies.find(copy => copy.last) || copies[copies.length - 1];
  return newest ? newest.url.replace(/^https?:\/\/archive\.[a-z]+\//, 'https://archive.ph/') : null;
}

// The newest Internet Archive (Wayback Machine) copy of a page, as the page's own HTML: the
// `id_` form leaves out the archive's toolbar and keeps every link and image pointing at the
// original site. For pages whose bot wall stops every live fetch. Returns null when the
// archive holds no successful copy (brand-new articles often are not archived yet).
export async function waybackNewestTimestamp(rawUrl: string): Promise<string | null> {
  await assertPublicHttpUrl(rawUrl);
  // The CDX search, not archive.org/wayback/available: that lookup answered HTTP 429 to every
  // news address, even to a first request from a phone, while the CDX search answered normally
  // (2026-10-07). limit=-1 asks for the newest capture with status 200 only. The answer is
  // [["timestamp"], ["20260930222423"]], or [] when there is none. It is slow: 7 to 20 seconds
  // on Railway, once over 30 (2026-10-07), so it gets 45 seconds to start answering.
  const lookup = await safeFetch(
    `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(rawUrl)}&output=json&fl=timestamp&filter=statuscode:200&limit=-1`,
    {},
    5,
    45_000
  );
  if (!lookup.ok) {
    throw new Error(`Wayback lookup answered HTTP ${lookup.status}`);
  }
  const rows = (await lookup.json()) as unknown;
  const last = Array.isArray(rows) && rows.length > 1 ? rows[rows.length - 1] : null;
  const timestamp = String(Array.isArray(last) ? last[0] : '');
  return /^\d{14}$/.test(timestamp) ? timestamp : null;
}

/** The Wayback copy of a page at a timestamp from waybackNewestTimestamp, in the `id_` form. */
export async function waybackCopyFetch(rawUrl: string, timestamp: string): Promise<string> {
  await assertPublicHttpUrl(rawUrl);
  const res = await safeFetch(`https://web.archive.org/web/${timestamp}id_/${rawUrl}`, {}, 5, 60_000);
  if (!res.ok) {
    throw new Error(`Wayback copy answered HTTP ${res.status}`);
  }
  return res.text();
}
