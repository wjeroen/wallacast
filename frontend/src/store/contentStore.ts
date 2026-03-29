import { create } from 'zustand';
import { contentAPI } from '../api';
import type { ContentItem } from '../types';

// Filter types matching LibraryTab
export type FilterType = 'all' | 'articles' | 'texts' | 'podcasts' | 'favorites' | 'archived';

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
  items: ContentItem[];       // filtered view (what the UI renders)
  allItems: ContentItem[];    // master list (all items, fetched once)
  filter: FilterType;
  loading: boolean;
  error: string | null;
  allCount: number; // count of all non-archived items, survives filter changes

  // Actions
  setFilter: (filter: FilterType) => void;
  fetchContent: () => Promise<void>;

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
  allItems: [],
  filter: 'all',
  loading: false,
  error: null,
  allCount: 0,

  setFilter: (filter) => {
    // Client-side filtering — no API call needed, instant switch
    const filtered = get().allItems.filter(i => itemMatchesFilter(i, filter));
    set({ filter, items: filtered });
  },

  fetchContent: async () => {
    set({ loading: true, error: null });

    try {
      // Always fetch everything (non-archived + archived) in one call, filter client-side
      const response = await contentAPI.getAll();
      const allItems = response.data;
      const currentFilter = get().filter;
      const filtered = allItems.filter(i => itemMatchesFilter(i, currentFilter));
      const allCount = allItems.filter(i => !i.is_archived).length;
      set({ allItems, items: filtered, loading: false, allCount });
    } catch (error) {
      console.error('Failed to fetch content:', error);
      set({ error: 'Failed to fetch content', loading: false });
    }
  },

  toggleStarred: async (id) => {
    const { allItems, filter } = get();
    const item = allItems.find(i => i.id === id);
    if (!item) return;

    const newStarredState = !item.is_starred;

    // Optimistic update on master list, then derive filtered view
    const newAllItems = allItems.map(i =>
      i.id === id ? { ...i, is_starred: newStarredState } : i
    );
    set({
      allItems: newAllItems,
      items: newAllItems.filter(i => itemMatchesFilter(i, filter)),
    });

    try {
      await contentAPI.update(id, { is_starred: newStarredState });
    } catch (error) {
      console.error('Failed to toggle starred:', error);
      // Revert on error
      const reverted = get().allItems.map(i =>
        i.id === id ? { ...i, is_starred: !newStarredState } : i
      );
      set({
        allItems: reverted,
        items: reverted.filter(i => itemMatchesFilter(i, filter)),
      });
    }
  },

  toggleArchived: async (id) => {
    const { allItems, filter } = get();
    const item = allItems.find(i => i.id === id);
    if (!item) return;

    const newArchivedState = !item.is_archived;

    // Optimistic update on master list
    const newAllItems = allItems.map(i =>
      i.id === id ? { ...i, is_archived: newArchivedState } : i
    );
    const newAllCount = newAllItems.filter(i => !i.is_archived).length;
    set({
      allItems: newAllItems,
      items: newAllItems.filter(i => itemMatchesFilter(i, filter)),
      allCount: newAllCount,
    });

    try {
      // Sync with server (may also affect audio_url for articles)
      const response = await contentAPI.update(id, { is_archived: newArchivedState });
      const updatedItem = response.data;

      const updatedAllItems = get().allItems.map(i =>
        i.id === id ? updatedItem : i
      );
      set({
        allItems: updatedAllItems,
        items: updatedAllItems.filter(i => itemMatchesFilter(i, filter)),
      });
    } catch (error) {
      console.error('Failed to toggle archived:', error);
      // Revert on error - refetch to be safe
      get().fetchContent();
    }
  },

  deleteItem: async (id) => {
    const { allItems, filter } = get();
    const item = allItems.find(i => i.id === id);
    if (!item) return;

    // Optimistic update: remove from master list
    const newAllItems = allItems.filter(i => i.id !== id);
    set({
      allItems: newAllItems,
      items: newAllItems.filter(i => itemMatchesFilter(i, filter)),
      allCount: newAllItems.filter(i => !i.is_archived).length,
    });

    try {
      await contentAPI.delete(id);
    } catch (error) {
      console.error('Failed to delete item:', error);
      // Revert on error - add item back
      const reverted = [...get().allItems, item].sort((a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      );
      set({
        allItems: reverted,
        items: reverted.filter(i => itemMatchesFilter(i, filter)),
        allCount: reverted.filter(i => !i.is_archived).length,
      });
    }
  },

  updateItem: (id, updates) => {
    const { filter } = get();
    const newAllItems = get().allItems.map(i =>
      i.id === id ? { ...i, ...updates } : i
    );
    set({
      allItems: newAllItems,
      items: newAllItems.filter(i => itemMatchesFilter(i, filter)),
    });
  },

  addItem: (item) => {
    const { allItems, filter } = get();
    const newAllItems = [item, ...allItems];
    set({
      allItems: newAllItems,
      items: newAllItems.filter(i => itemMatchesFilter(i, filter)),
      allCount: newAllItems.filter(i => !i.is_archived).length,
    });
  },

  refreshItem: async (id) => {
    try {
      const response = await contentAPI.getById(id);
      const { filter } = get();
      const newAllItems = get().allItems.map(i =>
        i.id === id ? response.data : i
      );
      set({
        allItems: newAllItems,
        items: newAllItems.filter(i => itemMatchesFilter(i, filter)),
      });
    } catch (error) {
      console.error('Failed to refresh item:', error);
    }
  },
}));
