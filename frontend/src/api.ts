import axios from 'axios';
import type { ContentItem, ContentVersion, Podcast, QueueItem, User, AuthTokens } from './types';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001/api';

const api = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Token management
let accessToken: string | null = localStorage.getItem('accessToken');
let refreshToken: string | null = localStorage.getItem('refreshToken');

export function setTokens(access: string, refresh: string) {
  accessToken = access;
  refreshToken = refresh;
  localStorage.setItem('accessToken', access);
  localStorage.setItem('refreshToken', refresh);
}

export function clearTokens() {
  accessToken = null;
  refreshToken = null;
  localStorage.removeItem('accessToken');
  localStorage.removeItem('refreshToken');
}

export function getAccessToken() {
  return accessToken;
}

// Add auth header to requests
api.interceptors.request.use((config) => {
  if (accessToken) {
    config.headers.Authorization = `Bearer ${accessToken}`;
  }
  return config;
});

// Handle token refresh on 401
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;

    // The read-only demo account gets 403 { demo: true } on any blocked write.
    // Broadcast it so App can show one shared "not available in the demo" toast
    // instead of every caller needing its own handling.
    if (error.response?.status === 403 && error.response?.data?.demo) {
      window.dispatchEvent(new Event('wallacast-demo-blocked'));
    }

    if (error.response?.status === 401 && !originalRequest._retry && refreshToken) {
      originalRequest._retry = true;

      try {
        const response = await axios.post(`${API_BASE_URL}/auth/refresh`, {
          refreshToken,
        });

        const { accessToken: newAccessToken } = response.data;
        accessToken = newAccessToken;
        localStorage.setItem('accessToken', newAccessToken);

        originalRequest.headers.Authorization = `Bearer ${newAccessToken}`;
        return api(originalRequest);
      } catch (refreshError) {
        // Refresh failed, clear tokens. The login page renders at '/', there is no /login route.
        clearTokens();
        window.location.href = '/';
        return Promise.reject(refreshError);
      }
    }

    return Promise.reject(error);
  }
);

export const contentAPI = {
  getAll: (params?: { type?: string; archived?: boolean; starred?: boolean }) =>
    api.get<ContentItem[]>('/content', { params }),

  getById: (id: number) => api.get<ContentItem>(`/content/${id}`),

  // Batch poll for generation/summary status only (a few hundred bytes for the whole
  // batch). Used by the library's 2s poll while items generate, instead of getById per
  // item (which ships the full transcript + 9k word timestamps + alignment every tick).
  // The full item is still fetched once, at completion, via getById/refreshItem.
  getStatuses: (ids: number[]) =>
    api.post<Array<{
      id: number;
      generation_status: ContentItem['generation_status'];
      generation_progress: ContentItem['generation_progress'];
      generation_error: ContentItem['generation_error'];
      current_operation: ContentItem['current_operation'];
      summary_status: ContentItem['summary_status'];
      summary_audio_status: ContentItem['summary_audio_status'];
    }>>('/content/status', { ids }),

  // feed_item_id: the Feed tab's cached row, whose full description the server copies.
  // progress_id: the Add tab's id for fetchProgress below.
  create: (data: Partial<ContentItem> & { feed_item_id?: number; progress_id?: string }) => api.post<ContentItem>('/content', data),

  // What a slow article fetch started with that progress_id is doing (null when nothing yet)
  fetchProgress: (progressId: string) =>
    api.get<{ text: string | null }>(`/content/fetch-progress/${progressId}`),

  update: (id: number, data: Partial<ContentItem>) =>
    api.patch<ContentItem>(`/content/${id}`, data),

  // Save a Markdown/HTML edit of an article/text body. The backend snapshots the previous
  // body + byline metadata into version history, sanitizes, and bumps content_fetched_at
  // (audio is untouched). meta carries only the title/author/published_at fields that
  // changed; null clears a field.
  saveEdit: (id: number, html_content: string, content: string, meta?: { title?: string; author?: string | null; published_at?: string | null }) =>
    api.patch<ContentItem>(`/content/${id}`, { is_edit: true, html_content, content, ...(meta || {}) }),

  // Version history (article/text edit/refetch/restore snapshots)
  listVersions: (id: number) =>
    api.get<ContentVersion[]>(`/content/${id}/versions`),
  getVersion: (id: number, versionId: number) =>
    api.get<ContentVersion>(`/content/${id}/versions/${versionId}`),
  restoreVersion: (id: number, versionId: number) =>
    api.post<{ message: string }>(`/content/${id}/versions/${versionId}/restore`),

  delete: (id: number) => api.delete(`/content/${id}`),

  generateAudio: (id: number, regenerate: boolean = false, excludeComments: boolean = false) =>
    api.post<{ message: string; generation_status: string; generation_progress: number }>(`/content/${id}/generate-audio`, { regenerate, exclude_comments: excludeComments }),

  // generateTranscript: for podcast episodes without a transcript, runs Whisper first,
  // then summarizes (the UI confirms with the user before setting this).
  // generateAudio: explicit true/false overrides the auto_generate_summary_audio setting
  // for the chained summary-audio TTS; undefined follows the setting.
  generateSummary: (id: number, regenerate: boolean = false, generateTranscript: boolean = false, generateAudio?: boolean) =>
    api.post<{ message: string; summary_status: string }>(`/content/${id}/generate-summary`, {
      regenerate,
      generate_transcript: generateTranscript,
      ...(generateAudio !== undefined ? { generate_audio: generateAudio } : {}),
    }),

  // TTS audio of the item's summary (requires an existing summary). Independent
  // summary_audio_status, so it can overlap other generation jobs.
  generateSummaryAudio: (id: number) =>
    api.post<{ message: string; summary_audio_status: string }>(`/content/${id}/generate-summary-audio`, {}),

  bulkAction: (action: 'star' | 'unstar' | 'archive' | 'unarchive' | 'delete' | 'remove_audio' | 'remove_summary', ids: number[]) =>
    api.post<{ affected: number }>('/content/bulk', { action, ids }),
  bulkTagAction: (action: 'add_tags' | 'remove_tags', ids: number[], tags: string[]) =>
    api.post<{ affected: number }>('/content/bulk', { action, ids, tags }),
  allTags: () => api.get<{ tags: { tag: string; count: number }[] }>('/content/tags/all'),
  renameTag: (from: string, to: string) => api.post<{ affected: number }>('/content/tags/rename', { from, to }),
  removeTag: (tag: string) => api.post<{ affected: number }>('/content/tags/remove', { tag }),

  cancelGeneration: (id: number) =>
    api.post<{ message: string }>(`/content/${id}/cancel-generation`),

  refetch: (id: number) =>
    api.post<{ message: string }>(`/content/${id}/refetch`),

  getOriginalHtml: (id: number) =>
    api.get<string>(`/content/${id}/original-html`, { responseType: 'text' as any }),

  exportZip: (id: number) =>
    api.get(`/content/${id}/export`, { responseType: 'arraybuffer' }),

  // Bulk Copy content: one zip with a Markdown file per id, each rendered server-side exactly
  // like the Copy content button (the caller's Copy & export settings apply).
  markdownZip: (ids: number[]) =>
    api.get('/content/markdown-zip', { params: { ids: ids.join(',') }, responseType: 'arraybuffer' }),

  logAudioError: (data: {
    contentId?: number;
    contentType?: string;
    audioUrl?: string;
    errorCode?: number;
    errorMessage?: string | null;
    networkState?: number;
    readyState?: number;
    showName?: string | null;
  }) => api.post('/content/audio-error-log', data),
};

// Status of the latest feed refresh (backend: startFeedRefresh in podcast-service.ts)
export interface FeedRefreshStatus {
  running: boolean;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  totalFeeds?: number;
  totalItemsAdded?: number;
}

export const podcastAPI = {
  getAll: () => api.get<Podcast[]>('/podcasts'),

  search: (query: string) =>
    api.get<Podcast[]>('/podcasts/search', { params: { q: query } }),

  subscribe: (feedUrl: string) =>
    api.post<Podcast>('/podcasts/subscribe', { feed_url: feedUrl }),

  unsubscribe: (id: number) => api.delete<Podcast>(`/podcasts/${id}`),

  // refresh: (id: number) => api.post(`/podcasts/${id}/refresh`), // Removed - auto-added episodes to library

  getPreviewEpisodes: (id: number, limit?: number, offset?: number) =>
    api.get<{ episodes: any[]; hasMore: boolean }>(`/podcasts/${id}/preview-episodes`, { params: { limit, offset } }),

  getPreviewByUrl: (feedUrl: string, limit?: number, offset?: number, signal?: AbortSignal) =>
    api.get<{ episodes: any[]; hasMore: boolean }>('/podcasts/preview-by-url', {
      params: { url: feedUrl, ...(limit !== undefined ? { limit } : {}), ...(offset ? { offset } : {}) },
      signal,
    }),

  searchFeed: (feedUrl: string, query: string) =>
    api.get<any[]>('/podcasts/search-feed', { params: { url: feedUrl, q: query } }),

  // Feed caching endpoints
  getFeedItems: (feedId?: number, limit?: number, offset?: number) =>
    api.get<any[]>('/podcasts/feed-items', { params: { feedId, limit, offset } }),

  // Starts a refresh of every subscribed feed in the background and answers at once. Poll
  // getRefreshStatus until `running` is false.
  refreshFeeds: () =>
    api.post<FeedRefreshStatus>('/podcasts/refresh-feeds'),

  getRefreshStatus: () =>
    api.get<FeedRefreshStatus>('/podcasts/refresh-status'),

  getLastRefresh: () =>
    api.get<{ lastRefresh: string | null }>('/podcasts/last-refresh'),
};

export const queueAPI = {
  getAll: () => api.get<QueueItem[]>('/queue'),

  add: (contentItemId: number) =>
    api.post<{ id: number; position: number; added_at: string }>('/queue', { content_item_id: contentItemId }),

  addToFront: (contentItemId: number) =>
    api.post<{ id: number; position: number; added_at: string }>('/queue/front', { content_item_id: contentItemId }),

  remove: (id: number) => api.delete(`/queue/${id}`),

  reorder: (items: Array<{ id: number; position: number }>) =>
    api.put('/queue/reorder', { items }),

  clear: () => api.delete('/queue'),
};

export const transcriptionAPI = {
  transcribe: (contentId: number) =>
    api.post<{ transcript: string; words?: Array<{ word: string; start: number; end: number }> }>(`/transcription/content/${contentId}`),
};

export const authAPI = {
  login: (username: string, password: string) =>
    api.post<AuthTokens>('/auth/login', { username, password }),

  register: (username: string, password: string, displayName?: string, email?: string, inviteCode?: string) =>
    api.post<AuthTokens>('/auth/register', { username, password, displayName, email, inviteCode }),

  // Public instance config for the logged-out UI (whether registration needs an invite code).
  getConfig: () => api.get<{ inviteRequired: boolean }>('/auth/config'),

  // Email-based password reset (503 when the instance has no email service configured).
  forgotPassword: (username: string) =>
    api.post<{ message: string }>('/auth/forgot-password', { username }),

  resetPassword: (token: string, newPassword: string) =>
    api.post<{ success: boolean; message?: string }>('/auth/reset-password', { token, newPassword }),

  // Passwordless login into the shared read-only demo account (404 when no demo
  // account exists on this instance).
  demoLogin: () => api.post<AuthTokens>('/auth/demo'),

  logout: () => {
    const token = refreshToken;
    clearTokens();
    return api.post('/auth/logout', { refreshToken: token });
  },

  getMe: () => api.get<{ user: User }>('/auth/me'),

  changePassword: (currentPassword: string, newPassword: string) =>
    api.post('/auth/change-password', { currentPassword, newPassword }),

  // API tokens (Settings). The raw token is in the create response only. A token can do only
  // what its permissions allow, within its own limits, and these routes accept a normal login
  // only, so a token can never change itself.
  listTokens: () => api.get<{ tokens: ApiToken[]; max_limits: TokenLimits }>('/auth/tokens'),
  createToken: (name: string) =>
    api.post<{ id: number; name: string; token: string }>('/auth/tokens', { name }),
  revokeToken: (id: number) => api.delete<{ success: boolean }>(`/auth/tokens/${id}`),
  // Each part is optional. Answers the updated token, 400 with { error } on invalid input.
  updateToken: (id: number, patch: ApiTokenPatch) =>
    api.patch<ApiTokenSettings>(`/auth/tokens/${id}`, patch),
  // Usage counts from now on, and the last limit hit is cleared.
  resetTokenUsage: (id: number) => api.post<{ success: boolean }>(`/auth/tokens/${id}/reset-usage`),
  // The token's tag and star changes, newest first (max 200).
  listTokenChanges: (id: number) => api.get<{ changes: TokenChange[] }>(`/auth/tokens/${id}/changes`),
  undoTokenChanges: (id: number, body: { ids: number[] } | { all: true }) =>
    api.post<{ undone: number }>(`/auth/tokens/${id}/changes/undo`, body),
  // Tokens that hit a limit since the notice was last dismissed, and dismissing it.
  tokenAlerts: () => api.get<{ alerts: TokenAlert[] }>('/auth/tokens/alerts'),
  markTokenAlertsSeen: () => api.post<{ success: boolean }>('/auth/tokens/alerts/seen'),
};

// What a token may do. add_any and add_feed exclude each other.
export type TokenPermission = 'read_library' | 'feed' | 'add_any' | 'add_feed' | 'tag' | 'star';

// Per-token limits on items added and minutes of AI generation started, in rolling windows.
export interface TokenLimits {
  items_hour: number;
  items_2d: number;
  minutes_hour: number;
  minutes_2d: number;
}

// What is generated for items a token adds. With follow on, the app's auto-generation
// settings decide and the four flags are ignored.
export interface TokenGeneration {
  follow: boolean;
  audio: boolean;
  summary: boolean;
  summary_audio: boolean;
  transcribe: boolean;
}

// Usage inside the limit windows since the last reset. Minutes may have one decimal.
export interface TokenUsage extends TokenLimits {
  changes_hour: number;
}

// One live API token as PATCH /auth/tokens/:id answers it (never the token value itself).
export interface ApiTokenSettings {
  id: number;
  name: string;
  created_at: string;
  last_used_at: string | null;
  permissions: TokenPermission[];
  limits: TokenLimits;
  generation: TokenGeneration;
  usage_reset_at: string | null;
  limit_hit: string | null;
  limit_hit_at: string | null;
}

// One live API token as listed by GET /auth/tokens, with its usage and the number of tag and
// star changes that are not undone.
export interface ApiToken extends ApiTokenSettings {
  usage: TokenUsage;
  open_changes: number;
}

export interface ApiTokenPatch {
  permissions?: TokenPermission[];
  limits?: Partial<TokenLimits>;
  generation?: Partial<TokenGeneration>;
}

// One tag or star change a token made. title is null when the item was deleted since.
export interface TokenChange {
  id: number;
  kind: 'tag_add' | 'star' | 'unstar';
  tag: string | null;
  content_item_id: number | null;
  title: string | null;
  created_at: string;
  undone_at: string | null;
}

export interface TokenAlert {
  id: number;
  name: string;
  limit_hit: string;
  limit_hit_at: string;
}

export const userSettingsAPI = {
  getAll: () => api.get<{ settings: Record<string, string | null> }>('/users/settings'),

  get: (key: string) => api.get<{ value: string | null; isSet?: boolean }>(`/users/settings/${key}`),

  set: (key: string, value: string) => api.put(`/users/settings/${key}`, { value }),

  setBulk: (settings: Record<string, string>) => api.put('/users/settings', { settings }),

  delete: (key: string) => api.delete(`/users/settings/${key}`),

  // The full registry of editable LLM prompts (grouped by category) with their built-in defaults.
  getPrompts: () => api.get<{ prompts: PromptDef[] }>('/users/prompts'),
};

// One editable LLM prompt as described by the backend registry (services/prompt-registry.ts).
export interface PromptVar { token: string; desc: string; }
export interface PromptDef {
  id: string;
  category: string;
  label: string;
  description: string;
  vars: PromptVar[];
  default: string;
}

export const wallabagAPI = {
  testConnection: () =>
    api.post<{ success: boolean; error?: string }>('/wallabag/test'),

  getStatus: () =>
    api.get<{ enabled: boolean; lastSync: string | null; pendingChanges: number }>('/wallabag/status'),

  sync: () =>
    api.post<{ pulled: number; pushed: number; errors: string[] }>('/wallabag/sync'),

  pull: () =>
    api.post<{ pulled: number; errors: string[] }>('/wallabag/pull'),

  fullRefresh: () =>
    api.post<{ pulled: number; errors: string[] }>('/wallabag/pull?full=true'),

  push: () =>
    api.post<{ pushed: number; errors: string[] }>('/wallabag/push'),

  cleanup: (hoursAgo?: number) =>
    api.post<{ deleted: number; message: string }>('/wallabag/cleanup', { hoursAgo }),
};
