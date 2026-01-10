export interface ContentItem {
  id: number;
  type: 'article' | 'podcast_episode' | 'pdf' | 'text';
  title: string;
  url?: string;
  content?: string;
  html_content?: string;
  author?: string;
  description?: string;
  thumbnail_url?: string;
  audio_url?: string;
  transcript?: string;
  duration?: number;
  file_size?: number;
  podcast_id?: number;
  episode_number?: number;
  published_at?: string;
  is_favorite: boolean;
  is_archived: boolean;
  is_read: boolean;
  playback_position: number;
  playback_speed: number;
  last_played_at?: string;
  created_at: string;
  updated_at: string;
}

export interface Podcast {
  id: number;
  title: string;
  author?: string;
  description?: string;
  feed_url: string;
  website_url?: string;
  thumbnail_url?: string;
  category?: string;
  language?: string;
  is_subscribed: boolean;
  last_fetched_at?: string;
  created_at: string;
  updated_at: string;
}

export interface QueueItem {
  id: number;
  content_item_id: number;
  position: number;
  added_at: string;
}

export interface Settings {
  [key: string]: string;
}
