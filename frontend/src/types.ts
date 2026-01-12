export interface Comment {
  username: string;
  date?: string;
  karma?: number;
  agree_votes?: number;
  disagree_votes?: number;
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
  thumbnail_url?: string;
  audio_url?: string;
  transcript?: string;
  transcript_words?: string; // JSON string of word timestamps
  tts_chunks?: string; // JSON string of TTS chunk metadata
  duration?: number;
  file_size?: number;
  podcast_id?: number;
  episode_number?: number;
  published_at?: string;
  karma?: number; // EA Forum karma/upvotes
  agree_votes?: number; // EA Forum agree votes
  disagree_votes?: number; // EA Forum disagree votes
  comments?: Comment[]; // Parsed comments with metadata
  is_favorite: boolean;
  is_archived: boolean;
  is_read: boolean;
  playback_position: number;
  playback_speed: number;
  last_played_at?: string;
  generation_status?: 'idle' | 'starting' | 'extracting_content' | 'content_ready' | 'generating_audio' | 'generating_transcript' | 'completed' | 'failed';
  generation_progress?: number;
  generation_error?: string;
  current_operation?: 'initialization' | 'content_extraction' | 'audio_generation' | 'audio' | 'transcript';
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
