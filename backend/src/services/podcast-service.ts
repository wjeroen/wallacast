import fetch from 'node-fetch';
import { query } from '../database/db.js';

export interface PodcastSearchResult {
  title: string;
  author: string;
  feed_url: string;
  preview_picture?: string;
  description?: string;
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
    }));
  } catch (error) {
    console.error('Error searching podcasts:', error);
    throw error;
  }
}

export async function subscribeToPodcast(feedUrl: string, userId: number) {
  try {
    // Check if this user is already subscribed to this feed
    const existing = await query(
      'SELECT * FROM podcasts WHERE feed_url = $1 AND user_id = $2',
      [feedUrl, userId]
    );

    if (existing.rows.length > 0) {
      return existing.rows[0];
    }

    // Fetch podcast details from feed
    const podcastDetails = await fetchPodcastDetails(feedUrl);

    // Insert podcast
    const result = await query(
      `INSERT INTO podcasts
       (title, author, description, feed_url, website_url, preview_picture, category, language, user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        podcastDetails.title,
        podcastDetails.author,
        podcastDetails.description,
        feedUrl,
        podcastDetails.website_url,
        podcastDetails.preview_picture,
        podcastDetails.category,
        podcastDetails.language?.substring(0, 100) || null,  // Truncate language to 100 chars as safeguard
        userId,
      ]
    );

    const podcast = result.rows[0];

    return podcast;
  } catch (error) {
    console.error('Error subscribing to podcast:', error);
    throw error;
  }
}

export async function fetchPodcastDetails(feedUrl: string) {
  try {
    const response = await fetch(feedUrl);
    const xml = await response.text();

    // Basic RSS parsing - in production, use a proper XML parser like fast-xml-parser
    const title = extractXMLTag(xml, 'title');
    const author = extractXMLTag(xml, 'itunes:author') || extractXMLTag(xml, 'author');
    const description = extractXMLTag(xml, 'description');
    const preview_picture = extractXMLAttribute(xml, 'itunes:image', 'href');
    const website_url = extractXMLTag(xml, 'link');
    const category = extractXMLTag(xml, 'itunes:category');
    const language = extractXMLTag(xml, 'language');

    return {
      title,
      author,
      description,
      preview_picture,
      website_url,
      category,
      language,
    };
  } catch (error) {
    console.error('Error fetching podcast details:', error);
    throw error;
  }
}

export async function fetchPodcastEpisodes(feedUrl: string, podcastId: number, userId: number): Promise<any[]> {
  try {
    const response = await fetch(feedUrl);
    const xml = await response.text();

    // Extract episodes from RSS feed
    const itemMatches = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];

    const episodes = [];

    for (const itemXml of itemMatches.slice(0, 20)) {
      // Limit to 20 most recent
      const title = extractXMLTag(itemXml, 'title');
      const description = extractXMLTag(itemXml, 'description');
      const audioUrl = extractXMLAttribute(itemXml, 'enclosure', 'url');
      const pubDate = extractXMLTag(itemXml, 'pubDate');
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
    const response = await fetch(feedUrl);
    const xml = await response.text();

    // Extract episodes from RSS feed
    const itemMatches = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];

    const episodes = [];

    for (const itemXml of itemMatches.slice(0, 20)) {
      // Limit to 20 most recent
      const title = extractXMLTag(itemXml, 'title');
      const description = extractXMLTag(itemXml, 'description');
      const audioUrl = extractXMLAttribute(itemXml, 'enclosure', 'url');
      const pubDate = extractXMLTag(itemXml, 'pubDate');
      const duration = extractXMLTag(itemXml, 'itunes:duration');

      if (!title || !audioUrl) continue;

      episodes.push({
        title: cleanHtmlEntities(title),
        description: cleanDescription(description),
        audio_url: audioUrl,
        published_at: pubDate ? new Date(pubDate) : new Date(),
        duration: parseDuration(duration),
      });
    }

    return episodes;
  } catch (error) {
    console.error('Error fetching preview episodes:', error);
    throw error;
  }
}

function extractXMLTag(xml: string, tag: string): string {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const match = xml.match(regex);
  return match ? match[1].trim() : '';
}

function extractXMLAttribute(xml: string, tag: string, attr: string): string {
  const regex = new RegExp(`<${tag}[^>]*${attr}="([^"]*)"`, 'i');
  const match = xml.match(regex);
  return match ? match[1] : '';
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

  // Remove HTML tags
  cleaned = cleaned.replace(/<[^>]+>/g, ' ');

  // Decode common HTML entities
  cleaned = cleanHtmlEntities(cleaned);

  // Clean up whitespace
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  return cleaned;
}

function cleanHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}
