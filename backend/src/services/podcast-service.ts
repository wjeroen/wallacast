import fetch from 'node-fetch';
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

    return data.results.map((result: any) => ({
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

export async function subscribeToPodcast(feedUrl: string, userId: number) {
  try {
    // Check if this user has this podcast (even if unsubscribed)
    const existing = await query(
      'SELECT * FROM podcasts WHERE feed_url = $1 AND user_id = $2',
      [feedUrl, userId]
    );

    // Fetch fresh podcast details from feed
    const podcastDetails = await fetchPodcastDetails(feedUrl);

    if (existing.rows.length > 0) {
      // Podcast exists - update it with fresh data and resubscribe
      const result = await query(
        `UPDATE podcasts
         SET title = $1, author = $2, description = $3, website_url = $4,
             preview_picture = $5, category = $6, language = $7, type = $8,
             is_subscribed = true, updated_at = CURRENT_TIMESTAMP
         WHERE feed_url = $9 AND user_id = $10
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
          feedUrl,
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
    const response = await fetch(feedUrl, {
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
    const response = await fetch(feedUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    const xml = await response.text();

    // FIX: Extract items using updated regex for Atom/RSS
    const itemMatches = xml.match(/<(item|entry)(?:\s+[^>]*)?>([\s\S]*?)<\/(item|entry)>/gi) || [];

    const episodes = [];

    for (const itemXml of itemMatches.slice(0, 20)) {
      // Limit to 20 most recent
      const title = extractXMLTag(itemXml, 'title');
      const description = extractXMLTag(itemXml, 'description') || extractXMLTag(itemXml, 'summary');
      const audioUrl = extractXMLAttribute(itemXml, 'enclosure', 'url');
      const pubDate = extractXMLTag(itemXml, 'pubDate') || extractXMLTag(itemXml, 'updated');
      const duration = extractXMLTag(itemXml, 'itunes:duration');

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
         (type, title, description, audio_url, podcast_id, published_at, duration, user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [
          'podcast_episode',
          title,
          description,
          audioUrl,
          podcastId,
          pubDate ? new Date(pubDate) : new Date(),
          parseDuration(duration),
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

export async function getPreviewEpisodes(feedUrl: string): Promise<any[]> {
  try {
    // FIX: Added User-Agent
    const response = await fetch(feedUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    const xml = await response.text();

    // FIX: Extract items using updated regex for Atom/RSS
    const itemMatches = xml.match(/<(item|entry)(?:\s+[^>]*)?>([\s\S]*?)<\/(item|entry)>/gi) || [];

    const episodes = [];

    for (const itemXml of itemMatches.slice(0, 20)) {
      // Limit to 20 most recent
      const title = extractXMLTag(itemXml, 'title');
      
      // FIX: Prioritize summary/description to avoid full articles. 
      // RSS uses 'description', Atom uses 'summary'. 
      // We purposefully avoid 'content:encoded' or 'content' to keep it brief.
      const description = extractXMLTag(itemXml, 'description') || extractXMLTag(itemXml, 'summary');
      
      const enclosureUrl = extractXMLAttribute(itemXml, 'enclosure', 'url');
      const enclosureType = extractXMLAttribute(itemXml, 'enclosure', 'type');
      const pubDate = extractXMLTag(itemXml, 'pubDate') || extractXMLTag(itemXml, 'updated');
      const duration = extractXMLTag(itemXml, 'itunes:duration');
      
      // RSS uses <link>URL</link>, Atom uses <link href="URL" />
      const link = extractXMLTag(itemXml, 'link') || extractXMLAttribute(itemXml, 'link', 'href'); 

      // Extract item-level thumbnail
      const preview_picture = extractXMLAttribute(itemXml, 'itunes:image', 'href') ||
        extractXMLAttribute(itemXml, 'media:thumbnail', 'url') ||
        extractXMLAttribute(itemXml, 'media:content', 'url') ||
        extractNestedXMLTag(itemXml, 'image', 'url') ||
        // If enclosure is an image, use it as thumbnail (Substack)
        (enclosureType && enclosureType.startsWith('image/') ? enclosureUrl : null);

      if (!title) continue;

      // Check if enclosure is actually audio (not an image)
      const isAudioEnclosure = enclosureUrl && enclosureType && enclosureType.startsWith('audio/');

      // For podcasts: require audio enclosure with audio/* mime type
      // For newsletters: require link (article URL)
      if (isAudioEnclosure) {
        // Podcast episode
        episodes.push({
          title: cleanHtmlEntities(title),
          description: cleanDescription(description),
          audio_url: enclosureUrl,
          published_at: pubDate ? new Date(pubDate) : new Date(),
          duration: parseDuration(duration),
          item_type: 'podcast_episode',
          preview_picture,
        });
      } else if (link) {
        // Newsletter article
        episodes.push({
          title: cleanHtmlEntities(title),
          description: cleanDescription(description),
          url: link,
          published_at: pubDate ? new Date(pubDate) : new Date(),
          item_type: 'article',
          preview_picture,
        });
      }
    }

    return episodes;
  } catch (error) {
    console.error('Error fetching preview episodes:', error);
    throw error;
  }
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

  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  } else if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  } else if (parts.length === 1) {
    return parts[0];
  }

  return null;
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

function cleanHtmlEntities(text: string): string {
  if (!text) return '';

  // Use JSDOM to decode ALL HTML entities (including numeric ones like &#8217;, &#163;, etc.)
  try {
    const dom = new JSDOM(`<!DOCTYPE html><html><body>${text}</body></html>`);
    return dom.window.document.body.textContent || text;
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
