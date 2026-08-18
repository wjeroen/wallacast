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
  content_alignment?: string; // JSON string of content-to-transcript alignment data
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
  comment_count?: number; // Number of top-level comments (from list endpoint, avoids loading full JSON)
  // Where the comments came from (migration 017). Returned only by GET /:id. Null for
  // older items fetched before the column existed, callers fall back to URL detection.
  comment_source?: 'ea_forum' | 'lesswrong' | 'substack' | null;
  is_starred: boolean;  // Renamed from is_favorite (Wallabag: starred)
  is_archived: boolean;
  tags?: string;  // Comma-separated tags (Wallabag style)
  content_source?: 'wallabag' | 'wallacast';  // Who fetched the content
  wallabag_id?: number;  // ID in Wallabag (for sync)
  wallabag_updated_at?: string;  // Last update in Wallabag (for conflict resolution)
  playback_position: number;
  // Deprecated: per-item speed is no longer used. Global playback speed lives in
  // user settings + localStorage since migration 011. Kept for backward compatibility
  // with the API payload.
  playback_speed: number;
  last_played_at?: string;
  generation_status?: 'idle' | 'starting' | 'fetching' | 'extracting_content' | 'content_ready' | 'generating_audio' | 'generating_transcript' | 'ready' | 'completed' | 'failed';
  generation_progress?: number;
  generation_error?: string;
  current_operation?: 'initialization' | 'content_extraction' | 'audio_generation' | 'concatenating_audio' | 'audio' | 'transcript' | string;
  created_at: string;
  updated_at: string;
  content_fetched_at?: string; // When the article was last fetched/refetched from the web
  audio_generated_at?: string; // When TTS narration was last generated
  // Summaries (Twitter-thread style). Generated independently of audio.
  summary?: string; // Article-body summary (paragraphs separated by blank lines)
  comment_summary?: string; // Comment-discussion summary (optional)
  summary_status?: 'idle' | 'generating' | 'completed' | 'failed';
  summary_generated_at?: string; // When the summary was last generated
  summary_error?: string; // Error message when summary_status === 'failed' (shown on cards)
  // Summary audio: TTS of the summary as a second independent audio (no read-along).
  summary_audio_url?: string; // Our audio endpoint with ?variant=summary (+ token, added at serialization)
  summary_audio_duration?: number; // Seconds
  summary_audio_status?: 'idle' | 'generating' | 'completed' | 'failed';
  summary_audio_error?: string; // Error message when summary_audio_status === 'failed'
  summary_audio_generated_at?: string; // Also the cache-buster for the summary audio URL
  summary_playback_position?: number; // Separate saved position, never mixed with playback_position
  versions_count?: number; // Number of history snapshots. GET /:id only; gates the History tab instantly (the version list itself still loads async)
}

// A snapshot of an article/text body saved before an edit/refetch/restore (version history).
export interface ContentVersion {
  id: number;
  source: 'fetch' | 'refetch' | 'edit' | 'restore' | 'sync';
  title?: string;
  author?: string | null;       // null on snapshots from before migration 024
  published_at?: string | null; // null on snapshots from before migration 024
  created_at: string;
  html_bytes?: number;      // present in the lean list response
  has_comments?: boolean;   // present in the lean list response
  html_content?: string;    // present when fetching a single version
  content?: string;
  comments?: Comment[] | string;
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
  // RSS feed type. The DB column still permits 'blog', but nothing writes it
  // (detectFeedType only ever returns 'podcast' or 'newsletter'), so it is left
  // out of this union.
  type?: 'podcast' | 'newsletter';
  is_subscribed: boolean;
  last_fetched_at?: string;
  created_at: string;
  updated_at: string;
}

/**
 * Manual queue item returned from GET /queue. The backend joins queue_items
 * with content_items and aliases the queue columns (queue_id / queue_position /
 * queue_added_at) so they don't collide with the ContentItem fields spread in.
 */
export interface QueueItem extends ContentItem {
  queue_id: number;
  queue_position: number;
  queue_added_at: string;
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
  // True when this session is the shared read-only demo account (computed by the
  // backend from DEMO_USERNAME, never stored in the users table).
  demo?: boolean;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  user: User;
}
