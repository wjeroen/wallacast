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
    }>>('/content/status', { ids }),

  create: (data: Partial<ContentItem>) => api.post<ContentItem>('/content', data),

  update: (id: number, data: Partial<ContentItem>) =>
    api.patch<ContentItem>(`/content/${id}`, data),

  // Save a Markdown/HTML edit of an article/text body. The backend snapshots the previous
  // body into version history, sanitizes, and bumps content_fetched_at (audio is untouched).
  saveEdit: (id: number, html_content: string, content: string) =>
    api.patch<ContentItem>(`/content/${id}`, { is_edit: true, html_content, content }),

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
  // then summarizes (the UI confirms with the user before setting this)
  generateSummary: (id: number, regenerate: boolean = false, generateTranscript: boolean = false) =>
    api.post<{ message: string; summary_status: string }>(`/content/${id}/generate-summary`, { regenerate, generate_transcript: generateTranscript }),

  bulkAction: (action: 'star' | 'unstar' | 'archive' | 'unarchive' | 'delete' | 'remove_audio' | 'remove_summary', ids: number[]) =>
    api.post<{ affected: number }>('/content/bulk', { action, ids }),

  cancelGeneration: (id: number) =>
    api.post<{ message: string }>(`/content/${id}/cancel-generation`),

  refetch: (id: number) =>
    api.post<{ message: string }>(`/content/${id}/refetch`),

  getOriginalHtml: (id: number) =>
    api.get<string>(`/content/${id}/original-html`, { responseType: 'text' as any }),

  exportZip: (id: number) =>
    api.get(`/content/${id}/export`, { responseType: 'arraybuffer' }),

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

  refreshFeeds: () =>
    api.post<{ totalFeeds: number; totalItemsAdded: number }>('/podcasts/refresh-feeds'),

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

  register: (username: string, password: string, displayName?: string, email?: string) =>
    api.post<AuthTokens>('/auth/register', { username, password, displayName, email }),

  logout: () => {
    const token = refreshToken;
    clearTokens();
    return api.post('/auth/logout', { refreshToken: token });
  },

  getMe: () => api.get<{ user: User }>('/auth/me'),

  changePassword: (currentPassword: string, newPassword: string) =>
    api.post('/auth/change-password', { currentPassword, newPassword }),
};

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
