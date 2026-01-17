import axios from 'axios';
import type { ContentItem, Podcast, QueueItem, User, AuthTokens } from './types';

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
        // Refresh failed, clear tokens
        clearTokens();
        window.location.href = '/login';
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

  create: (data: Partial<ContentItem>) => api.post<ContentItem>('/content', data),

  update: (id: number, data: Partial<ContentItem>) =>
    api.patch<ContentItem>(`/content/${id}`, data),

  delete: (id: number) => api.delete(`/content/${id}`),

  generateAudio: (id: number, regenerate: boolean = false) =>
    api.post<{ message: string; generation_status: string; generation_progress: number }>(`/content/${id}/generate-audio`, { regenerate }),
};

export const podcastAPI = {
  getAll: () => api.get<Podcast[]>('/podcasts'),

  search: (query: string) =>
    api.get<Podcast[]>('/podcasts/search', { params: { q: query } }),

  subscribe: (feedUrl: string) =>
    api.post<Podcast>('/podcasts/subscribe', { feed_url: feedUrl }),

  unsubscribe: (id: number) => api.delete<Podcast>(`/podcasts/${id}`),

  refresh: (id: number) => api.post(`/podcasts/${id}/refresh`),

  getEpisodes: (id: number) => api.get<ContentItem[]>(`/podcasts/${id}/episodes`),

  getPreviewEpisodes: (id: number) => api.get<any[]>(`/podcasts/${id}/preview-episodes`),
};

export const queueAPI = {
  getAll: () => api.get<QueueItem[]>('/queue'),

  add: (contentItemId: number) =>
    api.post<QueueItem>('/queue', { content_item_id: contentItemId }),

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

  getAIProviders: () => api.get<{ providers: Record<string, any> }>('/users/ai-providers'),
};

export const wallabagAPI = {
  testConnection: () =>
    api.post<{ success: boolean; error?: string }>('/wallabag/test'),

  getStatus: () =>
    api.get<{ enabled: boolean; lastSync: string | null; pendingChanges: number }>('/wallabag/status'),

  sync: () =>
    api.post<{ pulled: number; pushed: number; errors: string[] }>('/wallabag/sync'),

  pull: () =>
    api.post<{ pulled: number; errors: string[] }>('/wallabag/pull'),

  push: () =>
    api.post<{ pushed: number; errors: string[] }>('/wallabag/push'),
};
