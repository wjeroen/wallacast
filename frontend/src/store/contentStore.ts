import { create } from 'zustand';
import { contentAPI } from '../api';
import type { ContentItem } from '../types';

// Library filter model: content type × five combinable facet rows plus a
// search query. Shared with queueStore so "Up next" matches the library view.
export type TypeFilter = 'all' | 'articles' | 'texts' | 'podcasts';

// One facet per row of the library filter grid. Each row is either one of its
// two mutually exclusive options or null (no preference). Rows combine with AND.
export interface FacetFilter {
  archive: 'active' | 'archived' | null;
  star: 'starred' | 'unstarred' | null;
  audio: 'audio' | 'no_audio' | null;
  summary: 'summary' | 'no_summary' | null;
  transcript: 'transcript' | 'no_transcript' | null;
}

export type FacetDim = keyof FacetFilter;
export type FacetValue = NonNullable<FacetFilter[FacetDim]>;

export const DEFAULT_FACETS: FacetFilter = {
  archive: 'active',
  star: null,
  audio: null,
  summary: null,
  transcript: null,
};

export interface LibraryFilter {
  typeFilter: TypeFilter;
  facets: FacetFilter;
  // Selected tags. An item matches when it carries ANY of them ("any of", like the
  // one-of-many facet rows); empty = no tag filter.
  tags: string[];
  searchQuery: string; // already-debounced value; '' = no search
}

const TYPE_MAP: Record<Exclude<TypeFilter, 'all'>, ContentItem['type']> = {
  articles: 'article',
  texts: 'text',
  podcasts: 'podcast_episode',
};

// Persist the chosen filters (type + facets + sort direction, NOT the transient
// search query) per device, so a refresh or app restart reopens the library
// exactly as you left it. Same localStorage pattern as 'wallacast-theme'.
// Stored values are validated on load so a stale or corrupted entry falls back
// to the defaults instead of wedging the library view.
const FILTERS_STORAGE_KEY = 'wallacast-filters';

// Sort direction for the library list (and therefore the queue's "Up next"
// stream, which reads allItems). 'desc' = newest added first (the default).
export type SortDir = 'desc' | 'asc';

const FACET_VALUES: Record<FacetDim, [FacetValue, FacetValue]> = {
  archive: ['active', 'archived'],
  star: ['starred', 'unstarred'],
  audio: ['audio', 'no_audio'],
  summary: ['summary', 'no_summary'],
  transcript: ['transcript', 'no_transcript'],
};

interface StoredFilters {
  typeFilter: TypeFilter;
  facets: FacetFilter;
  tags: string[];
  sortDir: SortDir;
}

function loadStoredFilters(): StoredFilters {
  const fallback: StoredFilters = { typeFilter: 'all', facets: DEFAULT_FACETS, tags: [], sortDir: 'desc' };
  try {
    const raw = localStorage.getItem(FILTERS_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    const typeFilter: TypeFilter = ['all', 'articles', 'texts', 'podcasts'].includes(parsed?.typeFilter)
      ? parsed.typeFilter
      : 'all';
    const facets: FacetFilter = { ...DEFAULT_FACETS };
    for (const dim of Object.keys(FACET_VALUES) as FacetDim[]) {
      const v = parsed?.facets?.[dim];
      facets[dim] = v === null || FACET_VALUES[dim].includes(v) ? v : DEFAULT_FACETS[dim];
    }
    const tags: string[] = Array.isArray(parsed?.tags)
      ? parsed.tags.filter((t: unknown): t is string => typeof t === 'string' && t.length > 0)
      : [];
    const sortDir: SortDir = parsed?.sortDir === 'asc' ? 'asc' : 'desc';
    return { typeFilter, facets, tags, sortDir };
  } catch {
    return fallback; // private mode / corrupted JSON
  }
}

function storeFilters(f: StoredFilters): void {
  try {
    localStorage.setItem(FILTERS_STORAGE_KEY, JSON.stringify(f));
  } catch { /* private mode */ }
}

// Canonical library ordering: date added (created_at). Applied in commit() so
// EVERY consumer of allItems (library list, continue strip source, and the
// queue's "Up next" stream in queueStore) follows the same direction.
function sortByDateAdded(items: ContentItem[], dir: SortDir): ContentItem[] {
  return [...items].sort((a, b) => {
    const ta = a.created_at ? new Date(a.created_at).getTime() : 0;
    const tb = b.created_at ? new Date(b.created_at).getTime() : 0;
    return dir === 'asc' ? ta - tb : tb - ta;
  });
}

// Fields covered by search, besides the full body text in `content`.
function metadataFields(item: ContentItem): (string | undefined | null)[] {
  return [item.title, item.author, item.description, item.tags?.join(' '), item.podcast_show_name];
}

// Check if an item should be visible given the current filter.
// Search is plain case-insensitive substring matching (no fuzzy matching).
export function itemMatchesFilter(item: ContentItem, f: LibraryFilter): boolean {
  if (f.typeFilter !== 'all' && item.type !== TYPE_MAP[f.typeFilter]) return false;

  // Tag filter: any selected tag present on the item.
  if (f.tags.length > 0 && !f.tags.some(t => item.tags?.includes(t))) return false;

  // Facets: every non-null row must match. Summary/transcript presence mirrors
  // the library card badges (summary_generated_at / transcript_words, since the
  // list endpoint never sends the large transcript column).
  const { archive, star, audio, summary, transcript } = f.facets;
  if (archive === 'active' && item.is_archived) return false;
  if (archive === 'archived' && !item.is_archived) return false;
  if (star === 'starred' && !item.is_starred) return false;
  if (star === 'unstarred' && item.is_starred) return false;
  if (audio === 'audio' && !item.audio_url) return false;
  if (audio === 'no_audio' && item.audio_url) return false;
  if (summary === 'summary' && !item.summary_generated_at) return false;
  if (summary === 'no_summary' && item.summary_generated_at) return false;
  if (transcript === 'transcript' && !item.transcript_words) return false;
  if (transcript === 'no_transcript' && item.transcript_words) return false;

  const q = f.searchQuery.trim().toLowerCase();
  if (!q) return true;
  // "#name" searches tags only (substring of a tag), so a hashtag typed into the search
  // box behaves like a quick tag filter.
  if (q.startsWith('#') && q.length > 1) {
    const needle = q.slice(1);
    return (item.tags || []).some(t => t.includes(needle));
  }
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
  facets: FacetFilter;
  tagFilter: string[];
  searchQuery: string;
  sortDir: SortDir;
  loading: boolean;
  error: string | null;
  allCount: number; // count of all non-archived items, survives filter changes

  // Actions
  setTypeFilter: (typeFilter: TypeFilter) => void;
  setFacet: (dim: FacetDim, value: FacetValue | null) => void;
  setFacets: (facets: FacetFilter) => void;
  setTagFilter: (tags: string[]) => void;
  toggleTagFilter: (tag: string) => void;
  setSortDir: (sortDir: SortDir) => void;
  setSearchQuery: (searchQuery: string) => void;
  fetchContent: () => Promise<void>;

  // Optimistic updates - update UI immediately, then sync with server
  toggleStarred: (id: number) => Promise<void>;
  toggleArchived: (id: number) => Promise<void>;
  deleteItem: (id: number) => Promise<void>;
  // Replace an item's whole tag list (the picker's Save). Rejects on server error.
  setItemTags: (id: number, tags: string[]) => Promise<void>;

  // For background updates (generation status polling)
  updateItem: (id: number, updates: Partial<ContentItem>) => void;

  // For adding new content
  addItem: (item: ContentItem) => void;

  // Refresh single item from server (for generation completion)
  refreshItem: (id: number) => Promise<void>;
}

export const useContentStore = create<ContentStore>((set, get) => {
  const currentFilter = (): LibraryFilter => {
    const { typeFilter, facets, tagFilter, searchQuery } = get();
    return { typeFilter, facets, tags: tagFilter, searchQuery };
  };

  const persistFilters = () => {
    const { typeFilter, facets, tagFilter, sortDir } = get();
    storeFilters({ typeFilter, facets, tags: tagFilter, sortDir });
  };

  // Single source of truth: sort by date added, set allItems, and re-derive the
  // filtered view + allCount. Sorting here (not at render time) keeps the queue's
  // "Up next" stream, which reads allItems directly, in the same order the
  // library shows.
  const commit = (allItems: ContentItem[], extra: Record<string, unknown> = {}) => {
    const sorted = sortByDateAdded(allItems, get().sortDir);
    set({
      allItems: sorted,
      items: sorted.filter(i => itemMatchesFilter(i, currentFilter())),
      allCount: sorted.filter(i => !i.is_archived).length,
      ...extra,
    });
  };

  const storedFilters = loadStoredFilters();

  return {
    items: [],
    allItems: [],
    typeFilter: storedFilters.typeFilter,
    facets: storedFilters.facets,
    tagFilter: storedFilters.tags,
    searchQuery: '',
    sortDir: storedFilters.sortDir,
    loading: false,
    error: null,
    allCount: 0,

    // Client-side filtering, no API call needed, instant switch
    setTypeFilter: (typeFilter) => {
      set({ typeFilter });
      persistFilters();
      commit(get().allItems);
    },

    // The FACET_ROWS config in LibraryTab guarantees dim/value pairs belong
    // together, hence the cast on the computed property.
    setFacet: (dim, value) => {
      const facets = { ...get().facets, [dim]: value } as FacetFilter;
      set({ facets });
      persistFilters();
      commit(get().allItems);
    },

    // Replace the whole facet selection at once (double-click "solo" gesture)
    setFacets: (facets) => {
      set({ facets });
      persistFilters();
      commit(get().allItems);
    },

    setTagFilter: (tags) => {
      set({ tagFilter: tags });
      persistFilters();
      commit(get().allItems);
    },

    toggleTagFilter: (tag) => {
      const cur = get().tagFilter;
      get().setTagFilter(cur.includes(tag) ? cur.filter(t => t !== tag) : [...cur, tag]);
    },

    setSortDir: (sortDir) => {
      set({ sortDir });
      persistFilters();
      commit(get().allItems);
    },

    setSearchQuery: (searchQuery) => {
      set({ searchQuery });
      commit(get().allItems);
    },

    fetchContent: async () => {
      set({ loading: true, error: null });

      try {
        // Step 1: Fetch non-archived items first (fast, typically ~20 items)
        const activeResponse = await contentAPI.getAll({ archived: false });
        const activeItems = activeResponse.data;

        // Show active items immediately (loading done)
        commit(activeItems, { loading: false });

        // Step 2: Fetch archived items in the background (could be hundreds)
        // so the Archived/Favorites filters work instantly when clicked.
        // Merge against the CURRENT state, not the step-1 array captured before this
        // await. Otherwise any mutation that landed in between (e.g. a just-added item)
        // gets clobbered and vanishes from the UI.
        const archivedResponse = await contentAPI.getAll({ archived: true });
        const fetched = [...activeItems, ...archivedResponse.data];
        const fetchedById = new Map(fetched.map(i => [i.id, i]));
        const current = get().allItems;
        const seen = new Set<number>();
        // Update existing entries with fresh server data, preserving current ordering.
        const merged = current.map(i => {
          seen.add(i.id);
          return fetchedById.get(i.id) ?? i;
        });
        // Append fetched items that aren't already present (e.g. archived items on
        // first load), keeping their fetch order.
        for (const i of fetched) {
          if (!seen.has(i.id)) {
            seen.add(i.id);
            merged.push(i);
          }
        }
        commit(merged);
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
        // Revert on error - add item back (commit() re-sorts it into place)
        commit([...get().allItems, item]);
      }
    },

    setItemTags: async (id, tags) => {
      const item = get().allItems.find(i => i.id === id);
      if (!item) return;
      const previous = item.tags || [];

      // Optimistic: chips update instantly, server confirms (or we roll back)
      commit(get().allItems.map(i => (i.id === id ? { ...i, tags } : i)));

      try {
        const response = await contentAPI.update(id, { tags });
        const saved = response.data?.tags;
        if (Array.isArray(saved)) {
          commit(get().allItems.map(i => (i.id === id ? { ...i, tags: saved } : i)));
        }
      } catch (error) {
        console.error('Failed to save tags:', error);
        commit(get().allItems.map(i => (i.id === id ? { ...i, tags: previous } : i)));
        throw error;
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
