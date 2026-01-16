import { create } from 'zustand';
import { contentAPI } from '../api';
import type { ContentItem } from '../types';

// Filter types matching LibraryTab
export type FilterType = 'all' | 'articles' | 'texts' | 'podcasts' | 'favorites' | 'archived';

// Convert filter to API params
function filterToParams(filter: FilterType): { type?: string; archived?: boolean; starred?: boolean } {
  switch (filter) {
    case 'articles':
      return { type: 'article' };
    case 'texts':
      return { type: 'text' };
    case 'podcasts':
      return { type: 'podcast_episode' };
    case 'favorites':
      return { starred: true };
    case 'archived':
      return { archived: true };
    case 'all':
    default:
      return { archived: false }; // Exclude archived by default
  }
}

// Check if an item should be visible given the current filter
function itemMatchesFilter(item: ContentItem, filter: FilterType): boolean {
  switch (filter) {
    case 'articles':
      return item.type === 'article' && !item.is_archived;
    case 'texts':
      return item.type === 'text' && !item.is_archived;
    case 'podcasts':
      return item.type === 'podcast_episode' && !item.is_archived;
    case 'favorites':
      return item.is_starred;
    case 'archived':
      return item.is_archived;
    case 'all':
    default:
      return !item.is_archived;
  }
}

interface ContentStore {
  // State
  items: ContentItem[];
  filter: FilterType;
  loading: boolean;
  error: string | null;

  // Actions
  setFilter: (filter: FilterType) => void;
  fetchContent: (filter?: FilterType) => Promise<void>;

  // Optimistic updates - update UI immediately, then sync with server
  toggleStarred: (id: number) => Promise<void>;
  toggleArchived: (id: number) => Promise<void>;
  deleteItem: (id: number) => Promise<void>;

  // For background updates (generation status polling)
  updateItem: (id: number, updates: Partial<ContentItem>) => void;

  // For adding new content
  addItem: (item: ContentItem) => void;

  // Refresh single item from server (for generation completion)
  refreshItem: (id: number) => Promise<void>;
}

export const useContentStore = create<ContentStore>((set, get) => ({
  items: [],
  filter: 'all',
  loading: false,
  error: null,

  setFilter: (filter) => {
    set({ filter });
    // Fetch content with new filter
    get().fetchContent(filter);
  },

  fetchContent: async (filter?: FilterType) => {
    const currentFilter = filter ?? get().filter;
    set({ loading: true, error: null });

    try {
      const params = filterToParams(currentFilter);
      const response = await contentAPI.getAll(params);
      set({ items: response.data, loading: false });
    } catch (error) {
      console.error('Failed to fetch content:', error);
      set({ error: 'Failed to fetch content', loading: false });
    }
  },

  toggleStarred: async (id) => {
    const { items, filter } = get();
    const item = items.find(i => i.id === id);
    if (!item) return;

    const newStarredState = !item.is_starred;

    // Optimistic update: update item immediately
    set({
      items: items.map(i =>
        i.id === id ? { ...i, is_starred: newStarredState } : i
      ).filter(i => itemMatchesFilter(i, filter)) // Remove if no longer matches filter
    });

    try {
      // Sync with server
      await contentAPI.update(id, { is_starred: newStarredState });
    } catch (error) {
      console.error('Failed to toggle starred:', error);
      // Revert on error
      set({
        items: get().items.map(i =>
          i.id === id ? { ...i, is_starred: !newStarredState } : i
        )
      });
    }
  },

  toggleArchived: async (id) => {
    const { items, filter } = get();
    const item = items.find(i => i.id === id);
    if (!item) return;

    const newArchivedState = !item.is_archived;

    // Optimistic update: remove from current view (archived items leave 'all', unarchived leave 'archived')
    set({
      items: items.map(i =>
        i.id === id ? { ...i, is_archived: newArchivedState } : i
      ).filter(i => itemMatchesFilter(i, filter))
    });

    try {
      // Sync with server (this may also affect audio_url for articles)
      const response = await contentAPI.update(id, { is_archived: newArchivedState });

      // Update with server response (may have audio changes)
      const updatedItem = response.data;
      set({
        items: get().items.map(i =>
          i.id === id ? updatedItem : i
        ).filter(i => itemMatchesFilter(i, filter))
      });
    } catch (error) {
      console.error('Failed to toggle archived:', error);
      // Revert on error - refetch to be safe
      get().fetchContent();
    }
  },

  deleteItem: async (id) => {
    const { items } = get();
    const item = items.find(i => i.id === id);
    if (!item) return;

    // Optimistic update: remove immediately
    set({ items: items.filter(i => i.id !== id) });

    try {
      await contentAPI.delete(id);
    } catch (error) {
      console.error('Failed to delete item:', error);
      // Revert on error - add item back
      set({ items: [...get().items, item].sort((a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      )});
    }
  },

  updateItem: (id, updates) => {
    set({
      items: get().items.map(i =>
        i.id === id ? { ...i, ...updates } : i
      )
    });
  },

  addItem: (item) => {
    const { items, filter } = get();
    // Add at the beginning (most recent)
    const newItems = [item, ...items];
    // Only show if it matches current filter
    set({ items: newItems.filter(i => itemMatchesFilter(i, filter)) });
  },

  refreshItem: async (id) => {
    try {
      const response = await contentAPI.getById(id);
      const { filter } = get();
      set({
        items: get().items.map(i =>
          i.id === id ? response.data : i
        ).filter(i => itemMatchesFilter(i, filter))
      });
    } catch (error) {
      console.error('Failed to refresh item:', error);
    }
  },
}));
