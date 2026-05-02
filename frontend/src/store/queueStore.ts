import { create } from 'zustand';
import { queueAPI, userSettingsAPI, contentAPI } from '../api';
import { useContentStore, type FilterType } from './contentStore';
import type { ContentItem, QueueItem } from '../types';

/**
 * Snapshot of the library filter at the moment the user clicked a library item.
 * Acts like Spotify's "play context" — the non-manual queue (items that play
 * after manual ones if autoplay is on) is derived from this filter.
 * We intentionally do NOT persist this: if the user reloads, auto-queue is
 * recaptured when they click their next library item.
 */
interface LibraryContext {
  filter: FilterType;
  capturedFromId: number;
}

interface QueueStore {
  // Server-persisted manual queue (items the user explicitly added)
  manualItems: QueueItem[];
  loading: boolean;

  // Captured on library click — frozen filter used to build the non-manual queue
  libraryContext: LibraryContext | null;

  // User-facing toggles
  autoplay: boolean;       // auto-advance into non-manual items after queue empties
  shuffleNonManual: boolean; // shuffle the non-manual part only (per session)
  // When true (default), manual queue items always auto-advance regardless of `autoplay`.
  // When false, the `autoplay` toggle gates advance into manual items too.
  manualAlwaysAutoplay: boolean;

  // Content IDs for which we started audio generation from the queue flow.
  // When one completes we re-insert it at position 0 of the manual queue.
  pendingRequeue: Set<number>;

  // Stable shuffle order (content IDs) captured when the user turns shuffle
  // on. We don't reshuffle on every render — otherwise the "next" item would
  // change every time the player re-renders.
  shuffleOrder: number[];

  // --- Actions ---
  fetchQueue: () => Promise<void>;
  hydrateSettings: () => Promise<void>;
  addToQueue: (item: ContentItem) => Promise<void>;
  addToFront: (contentItemId: number) => Promise<void>;
  removeFromQueue: (queueId: number) => Promise<void>;
  moveUp: (queueId: number) => Promise<void>;
  moveDown: (queueId: number) => Promise<void>;
  clearQueue: () => Promise<void>;
  setLibraryContext: (filter: FilterType, capturedFromId: number) => void;
  setAutoplay: (v: boolean) => Promise<void>;
  setShuffleNonManual: (v: boolean, currentId?: number | null) => void;
  setManualAlwaysAutoplay: (v: boolean) => Promise<void>;
  markPendingRequeue: (contentId: number) => void;
  clearPendingRequeue: (contentId: number) => void;

  // --- Derived helpers (called by player/App) ---
  /**
   * Auto-advance next — respects the autoplay and manualAlwaysAutoplay
   * settings. Returns null if the user has gated auto-advance off.
   */
  getNextItem: (currentId: number | null) => ContentItem | null;
  /**
   * Manual-skip next — ignores autoplay gating. Used by the skip button
   * so the user can always move forward regardless of settings.
   */
  peekNextItem: (currentId: number | null) => ContentItem | null;
  /**
   * Previous item: walks backwards through manual queue first, then
   * steps back one position in the non-manual library stream.
   */
  getPrevItem: (currentId: number | null) => ContentItem | null;
  /** Items to render as "Up next from library" in the queue tab. */
  getNonManualItems: (currentId: number | null) => ContentItem[];
}

// Fisher-Yates shuffle (non-mutating)
function shuffled<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export const useQueueStore = create<QueueStore>((set, get) => ({
  manualItems: [],
  loading: false,
  libraryContext: null,
  autoplay: false,
  shuffleNonManual: false,
  manualAlwaysAutoplay: true,
  pendingRequeue: new Set<number>(),
  shuffleOrder: [],

  fetchQueue: async () => {
    set({ loading: true });
    try {
      const res = await queueAPI.getAll();
      set({ manualItems: res.data, loading: false });
    } catch (err) {
      console.error('Failed to fetch queue:', err);
      set({ loading: false });
    }
  },

  hydrateSettings: async () => {
    try {
      const res = await userSettingsAPI.get('queue_autoplay');
      if (res.data.value === 'true') set({ autoplay: true });
    } catch { /* setting not set yet — default false */ }
    try {
      const res = await userSettingsAPI.get('manual_queue_always_autoplay');
      // Only override the default (true) when the user explicitly stored 'false'
      if (res.data.value === 'false') set({ manualAlwaysAutoplay: false });
    } catch { /* default true */ }
  },

  addToQueue: async (item) => {
    try {
      const res = await queueAPI.add(item.id);
      // The POST /queue response only returns queue_id/position/added_at.
      // Compose a full QueueItem from the content item + the returned queue fields.
      const queueItem: QueueItem = {
        ...item,
        queue_id: res.data.id,
        queue_position: res.data.position,
        queue_added_at: res.data.added_at,
      };
      set({ manualItems: [...get().manualItems, queueItem] });
    } catch (err) {
      console.error('Failed to add to queue:', err);
      alert('Failed to add to queue');
    }
  },

  addToFront: async (contentItemId) => {
    try {
      // Fetch full content item so we can build a QueueItem without refetching the queue
      const contentRes = await contentAPI.getById(contentItemId);
      const res = await queueAPI.addToFront(contentItemId);
      const queueItem: QueueItem = {
        ...contentRes.data,
        queue_id: res.data.id,
        queue_position: res.data.position,
        queue_added_at: res.data.added_at,
      };
      // Bump existing positions locally, then prepend
      const bumped = get().manualItems.map(q => ({ ...q, queue_position: q.queue_position + 1 }));
      set({ manualItems: [queueItem, ...bumped] });
    } catch (err) {
      console.error('Failed to add to front of queue:', err);
    }
  },

  removeFromQueue: async (queueId) => {
    const { manualItems } = get();
    const target = manualItems.find(q => q.queue_id === queueId);
    if (!target) return;
    // Optimistic: drop locally and renumber
    const remaining = manualItems
      .filter(q => q.queue_id !== queueId)
      .map(q => q.queue_position > target.queue_position
        ? { ...q, queue_position: q.queue_position - 1 }
        : q
      );
    set({ manualItems: remaining });
    try {
      await queueAPI.remove(queueId);
    } catch (err) {
      console.error('Failed to remove from queue:', err);
      // Refetch to reconcile
      get().fetchQueue();
    }
  },

  moveUp: async (queueId) => {
    const { manualItems } = get();
    const idx = manualItems.findIndex(q => q.queue_id === queueId);
    if (idx <= 0) return;
    const reordered = manualItems.slice();
    const a = reordered[idx - 1];
    const b = reordered[idx];
    reordered[idx - 1] = { ...b, queue_position: a.queue_position };
    reordered[idx] = { ...a, queue_position: b.queue_position };
    set({ manualItems: reordered });
    try {
      await queueAPI.reorder([
        { id: a.queue_id, position: b.queue_position },
        { id: b.queue_id, position: a.queue_position },
      ]);
    } catch (err) {
      console.error('Failed to move queue item up:', err);
      get().fetchQueue();
    }
  },

  moveDown: async (queueId) => {
    const { manualItems } = get();
    const idx = manualItems.findIndex(q => q.queue_id === queueId);
    if (idx < 0 || idx >= manualItems.length - 1) return;
    const reordered = manualItems.slice();
    const a = reordered[idx];
    const b = reordered[idx + 1];
    reordered[idx] = { ...b, queue_position: a.queue_position };
    reordered[idx + 1] = { ...a, queue_position: b.queue_position };
    set({ manualItems: reordered });
    try {
      await queueAPI.reorder([
        { id: a.queue_id, position: b.queue_position },
        { id: b.queue_id, position: a.queue_position },
      ]);
    } catch (err) {
      console.error('Failed to move queue item down:', err);
      get().fetchQueue();
    }
  },

  clearQueue: async () => {
    set({ manualItems: [] });
    try {
      await queueAPI.clear();
    } catch (err) {
      console.error('Failed to clear queue:', err);
      get().fetchQueue();
    }
  },

  setLibraryContext: (filter, capturedFromId) => {
    set({ libraryContext: { filter, capturedFromId } });
  },

  setAutoplay: async (v) => {
    set({ autoplay: v });
    try {
      await userSettingsAPI.set('queue_autoplay', String(v));
    } catch (err) {
      console.error('Failed to save autoplay preference:', err);
    }
  },

  setShuffleNonManual: (v, currentId) => {
    if (v) {
      // Snapshot a stable random order over the full library. We shuffle
      // the entire library (not just the current filter) so toggling
      // between filters doesn't invalidate the order unnecessarily.
      const ids = useContentStore.getState().allItems.map(i => i.id);
      const order = shuffled(ids);
      // Rotate so the currently-playing item sits at position 0. This way
      // pivoting in getNonManualItems doesn't drop items that landed before
      // current in the random order — they get rotated to the end and stay
      // playable. If currentId isn't in the library, no rotation needed.
      if (currentId != null) {
        const idx = order.indexOf(currentId);
        if (idx > 0) {
          const rotated = [...order.slice(idx), ...order.slice(0, idx)];
          set({ shuffleNonManual: true, shuffleOrder: rotated });
          return;
        }
      }
      set({ shuffleNonManual: true, shuffleOrder: order });
    } else {
      set({ shuffleNonManual: false, shuffleOrder: [] });
    }
  },

  setManualAlwaysAutoplay: async (v) => {
    set({ manualAlwaysAutoplay: v });
    try {
      await userSettingsAPI.set('manual_queue_always_autoplay', String(v));
    } catch (err) {
      console.error('Failed to save manual-always-autoplay preference:', err);
    }
  },

  markPendingRequeue: (contentId) => {
    const next = new Set(get().pendingRequeue);
    next.add(contentId);
    set({ pendingRequeue: next });
  },

  clearPendingRequeue: (contentId) => {
    const next = new Set(get().pendingRequeue);
    next.delete(contentId);
    set({ pendingRequeue: next });
  },

  getNonManualItems: (currentId) => {
    const { libraryContext, manualItems, shuffleNonManual, shuffleOrder } = get();
    if (!libraryContext) return [];

    const allItems = useContentStore.getState().allItems;
    const manualIds = new Set(manualItems.map(m => m.id));

    // Items that match the captured library filter AND have audio.
    // Don't pre-exclude currentId here — we need it to find the pivot.
    const matchesFilter = (item: ContentItem) => {
      if (!item.audio_url) return false;
      switch (libraryContext.filter) {
        case 'articles': return item.type === 'article' && !item.is_archived;
        case 'texts': return item.type === 'text' && !item.is_archived;
        case 'podcasts': return item.type === 'podcast_episode' && !item.is_archived;
        case 'favorites': return item.is_starred;
        case 'archived': return item.is_archived;
        case 'all':
        default: return !item.is_archived;
      }
    };
    const filtered = allItems.filter(matchesFilter);

    // Apply stable shuffle order if shuffle is on, else use library order.
    let ordered: ContentItem[];
    if (shuffleNonManual && shuffleOrder.length > 0) {
      const byId = new Map(filtered.map(i => [i.id, i]));
      ordered = [];
      for (const id of shuffleOrder) {
        const item = byId.get(id);
        if (item) {
          ordered.push(item);
          byId.delete(id);
        }
      }
      // Any items added to the library after shuffle started — tack them on
      for (const item of byId.values()) ordered.push(item);
    } else {
      ordered = filtered;
    }

    // Pivot on the current item's position in `ordered` so "Up next" starts
    // from the item AFTER the one playing. In shuffle mode this prevents
    // already-played items (which sit before current in the rotated shuffle
    // order) from re-appearing at the top. If current isn't in `ordered`
    // (rare — e.g. archived item), fall back to capturedFromId, then the
    // whole list — never want to silently drop everything.
    let pivot = ordered.findIndex(i => i.id === currentId);
    if (pivot < 0) pivot = ordered.findIndex(i => i.id === libraryContext.capturedFromId);
    const after = pivot >= 0 ? ordered.slice(pivot + 1) : ordered;
    const result = after.filter(i => !manualIds.has(i.id) && i.id !== currentId);
    return result;
  },

  getNextItem: (currentId) => {
    const { manualItems, autoplay, manualAlwaysAutoplay } = get();

    // 1) Next manual item — first one that isn't the currently playing one.
    //    Gated by `autoplay` when the user has disabled "manual items always
    //    autoplay" in settings.
    const manualAllowed = manualAlwaysAutoplay || autoplay;
    if (manualAllowed) {
      const manualIdx = manualItems.findIndex(m => m.id === currentId);
      if (manualIdx >= 0 && manualIdx + 1 < manualItems.length) {
        return manualItems[manualIdx + 1];
      }
      if (manualIdx < 0 && manualItems.length > 0) {
        // currently playing is not in manual queue — next manual is the head
        return manualItems[0];
      }
    }

    // 2) Non-manual — only if autoplay is on
    if (!autoplay) return null;
    const nonManual = get().getNonManualItems(currentId);
    return nonManual.length > 0 ? nonManual[0] : null;
  },

  peekNextItem: (currentId) => {
    // Same ordering rules as getNextItem, but ignores autoplay /
    // manualAlwaysAutoplay gating. Used by the manual Skip Next button
    // so the user can always advance even when autoplay is off.
    const { manualItems } = get();
    const manualIdx = manualItems.findIndex(m => m.id === currentId);
    if (manualIdx >= 0 && manualIdx + 1 < manualItems.length) {
      return manualItems[manualIdx + 1];
    }
    if (manualIdx < 0 && manualItems.length > 0) {
      return manualItems[0];
    }
    const nonManual = get().getNonManualItems(currentId);
    return nonManual.length > 0 ? nonManual[0] : null;
  },

  getPrevItem: (currentId) => {
    const { manualItems, libraryContext } = get();
    const manualIdx = manualItems.findIndex(m => m.id === currentId);
    if (manualIdx > 0) return manualItems[manualIdx - 1];

    // Step back one position in the non-manual stream.
    if (!libraryContext) return null;
    const allItems = useContentStore.getState().allItems;
    const { shuffleNonManual, shuffleOrder } = get();
    const matchesFilter = (item: ContentItem) => {
      if (!item.audio_url) return false;
      switch (libraryContext.filter) {
        case 'articles': return item.type === 'article' && !item.is_archived;
        case 'texts': return item.type === 'text' && !item.is_archived;
        case 'podcasts': return item.type === 'podcast_episode' && !item.is_archived;
        case 'favorites': return item.is_starred;
        case 'archived': return item.is_archived;
        case 'all':
        default: return !item.is_archived;
      }
    };
    const filtered = allItems.filter(matchesFilter);
    let ordered: ContentItem[];
    if (shuffleNonManual && shuffleOrder.length > 0) {
      const byId = new Map(filtered.map(i => [i.id, i]));
      ordered = [];
      for (const id of shuffleOrder) {
        const item = byId.get(id);
        if (item) { ordered.push(item); byId.delete(id); }
      }
      for (const item of byId.values()) ordered.push(item);
    } else {
      ordered = filtered;
    }
    let pivot = ordered.findIndex(i => i.id === currentId);
    if (pivot < 0) pivot = ordered.findIndex(i => i.id === libraryContext.capturedFromId);
    if (pivot > 0) return ordered[pivot - 1];
    return null;
  },
}));
