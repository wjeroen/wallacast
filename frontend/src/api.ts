import axios from 'axios';
import type { ContentItem, Podcast, QueueItem } from './types';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001/api';

const api = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
  withCredentials: true, // Include credentials for HTTP Basic Auth
});

export const contentAPI = {
  getAll: (params?: { type?: string; archived?: boolean; favorite?: boolean }) =>
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
