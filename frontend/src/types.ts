export interface Comment {
  username: string;
  date?: string;
  karma?: number;
  extendedScore?: Record<string, number>; // Dynamic reactions (agree, disagree, love, etc.)
  content: string;
  replies?: Comment[];
}

export interface ContentItem {
  id: number;
  type: 'article' | 'podcast_episode' | 'pdf' | 'text';
  title: string;
  url?: string;
  content?: string;
  html_content?: string;
  author?: string;
  description?: string;
  preview_picture?: string;  // Renamed from thumbnail_url (Wallabag compatibility)
  audio_url?: string;
  transcript?: string;
  transcript_words?: string; // JSON string of word timestamps
  tts_chunks?: string; // JSON string of TTS chunk metadata
  duration?: number;
  file_size?: number;
  podcast_id?: number;
  podcast_show_name?: string; // Display name of the podcast show for episodes
  episode_number?: number;
  published_at?: string;
  karma?: number; // EA Forum karma/upvotes
  agree_votes?: number; // EA Forum agree votes
  disagree_votes?: number; // EA Forum disagree votes
  comments?: Comment[]; // Parsed comments with metadata
  is_starred: boolean;  // Renamed from is_favorite (Wallabag: starred)
  is_archived: boolean;
  tags?: string;  // Comma-separated tags (Wallabag style)
  content_source?: 'wallabag' | 'wallacast';  // Who fetched the content
  wallabag_id?: number;  // ID in Wallabag (for sync)
  wallabag_updated_at?: string;  // Last update in Wallabag (for conflict resolution)
  playback_position: number;
  playback_speed: number;
  last_played_at?: string;
  generation_status?: 'idle' | 'starting' | 'extracting_content' | 'content_ready' | 'generating_audio' | 'generating_transcript' | 'completed' | 'failed';
  generation_progress?: number;
  generation_error?: string;
  current_operation?: 'initialization' | 'content_extraction' | 'audio_generation' | 'concatenating_audio' | 'audio' | 'transcript' | string;
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
  preview_picture?: string;  // Renamed from thumbnail_url (Wallabag compatibility)
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

export interface User {
  id: number;
  username: string;
  email: string | null;
  display_name: string | null;
  is_active: boolean;
  created_at: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  user: User;
}
