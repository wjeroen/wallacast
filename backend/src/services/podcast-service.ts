import fetch from 'node-fetch';
import { safeFetch } from './url-guard.js';
import { query } from '../database/db.js';
import { JSDOM } from 'jsdom';

export interface PodcastSearchResult {
  title: string;
  author: string;
  feed_url: string;
  preview_picture?: string;
  description?: string;
  type?: 'podcast' | 'newsletter';
}

export interface PodcastEpisode {
  title: string;
  description: string;
  audio_url: string;
  published_at: Date;
  duration?: number;
  episode_number?: number;
}

export async function searchPodcasts(searchQuery: string): Promise<PodcastSearchResult[]> {
  try {
    // Using iTunes Search API (free and reliable)
    const response = await fetch(
      `https://itunes.apple.com/search?term=${encodeURIComponent(searchQuery)}&media=podcast&limit=20`
    );

    if (!response.ok) {
      throw new Error('Failed to search podcasts');
    }

    const data: any = await response.json();

    return data.results
      // Drop results without a feedUrl, they cannot be subscribed to and would fail opaquely later.
      .filter((result: any) => result.feedUrl)
      .map((result: any) => ({
        title: result.collectionName,
        author: result.artistName,
        feed_url: result.feedUrl,
        preview_picture: result.artworkUrl600 || result.artworkUrl100,
        description: result.description,
        type: 'podcast',
      }));
  } catch (error) {
    console.error('Error searching podcasts:', error);
    throw error;
  }
}

export async function searchRSSByUrl(url: string): Promise<PodcastSearchResult[]> {
  try {
    // Normalize URL: add /feed if it looks like a Substack domain
    let feedUrl = url.trim();

    // Auto-fix Substack URLs
    if (feedUrl.includes('substack.com')) {
      // Remove trailing slash if present
      feedUrl = feedUrl.replace(/\/$/, '');

      // If it ends with /feed/, remove the trailing slash
      if (feedUrl.endsWith('/feed/')) {
        feedUrl = feedUrl.slice(0, -1);
      }

      // If it doesn't end with /feed, add it
      if (!feedUrl.endsWith('/feed')) {
        feedUrl = feedUrl + '/feed';
      }
    }

    // Fetch feed details
    const details = await fetchPodcastDetails(feedUrl);

    return [{
      title: details.title,
      author: details.author,
      feed_url: feedUrl,
      preview_picture: details.preview_picture,
      description: details.description,
      type: details.type,
    }];
  } catch (error) {
    console.error('Error fetching RSS feed:', error);
    throw new Error('Could not load RSS feed. Make sure the URL is correct. For Substack newsletters, use: yourname.substack.com/feed');
  }
}

/** A feed address without protocol, "www.", trailing slash and case, so the same feed typed
 *  two ways is one subscription (the Feed tab's feedKey, plus "www."). */
export function feedUrlKey(url: string | null | undefined): string {
  return (url || '').trim().replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/+$/, '').toLowerCase();
}

/** Subscribing to a feed the user already follows. The route answers 409 "Already subscribed". */
export class AlreadySubscribedError extends Error {
  constructor(public podcast: any) {
    super('Already subscribed');
    this.name = 'AlreadySubscribedError';
  }
}

/**
 * Subscribe a user to a feed. A feed the user already follows is refused with
 * AlreadySubscribedError, also when it comes in under another address: the same address
 * written differently (feedUrlKey), an address that redirects to a followed one, or another
 * address of the same publication (the same website, type and title, as when a Substack
 * newsletter is found once under its own domain and once under substack.com). A feed the user
 * unsubscribed from is subscribed again, its cached items included.
 */
export async function subscribeToPodcast(feedUrl: string, userId: number) {
  try {
    // Every feed this user has a row for, subscribed or not
    const rows = (await query('SELECT * FROM podcasts WHERE user_id = $1', [userId])).rows;
    const key = feedUrlKey(feedUrl);
    let existing = rows.find((r: any) => feedUrlKey(r.feed_url) === key);
    if (existing?.is_subscribed) throw new AlreadySubscribedError(existing);

    // Fetch fresh podcast details from feed
    const podcastDetails = await fetchPodcastDetails(feedUrl);

    if (!existing) {
      const finalKey = feedUrlKey(podcastDetails.final_url);
      const site = feedUrlKey(podcastDetails.website_url);
      const title = (podcastDetails.title || '').trim().toLowerCase();
      existing = rows.find((r: any) =>
        (finalKey && feedUrlKey(r.feed_url) === finalKey)
        || (site && title && feedUrlKey(r.website_url) === site && r.type === podcastDetails.type
          && (r.title || '').trim().toLowerCase() === title));
      if (existing?.is_subscribed) throw new AlreadySubscribedError(existing);
    }

    if (existing) {
      // Podcast exists - update it with fresh data and resubscribe
      const result = await query(
        `UPDATE podcasts
         SET title = $1, author = $2, description = $3, website_url = $4,
             preview_picture = $5, category = $6, language = $7, type = $8,
             is_subscribed = true, updated_at = CURRENT_TIMESTAMP
         WHERE id = $9 AND user_id = $10
         RETURNING *`,
        [
          podcastDetails.title,
          podcastDetails.author,
          podcastDetails.description,
          podcastDetails.website_url,
          podcastDetails.preview_picture,
          podcastDetails.category,
          podcastDetails.language?.substring(0, 100) || null,
          podcastDetails.type,
          existing.id,
          userId,
        ]
      );
      return result.rows[0];
    }

    // New podcast - insert it
    const result = await query(
      `INSERT INTO podcasts
       (title, author, description, feed_url, website_url, preview_picture, category, language, type, user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        podcastDetails.title,
        podcastDetails.author,
        podcastDetails.description,
        feedUrl,
        podcastDetails.website_url,
        podcastDetails.preview_picture,
        podcastDetails.category,
        podcastDetails.language?.substring(0, 100) || null,
        podcastDetails.type,
        userId,
      ]
    );

    return result.rows[0];
  } catch (error) {
    console.error('Error subscribing to podcast:', error);
    throw error;
  }
}

export async function fetchPodcastDetails(feedUrl: string) {
  try {
    // FIX: Added User-Agent to avoid blocking by Vox/Cloudflare
    const response = await safeFetch(feedUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*'
      }
    });

    if (!response.ok) {
       throw new Error(`Failed to fetch feed: ${response.status} ${response.statusText}`);
    }

    const xml = await response.text();

    // Validate it's actually an RSS/Atom feed
    if (!xml.includes('<rss') && !xml.includes('<feed') && !xml.includes('<?xml')) {
      throw new Error('URL is not a valid RSS feed. For Substack newsletters, try adding /feed to the URL');
    }

    // Parse Feed Metadata
    const title = extractXMLTag(xml, 'title');
    const author = extractXMLTag(xml, 'itunes:author') || extractXMLTag(xml, 'author');
    
    // FIX: Support both RSS <description> and Atom <subtitle>
    const description = extractXMLTag(xml, 'description') || extractXMLTag(xml, 'subtitle');
    
    // Try multiple image tag formats
    const preview_picture = extractXMLAttribute(xml, 'itunes:image', 'href') ||
      extractNestedXMLTag(xml, 'image', 'url') ||
      extractXMLAttribute(xml, 'media:thumbnail', 'url');
      
    const website_url = extractXMLTag(xml, 'link');
    const category = extractXMLTag(xml, 'itunes:category');
    const language = extractXMLTag(xml, 'language');

    // Detect feed type: podcast (has audio enclosures) vs newsletter/blog (text only)
    const type = detectFeedType(xml);

    return {
      title: cleanHtmlEntities(title),
      author: cleanHtmlEntities(author),
      description: cleanDescription(description),
      preview_picture,
      website_url,
      category: cleanHtmlEntities(category),
      language,
      type,
      // The address the feed answered from, after redirects
      final_url: response.url || feedUrl,
    };
  } catch (error) {
    console.error('Error fetching podcast details:', error);
    throw error;
  }
}

function detectFeedType(xml: string): 'podcast' | 'newsletter' {
  // FIX: Check for both <item> (RSS) and <entry> (Atom)
  const itemMatches = xml.match(/<(item|entry)(?:\s+[^>]*)?>([\s\S]*?)<\/(item|entry)>/gi) || [];

  let audioCount = 0;
  let totalCount = 0;

  for (const itemXml of itemMatches.slice(0, 10)) { // Check first 10 items
    totalCount++;
    const enclosureUrl = extractXMLAttribute(itemXml, 'enclosure', 'url');
    const enclosureType = extractXMLAttribute(itemXml, 'enclosure', 'type');

    // Only count as audio if the enclosure type starts with 'audio/'
    if (enclosureUrl && enclosureType && enclosureType.startsWith('audio/')) {
      audioCount++;
    }
  }

  // If more than 50% of items have AUDIO enclosures, it's a podcast
  // Otherwise it's a newsletter/blog
  return audioCount > totalCount / 2 ? 'podcast' : 'newsletter';
}

export async function fetchPodcastEpisodes(feedUrl: string, podcastId: number, userId: number): Promise<any[]> {
  try {
    // FIX: Added User-Agent
    const response = await safeFetch(feedUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    const xml = await response.text();

    // FIX: Extract items using updated regex for Atom/RSS
    const itemMatches = xml.match(/<(item|entry)(?:\s+[^>]*)?>([\s\S]*?)<\/(item|entry)>/gi) || [];

    // Show author, used when an episode names no author of its own (most feeds set only the
    // channel-level itunes:author). Read from the podcasts row we already store.
    const showAuthorResult = await query('SELECT author FROM podcasts WHERE id = $1', [podcastId]);
    const showAuthor: string | null = showAuthorResult.rows[0]?.author || null;

    const episodes = [];

    for (const itemXml of itemMatches.slice(0, 20)) {
      // Limit to 20 most recent
      const title = extractXMLTag(itemXml, 'title');
      const description = extractXMLTag(itemXml, 'description') || extractXMLTag(itemXml, 'summary');
      const audioUrl = extractXMLAttribute(itemXml, 'enclosure', 'url');
      const pubDate = extractXMLTag(itemXml, 'pubDate') || extractXMLTag(itemXml, 'updated');
      const duration = extractXMLTag(itemXml, 'itunes:duration');
      const itemAuthor = extractXMLTag(itemXml, 'dc:creator') ||
        extractXMLTag(itemXml, 'itunes:author') ||
        extractXMLTag(itemXml, 'author');
      const author = (itemAuthor ? cleanHtmlEntities(itemAuthor) : null) || showAuthor;

      if (!title || !audioUrl) continue;

      // Check if episode already exists
      const existing = await query(
        'SELECT id FROM content_items WHERE podcast_id = $1 AND audio_url = $2',
        [podcastId, audioUrl]
      );

      if (existing.rows.length > 0) continue;

      // Insert episode
      const result = await query(
        `INSERT INTO content_items
         (type, title, description, audio_url, podcast_id, published_at, duration, author, user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [
          'podcast_episode',
          title,
          description,
          audioUrl,
          podcastId,
          pubDate ? new Date(pubDate) : new Date(),
          parseDuration(duration),
          author,
          userId,
        ]
      );

      episodes.push(result.rows[0]);
    }

    return episodes;
  } catch (error) {
    console.error('Error fetching podcast episodes:', error);
    throw error;
  }
}

// In-memory RSS XML cache (avoids re-fetching on every Load More / search)
const xmlCache = new Map<string, { xml: string; timestamp: number }>();
const XML_CACHE_TTL = 5 * 60 * 1000;
const XML_CACHE_MAX = 20;

async function fetchFeedXml(feedUrl: string): Promise<string> {
  const cached = xmlCache.get(feedUrl);
  if (cached && Date.now() - cached.timestamp < XML_CACHE_TTL) {
    return cached.xml;
  }

  const response = await safeFetch(feedUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    }
  });
  const xml = await response.text();

  if (xmlCache.size >= XML_CACHE_MAX) {
    const oldestKey = xmlCache.keys().next().value;
    if (oldestKey) xmlCache.delete(oldestKey);
  }
  xmlCache.set(feedUrl, { xml, timestamp: Date.now() });
  return xml;
}

function parseOneItem(itemXml: string, withTeaser = true): any | null {
  const title = extractXMLTag(itemXml, 'title');
  if (!title) return null;

  const description = extractXMLTag(itemXml, 'description') || extractXMLTag(itemXml, 'summary');
  const teaser = withTeaser ? buildTeaser(title, description, extractPostContent(itemXml)) : null;
  const enclosureUrl = extractXMLAttribute(itemXml, 'enclosure', 'url');
  const enclosureType = extractXMLAttribute(itemXml, 'enclosure', 'type');
  const pubDate = extractXMLTag(itemXml, 'pubDate') || extractXMLTag(itemXml, 'updated');
  const duration = extractXMLTag(itemXml, 'itunes:duration');
  const link = extractXMLTag(itemXml, 'link') || extractXMLAttribute(itemXml, 'link', 'href');

  const preview_picture = extractXMLAttribute(itemXml, 'itunes:image', 'href') ||
    extractXMLAttribute(itemXml, 'media:thumbnail', 'url') ||
    extractXMLAttribute(itemXml, 'media:content', 'url') ||
    extractNestedXMLTag(itemXml, 'image', 'url') ||
    (enclosureType && enclosureType.startsWith('image/') ? enclosureUrl : null);

  const itemAuthor = extractXMLTag(itemXml, 'dc:creator') ||
    extractXMLTag(itemXml, 'itunes:author') ||
    extractXMLTag(itemXml, 'author');
  const cleanAuthor = itemAuthor ? cleanHtmlEntities(itemAuthor) : undefined;

  const isAudioEnclosure = enclosureUrl && enclosureType && enclosureType.startsWith('audio/');

  if (isAudioEnclosure) {
    return {
      title: cleanHtmlEntities(title),
      description: cleanDescription(description),
      teaser,
      audio_url: enclosureUrl,
      published_at: pubDate ? new Date(pubDate) : new Date(),
      duration: parseDuration(duration),
      item_type: 'podcast_episode',
      preview_picture,
      author: cleanAuthor,
    };
  } else if (link) {
    return {
      title: cleanHtmlEntities(title),
      description: cleanDescription(description),
      teaser,
      url: link,
      published_at: pubDate ? new Date(pubDate) : new Date(),
      item_type: 'article',
      preview_picture,
      author: cleanAuthor,
    };
  }
  return null;
}

export async function getPreviewEpisodes(feedUrl: string, limit: number = 50, offset: number = 0): Promise<{ episodes: any[]; hasMore: boolean }> {
  try {
    const xml = await fetchFeedXml(feedUrl);
    const itemRegex = /<(item|entry)(?:\s+[^>]*)?>([\s\S]*?)<\/(item|entry)>/gi;
    let match;
    let index = 0;
    const episodes: any[] = [];

    while ((match = itemRegex.exec(xml)) !== null) {
      if (index < offset) { index++; continue; }
      if (limit > 0 && episodes.length >= limit) {
        return { episodes, hasMore: true };
      }
      const ep = parseOneItem(match[0]);
      if (ep) episodes.push(ep);
      index++;
    }

    return { episodes, hasMore: false };
  } catch (error) {
    console.error('Error fetching preview episodes:', error);
    throw error;
  }
}

export async function searchFeedEpisodes(feedUrl: string, searchQuery: string): Promise<any[]> {
  const xml = await fetchFeedXml(feedUrl);
  const itemRegex = /<(item|entry)(?:\s+[^>]*)?>([\s\S]*?)<\/(item|entry)>/gi;
  let match;
  const q = searchQuery.toLowerCase();
  const results: any[] = [];

  // A long feed holds hundreds of items, so teasers are built for the matches only
  while ((match = itemRegex.exec(xml)) !== null) {
    const ep = parseOneItem(match[0], false);
    if (!ep) continue;
    if (
      (ep.title && ep.title.toLowerCase().includes(q)) ||
      (ep.description && ep.description.toLowerCase().includes(q)) ||
      (ep.author && ep.author.toLowerCase().includes(q))
    ) {
      results.push(parseOneItem(match[0]));
    }
  }
  return results;
}

// --- Helper Functions ---

function extractXMLTag(xml: string, tag: string): string {
  // Regex modified to be robust against attributes in tags
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const match = xml.match(regex);
  if (!match) return '';

  // Remove CDATA wrapper if present
  let content = match[1].trim();
  content = content.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');

  return content;
}

function extractXMLAttribute(xml: string, tag: string, attr: string): string {
  // Regex to capture attribute value
  const regex = new RegExp(`<${tag}[^>]*${attr}="([^"]*)"`, 'i');
  const match = xml.match(regex);
  return match ? match[1] : '';
}

function extractNestedXMLTag(xml: string, parentTag: string, childTag: string): string {
  const parentRegex = new RegExp(`<${parentTag}[^>]*>([\\s\\S]*?)<\\/${parentTag}>`, 'i');
  const parentMatch = xml.match(parentRegex);
  if (!parentMatch) return '';

  const parentContent = parentMatch[1];
  return extractXMLTag(parentContent, childTag);
}

function parseDuration(duration: string): number | null {
  if (!duration) return null;

  // Handle HH:MM:SS or MM:SS or just seconds
  const parts = duration.split(':').map(Number);

  let seconds: number | null = null;
  if (parts.length === 3) {
    seconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
  } else if (parts.length === 2) {
    seconds = parts[0] * 60 + parts[1];
  } else if (parts.length === 1) {
    seconds = parts[0];
  }

  // A non-numeric itunes:duration (e.g. "N/A") makes the arithmetic NaN. Returning NaN would
  // abort the whole episode INSERT, so only return a finite number, else null.
  return seconds != null && Number.isFinite(seconds) ? seconds : null;
}

function cleanDescription(description: string): string {
  if (!description) return '';

  // Remove CDATA wrapper
  let cleaned = description.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');

  // FIX: Remove "Published on..." prefix common in EA Forum/LessWrong feeds
  // Matches pattern: Published on February 1, 2026 11:40 PM GMT<br/><br/>
  // We do this before entity decoding to ensure we match the <br> tags correctly.
  cleaned = cleaned.replace(/^Published on [a-zA-Z]+ \d{1,2}, \d{4}.*?GMT\s*(?:<br\s*\/?>\s*)+/i, '');

  // Decode common HTML entities FIRST (so &lt;p&gt; becomes <p>)
  cleaned = cleanHtmlEntities(cleaned);

  // Remove dangerous/unwanted HTML tags (XSS prevention)
  // This keeps safe formatting tags while blocking scripts, iframes, etc.
  const dangerousTags = [
    'script', 'style', 'iframe', 'object', 'embed',
    'form', 'input', 'button', 'meta', 'link', 'base'
  ];

  dangerousTags.forEach(tag => {
    // Remove both opening and closing tags (with any attributes)
    const regex = new RegExp(`<${tag}[^>]*>.*?</${tag}>|<${tag}[^>]*/>|<${tag}[^>]*>`, 'gis');
    cleaned = cleaned.replace(regex, '');
  });

  // Normalize line breaks: Convert <br>, <br/>, <br /> to consistent <br>
  cleaned = cleaned.replace(/<br\s*\/?>/gi, '<br>');

  return cleaned.trim();
}

// --- Feed card teaser ---
// The text a Feed tab card shows under an item's title: plain text with a blank line between
// paragraphs. Many newsletter feeds (Substack among them) carry only a one-line subtitle,
// nothing, or "..." in <description>, and the whole post in <content:encoded>. The teaser is
// then the subtitle followed by the opening of the post, so a title alone never has to decide
// whether an item is worth adding. When the post already opens with the description (WordPress
// excerpts, feeds that repeat their show notes), the description is not shown twice. Feeds
// without post content (EA Forum, LessWrong, most podcasts) get their description as the teaser.
// The library item keeps the feed's plain description, the teaser is only for the Feed tab.
const TEASER_MAX_CHARS = 1200;
// Only the start of a post is parsed. Substack posts run to 80,000+ characters of HTML.
const TEASER_HTML_SCAN = 15_000;
// A refresh builds teasers for the newest items of a feed only (older ones show their
// description), and never again for an item that already has one.
const TEASER_REFRESH_ITEMS = 30;
// Parts of a post that are not its words: media and their captions, subscribe and share
// buttons, embedded posts and publications, footnotes and their number links.
const TEASER_SKIP = [
  'figure', 'figcaption', 'picture', 'img', 'svg', 'video', 'audio', 'iframe', 'script', 'style',
  'noscript', 'button', 'form', 'table',
  '.subscription-widget-wrap', '.subscription-widget-wrap-editor', '.subscription-widget',
  '.button-wrapper', '.captioned-image-container', '.image-gallery-embed', '.embedded-post-wrap',
  '.digest-post-embed', '.embedded-publication-wrap', '.youtube-wrap', '.tweet',
  '.native-audio-embed', '.poll-embed', '.footnote', '.footnotes', '.footnote-anchor',
  'a[href^="#fn"]', 'a[href^="#footnote"]',
].join(', ');
// One HTML parser for all teasers and entity decoding (cleanHtmlEntities). A new JSDOM
// window per item cost 20-75 ms, and a refresh parses hundreds of items.
const htmlParser = new (new JSDOM('').window.DOMParser)();
// Megaphone adds this line to every episode description
const TEASER_BOILERPLATE = /^Learn more about your ad choices\. Visit megaphone\.fm\/adchoices\.?$/i;

// A post's full content: RSS <content:encoded>, else Atom <content> (never <content:encoded>,
// which the Atom pattern leaves alone because it needs a space or ">" right after the name).
function extractPostContent(itemXml: string): string {
  const encoded = extractXMLTag(itemXml, 'content:encoded');
  if (encoded) return encoded;
  const atom = itemXml.match(/<content(?:\s[^>]*)?>([\s\S]*?)<\/content>/i);
  return atom ? atom[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim() : '';
}

// Feed HTML as plain text, paragraphs separated by a blank line, list items as "• " lines.
function htmlToTeaserText(rawHtml: string): string {
  if (!rawHtml) return '';
  let html = rawHtml.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  // Entity-escaped markup (&lt;p&gt;...) is decoded into real markup first
  if (!/<[a-z!/]/i.test(html) && /&lt;\/?[a-z]/i.test(html)) html = cleanHtmlEntities(html);
  // EA Forum and LessWrong open every item with "Published on <date> GMT"
  html = html.replace(/^Published on [a-zA-Z]+ \d{1,2}, \d{4}.*?GMT\s*(?:<br\s*\/?>\s*)+/i, '');
  const doc = htmlParser.parseFromString(`<!DOCTYPE html><html><body>${html.slice(0, TEASER_HTML_SCAN)}</body></html>`, 'text/html');
  doc.querySelectorAll(TEASER_SKIP).forEach(el => el.remove());
  // Line breaks in the HTML source are plain spaces. Only <br> and block ends break lines.
  const walker = doc.createTreeWalker(doc.body, 4 /* NodeFilter.SHOW_TEXT */);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    node.nodeValue = (node.nodeValue || '').replace(/\s+/g, ' ');
  }
  doc.querySelectorAll('br').forEach(el => el.replaceWith('\n'));
  doc.querySelectorAll('li').forEach(el => el.prepend('• '));
  doc.querySelectorAll('p, div, li, h1, h2, h3, h4, h5, h6, blockquote, pre, ul, ol').forEach(el => el.append('\n\n'));
  return (doc.body.textContent || '')
    // Entities escaped twice in the feed (&amp;nbsp;) are still visible after one decode
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .split('\n')
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(line => !TEASER_BOILERPLATE.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Letters and digits only, for "does the post open with the description?"
const plainKey = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

function truncateAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.search(/\s\S*$/);
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd() + '…';
}

export function buildTeaser(title: string, descriptionRaw: string, contentRaw: string): string | null {
  try {
    return composeTeaser(title, descriptionRaw, contentRaw);
  } catch (error) {
    // A teaser is a nice-to-have. A post that breaks it must never break a refresh.
    console.error('Teaser failed for feed item:', (error as Error).message);
    return null;
  }
}

function composeTeaser(title: string, descriptionRaw: string, contentRaw: string): string | null {
  let description = htmlToTeaserText(descriptionRaw);
  // "...", "…", or the title once more say nothing about the item
  if (!/[\p{L}\p{N}]/u.test(description) || plainKey(description) === plainKey(htmlToTeaserText(title))) {
    description = '';
  }
  const post = contentRaw ? htmlToTeaserText(contentRaw) : '';
  let teaser = description;
  if (post) {
    const descriptionStart = plainKey(description).slice(0, 40);
    const postRepeatsDescription = !descriptionStart || plainKey(post.slice(0, 800)).includes(descriptionStart);
    teaser = postRepeatsDescription ? post : `${description}\n\n${post}`;
  }
  return teaser ? truncateAtWord(teaser, TEASER_MAX_CHARS) : null;
}

function cleanHtmlEntities(text: string): string {
  if (!text) return '';

  // Decode ALL HTML entities (numeric ones like &#8217; and &#163; too) with the shared
  // parser. A new JSDOM per call made this 3 to 4 times slower on real feeds, with the same
  // output (252 real descriptions compared, 2026-10-07).
  try {
    const doc = htmlParser.parseFromString(`<!DOCTYPE html><html><body>${text}</body></html>`, 'text/html');
    return doc.body.textContent || text;
  } catch (e) {
    // Fallback to basic replacements if JSDOM fails
    return text
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ');
  }
}

// --- Feed Caching Functions ---

// A cached item keeps up to 20,000 characters of its cleaned description. Long show notes
// fit (Nerdland's monthly chapter lists stay under 4,000), while a feed that carries
// whole posts in <description> (EA Forum, LessWrong, 40,000+) stays bounded. The raw text
// is cut at twice that before cleaning, because escaped markup (&lt;p&gt;) shrinks when
// decoded, and cleaning a whole post would cost time on every refresh.
const FEED_DESCRIPTION_MAX_CHARS = 20_000;
// The Feed tab list carries only the start of each description (its cards show the teaser,
// and search reads the start). Adding an episode to the library copies the full stored text
// (POST /api/content with feed_item_id).
const FEED_LIST_DESCRIPTION_CHARS = 2_000;

/**
 * Fetches RSS feed from network, parses items, and saves to database cache
 * Also cleans up old items (keeps only 100 most recent per feed)
 */
export async function refreshFeedFromNetwork(feedId: number, feedUrl: string): Promise<{ itemsAdded: number; feedId: number }> {
  console.log(`Refreshing feed ${feedId} from network: ${feedUrl}`);

  try {
    const response = await safeFetch(feedUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    const xml = await response.text();

    const itemMatches = xml.match(/<(item|entry)(?:\s+[^>]*)?>([\s\S]*?)<\/(item|entry)>/gi) || [];

    let itemsAdded = 0;

    const withTeaser = await query(
      'SELECT guid FROM feed_items WHERE feed_id = $1 AND teaser IS NOT NULL',
      [feedId]
    );
    const hasTeaser = new Set<string>(withTeaser.rows.map((row: { guid: string }) => row.guid));

    // Parse and save items (limit to 100 most recent)
    for (const [itemIndex, itemXml] of itemMatches.slice(0, 100).entries()) {
      const title = extractXMLTag(itemXml, 'title');
      const description = extractXMLTag(itemXml, 'description') || extractXMLTag(itemXml, 'summary');
      const enclosureUrl = extractXMLAttribute(itemXml, 'enclosure', 'url');
      const enclosureType = extractXMLAttribute(itemXml, 'enclosure', 'type');
      const pubDate = extractXMLTag(itemXml, 'pubDate') || extractXMLTag(itemXml, 'updated');
      const duration = extractXMLTag(itemXml, 'itunes:duration');
      const link = extractXMLTag(itemXml, 'link') || extractXMLAttribute(itemXml, 'link', 'href');
      const guid = extractXMLTag(itemXml, 'guid') || extractXMLTag(itemXml, 'id') || link || enclosureUrl;

      // No guid/link/enclosure means no stable key. UNIQUE (feed_id, guid) treats NULLs as
      // distinct, so such items would re-insert as duplicates on every refresh. They can't be
      // opened anyway, so skip them entirely.
      if (!guid) continue;

      // Extract per-item author (dc:creator for EA Forum/LessWrong, author/itunes:author as fallbacks)
      const itemAuthor = extractXMLTag(itemXml, 'dc:creator') ||
        extractXMLTag(itemXml, 'itunes:author') ||
        extractXMLTag(itemXml, 'author');

      // Extract thumbnail
      const preview_picture = extractXMLAttribute(itemXml, 'itunes:image', 'href') ||
        extractXMLAttribute(itemXml, 'media:thumbnail', 'url') ||
        extractXMLAttribute(itemXml, 'media:content', 'url') ||
        extractNestedXMLTag(itemXml, 'image', 'url') ||
        (enclosureType && enclosureType.startsWith('image/') ? enclosureUrl : null);

      if (!title) continue;

      const isAudioEnclosure = enclosureUrl && enclosureType && enclosureType.startsWith('audio/');
      const item_type = isAudioEnclosure ? 'podcast_episode' : 'article';
      const url = isAudioEnclosure ? null : link;
      const audio_url = isAudioEnclosure ? enclosureUrl : null;

      const cleanedDescription = description
        ? cleanDescription(description.substring(0, FEED_DESCRIPTION_MAX_CHARS * 2)).slice(0, FEED_DESCRIPTION_MAX_CHARS) || null
        : null;
      const teaser = itemIndex < TEASER_REFRESH_ITEMS && !hasTeaser.has(guid.slice(0, 500))
        ? buildTeaser(title, description, extractPostContent(itemXml))
        : null;

      // Insert into feed_items. ON CONFLICT refreshes the author, fills in a missing teaser,
      // and takes the feed's description when it differs from the stored one (this also
      // completes descriptions cached under an older, shorter limit).
      try {
        const cleanAuthor = itemAuthor ? cleanHtmlEntities(itemAuthor) : null;
        const result = await query(
          `INSERT INTO feed_items
           (feed_id, item_type, title, description, url, audio_url, published_at, duration, preview_picture, guid, author, teaser)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           ON CONFLICT (feed_id, guid) DO UPDATE SET author = EXCLUDED.author,
             teaser = COALESCE(EXCLUDED.teaser, feed_items.teaser),
             description = CASE
               WHEN EXCLUDED.description IS NOT NULL AND EXCLUDED.description IS DISTINCT FROM feed_items.description
               THEN EXCLUDED.description ELSE feed_items.description END
           RETURNING (xmax = 0) AS inserted`,
          [
            feedId,
            item_type,
            // title and guid are VARCHAR(500); some feeds emit very long guids (full URLs)
            // Truncate so one oversized item can't fail the whole insert.
            cleanHtmlEntities(title).slice(0, 500),
            cleanedDescription,
            url,
            audio_url,
            pubDate ? new Date(pubDate) : new Date(),
            parseDuration(duration),
            preview_picture,
            guid ? guid.slice(0, 500) : guid,
            cleanAuthor,
            teaser,
          ]
        );

        // The command counts updated rows too. A row the INSERT itself created has
        // xmax 0, a row that ON CONFLICT updated does not.
        if (result.rows[0]?.inserted) {
          itemsAdded++;
        }
      } catch (err: any) {
        // Log but continue processing other items
        console.error(`Error inserting feed item: ${err.message}`);
      }
    }

    // Update last_refreshed_at timestamp
    await query(
      'UPDATE podcasts SET last_refreshed_at = NOW() WHERE id = $1',
      [feedId]
    );

    // Clean up old items (keep only 100 most recent)
    await cleanupOldFeedItems(feedId, 100);

    console.log(`Feed ${feedId} refreshed: ${itemsAdded} new items added`);
    return { itemsAdded, feedId };
  } catch (error) {
    console.error(`Error refreshing feed ${feedId}:`, error);
    throw error;
  }
}

// --- Background refresh ---
// A refresh of 100+ feeds takes about a minute (68 s for 114 feeds, measured 2026-10-05). The
// request used to stay open that long, and a phone that put the app in the background closed
// it (HTTP 499 in the Railway logs), so the app reported a failure while the server finished
// the refresh anyway. POST /refresh-feeds now starts the refresh and answers at once, and the
// app polls GET /refresh-status. The status lives in memory, one entry per user, which fits
// the single backend instance. A restart during a refresh loses it, and the app then reports
// a failure.
export interface FeedRefreshStatus {
  running: boolean;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  totalFeeds?: number;
  totalItemsAdded?: number;
}

const feedRefreshes = new Map<number, FeedRefreshStatus>();

export function getFeedRefreshStatus(userId: number): FeedRefreshStatus {
  return feedRefreshes.get(userId) ?? { running: false };
}

// Starts a refresh unless one of this user is already running, and returns its status
export function startFeedRefresh(userId: number): FeedRefreshStatus {
  const current = feedRefreshes.get(userId);
  if (current?.running) return current;

  const startedAt = new Date().toISOString();
  const status: FeedRefreshStatus = { running: true, startedAt };
  feedRefreshes.set(userId, status);
  console.log(`User ${userId} refreshing all feeds from network`);

  refreshAllFeedsFromNetwork(userId)
    .then((result) => {
      console.log(`Refresh complete: ${result.totalFeeds} feeds, ${result.totalItemsAdded} new items`);
      feedRefreshes.set(userId, { running: false, startedAt, finishedAt: new Date().toISOString(), ...result });
    })
    .catch((error) => {
      console.error('Error refreshing feeds:', error);
      feedRefreshes.set(userId, {
        running: false,
        startedAt,
        finishedAt: new Date().toISOString(),
        error: 'Failed to refresh feeds',
      });
    });

  return status;
}

/**
 * Refreshes all subscribed feeds for a specific user
 */
export async function refreshAllFeedsFromNetwork(userId: number): Promise<{ totalFeeds: number; totalItemsAdded: number }> {
  console.log(`Refreshing all feeds for user ${userId}`);

  // Get all subscribed feeds for this user
  const result = await query(
    'SELECT id, feed_url FROM podcasts WHERE user_id = $1 AND is_subscribed = TRUE',
    [userId]
  );

  const feeds = result.rows;
  let totalItemsAdded = 0;

  // Refresh each feed sequentially (to avoid overwhelming the server/network)
  for (const feed of feeds) {
    try {
      const { itemsAdded } = await refreshFeedFromNetwork(feed.id, feed.feed_url);
      totalItemsAdded += itemsAdded;
    } catch (err: any) {
      console.error(`Failed to refresh feed ${feed.id}: ${err.message}`);
      // Continue with other feeds even if one fails
    }
  }

  console.log(`All feeds refreshed: ${feeds.length} feeds, ${totalItemsAdded} new items`);
  return { totalFeeds: feeds.length, totalItemsAdded };
}

// Every feed_items column except the full description, which is cut to the list length.
// feed_item_id names the row for POST /api/content, apart from the content ids the app uses.
const FEED_ITEM_LIST_COLUMNS = `
        fi.id, fi.id AS feed_item_id, fi.feed_id, fi.item_type, fi.title,
        LEFT(fi.description, ${FEED_LIST_DESCRIPTION_CHARS}) AS description,
        fi.url, fi.audio_url, fi.published_at, fi.duration, fi.preview_picture, fi.guid,
        fi.author, fi.teaser, fi.created_at, fi.updated_at,
        p.title as podcast_show_name,
        p.type as feed_type`;

/**
 * Gets cached feed items from database
 * @param userId - User ID to filter by their subscribed feeds
 * @param feedId - Optional: filter by specific feed
 * @param limit - Maximum number of items to return (default: 100)
 */
export async function getCachedFeedItems(userId: number, feedId?: number, limit: number = 50, offset: number = 0): Promise<any[]> {
  let queryText: string;
  let queryParams: any[];

  if (feedId) {
    queryText = `
      SELECT ${FEED_ITEM_LIST_COLUMNS}
      FROM feed_items fi
      JOIN podcasts p ON fi.feed_id = p.id
      WHERE p.user_id = $1 AND fi.feed_id = $2
      ORDER BY fi.published_at DESC
      LIMIT $3 OFFSET $4
    `;
    queryParams = [userId, feedId, limit, offset];
  } else {
    queryText = `
      SELECT ${FEED_ITEM_LIST_COLUMNS}
      FROM feed_items fi
      JOIN podcasts p ON fi.feed_id = p.id
      WHERE p.user_id = $1 AND p.is_subscribed = TRUE
      ORDER BY fi.published_at DESC
      LIMIT $2 OFFSET $3
    `;
    queryParams = [userId, limit, offset];
  }

  const result = await query(queryText, queryParams);
  return result.rows;
}

/**
 * Gets the last refresh time for user's feeds
 */
export async function getLastRefreshTime(userId: number): Promise<Date | null> {
  const result = await query(
    `SELECT MAX(last_refreshed_at) as last_refresh
     FROM podcasts
     WHERE user_id = $1 AND is_subscribed = TRUE`,
    [userId]
  );

  return result.rows[0]?.last_refresh || null;
}

/**
 * Cleans up old feed items, keeping only the N most recent per feed
 */
async function cleanupOldFeedItems(feedId: number, keepCount: number = 100): Promise<number> {
  // Delete items beyond the keepCount limit (ordered by published_at DESC)
  const result = await query(
    `DELETE FROM feed_items
     WHERE id IN (
       SELECT id FROM feed_items
       WHERE feed_id = $1
       ORDER BY published_at DESC
       OFFSET $2
     )`,
    [feedId, keepCount]
  );

  const deletedCount = result.rowCount || 0;
  if (deletedCount > 0) {
    console.log(`Cleaned up ${deletedCount} old items from feed ${feedId}`);
  }

  return deletedCount;
}
