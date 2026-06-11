import { create } from 'zustand';
import { contentAPI } from '../api';
import type { ContentItem } from '../types';

// Library filter model: two independent dimensions (type × status) plus a
// search query. Shared with queueStore so "Up next" matches the library view.
export type TypeFilter = 'all' | 'articles' | 'texts' | 'podcasts';
export type StatusFilter = 'active' | 'favorites' | 'archived';

export interface LibraryFilter {
  typeFilter: TypeFilter;
  statusFilter: StatusFilter;
  searchQuery: string; // already-debounced value; '' = no search
}

const TYPE_MAP: Record<Exclude<TypeFilter, 'all'>, ContentItem['type']> = {
  articles: 'article',
  texts: 'text',
  podcasts: 'podcast_episode',
};

// Fields covered by search, besides the full body text in `content`.
function metadataFields(item: ContentItem): (string | undefined | null)[] {
  return [item.title, item.author, item.description, item.tags, item.podcast_show_name];
}

// Check if an item should be visible given the current filter.
// Search is plain case-insensitive substring matching (no fuzzy matching).
export function itemMatchesFilter(item: ContentItem, f: LibraryFilter): boolean {
  if (f.typeFilter !== 'all' && item.type !== TYPE_MAP[f.typeFilter]) return false;

  // Status: Active = not archived; Favorites = starred (incl. archived); Archived = archived
  if (f.statusFilter === 'active' && item.is_archived) return false;
  if (f.statusFilter === 'favorites' && !item.is_starred) return false;
  if (f.statusFilter === 'archived' && !item.is_archived) return false;

  const q = f.searchQuery.trim().toLowerCase();
  if (!q) return true;
  return [...metadataFields(item), item.content]
    .some(field => !!field && field.toLowerCase().includes(q));
}

// Returns a short context snippet when the query matches ONLY the body text
// (so the card can show WHY it matched). Null when no snippet should be shown.
export function getSearchSnippet(item: ContentItem, searchQuery: string): string | null {
  const q = searchQuery.trim().toLowerCase();
  if (!q || !item.content) return null;
  if (metadataFields(item).some(field => !!field && field.toLowerCase().includes(q))) return null;
  const idx = item.content.toLowerCase().indexOf(q);
  if (idx < 0) return null;
  const start = Math.max(0, idx - 40);
  const end = Math.min(item.content.length, idx + q.length + 40);
  const text = item.content.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${text}${end < item.content.length ? '…' : ''}`;
}

interface ContentStore {
  // State
  items: ContentItem[];       // filtered view (what the UI renders)
  allItems: ContentItem[];    // master list (all items, fetched once)
  typeFilter: TypeFilter;
  statusFilter: StatusFilter;
  searchQuery: string;
  loading: boolean;
  error: string | null;
  allCount: number; // count of all non-archived items, survives filter changes

  // Actions
  setTypeFilter: (typeFilter: TypeFilter) => void;
  setStatusFilter: (statusFilter: StatusFilter) => void;
  setSearchQuery: (searchQuery: string) => void;
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

export const useContentStore = create<ContentStore>((set, get) => {
  const currentFilter = (): LibraryFilter => {
    const { typeFilter, statusFilter, searchQuery } = get();
    return { typeFilter, statusFilter, searchQuery };
  };

  // Single source of truth: set allItems and re-derive the filtered view + allCount.
  const commit = (allItems: ContentItem[], extra: Record<string, unknown> = {}) => {
    set({
      allItems,
      items: allItems.filter(i => itemMatchesFilter(i, currentFilter())),
      allCount: allItems.filter(i => !i.is_archived).length,
      ...extra,
    });
  };

  return {
    items: [],
    allItems: [],
    typeFilter: 'all',
    statusFilter: 'active',
    searchQuery: '',
    loading: false,
    error: null,
    allCount: 0,

    // Client-side filtering — no API call needed, instant switch
    setTypeFilter: (typeFilter) => {
      set({ typeFilter });
      commit(get().allItems);
    },

    setStatusFilter: (statusFilter) => {
      set({ statusFilter });
      commit(get().allItems);
    },

    setSearchQuery: (searchQuery) => {
      set({ searchQuery });
      commit(get().allItems);
    },

    fetchContent: async () => {
      set({ loading: true, error: null });

      try {
        // Step 1: Fetch non-archived items first (fast — typically ~20 items)
        const activeResponse = await contentAPI.getAll({ archived: false });
        const activeItems = activeResponse.data;

        // Show active items immediately (loading done)
        commit(activeItems, { loading: false });

        // Step 2: Fetch archived items in the background (could be hundreds)
        // so the Archived/Favorites filters work instantly when clicked
        const archivedResponse = await contentAPI.getAll({ archived: true });
        commit([...activeItems, ...archivedResponse.data]);
      } catch (error) {
        console.error('Failed to fetch content:', error);
        set({ error: 'Failed to fetch content', loading: false });
      }
    },

    toggleStarred: async (id) => {
      const item = get().allItems.find(i => i.id === id);
      if (!item) return;

      const newStarredState = !item.is_starred;

      // Optimistic update on master list
      commit(get().allItems.map(i =>
        i.id === id ? { ...i, is_starred: newStarredState } : i
      ));

      try {
        await contentAPI.update(id, { is_starred: newStarredState });
      } catch (error) {
        console.error('Failed to toggle starred:', error);
        // Revert on error
        commit(get().allItems.map(i =>
          i.id === id ? { ...i, is_starred: !newStarredState } : i
        ));
      }
    },

    toggleArchived: async (id) => {
      const item = get().allItems.find(i => i.id === id);
      if (!item) return;

      const newArchivedState = !item.is_archived;

      // Optimistic update on master list
      commit(get().allItems.map(i =>
        i.id === id ? { ...i, is_archived: newArchivedState } : i
      ));

      try {
        // Sync with server (may also affect audio_url for articles)
        const response = await contentAPI.update(id, { is_archived: newArchivedState });
        const updatedItem = response.data;

        commit(get().allItems.map(i => (i.id === id ? updatedItem : i)));
      } catch (error) {
        console.error('Failed to toggle archived:', error);
        // Revert on error - refetch to be safe
        get().fetchContent();
      }
    },

    deleteItem: async (id) => {
      const item = get().allItems.find(i => i.id === id);
      if (!item) return;

      // Optimistic update: remove from master list
      commit(get().allItems.filter(i => i.id !== id));

      try {
        await contentAPI.delete(id);
      } catch (error) {
        console.error('Failed to delete item:', error);
        // Revert on error - add item back
        commit([...get().allItems, item].sort((a, b) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        ));
      }
    },

    updateItem: (id, updates) => {
      commit(get().allItems.map(i => (i.id === id ? { ...i, ...updates } : i)));
    },

    addItem: (item) => {
      commit([item, ...get().allItems]);
    },

    refreshItem: async (id) => {
      try {
        const response = await contentAPI.getById(id);
        commit(get().allItems.map(i => (i.id === id ? response.data : i)));
      } catch (error) {
        console.error('Failed to refresh item:', error);
      }
    },
  };
});
