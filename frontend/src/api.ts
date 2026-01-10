import axios from 'axios';
import type { ContentItem, Podcast, QueueItem, Settings } from './types';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001/api';

const api = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

export const contentAPI = {
  getAll: (params?: { type?: string; archived?: boolean; favorite?: boolean }) =>
    api.get<ContentItem[]>('/content', { params }),

  getById: (id: number) => api.get<ContentItem>(`/content/${id}`),

  create: (data: Partial<ContentItem>) => api.post<ContentItem>('/content', data),

  update: (id: number, data: Partial<ContentItem>) =>
    api.patch<ContentItem>(`/content/${id}`, data),

  delete: (id: number) => api.delete(`/content/${id}`),

  generateAudio: (id: number) => api.post<{ audio_url: string }>(`/content/${id}/generate-audio`),
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
    api.post<{ transcript: string }>(`/transcription/content/${contentId}`),
};

export const settingsAPI = {
  getAll: () => api.get<Settings>('/settings'),

  get: (key: string) => api.get<{ key: string; value: string }>(`/settings/${key}`),

  update: (key: string, value: string) =>
    api.put<{ key: string; value: string }>(`/settings/${key}`, { value }),
};
