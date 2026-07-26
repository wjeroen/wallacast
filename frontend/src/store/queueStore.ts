import { create } from 'zustand';
import { queueAPI, userSettingsAPI, contentAPI } from '../api';
import { useContentStore, itemMatchesFilter, type LibraryFilter } from './contentStore';
import type { ContentItem, QueueItem } from '../types';

/**
 * Snapshot of the library filter at the moment the user clicked a library item.
 * Acts like Spotify's "play context", the non-manual queue (items that play
 * after manual ones if autoplay is on) is derived from this filter.
 * The snapshot includes type, status AND search query, frozen at click time.
 * We intentionally do NOT persist this: if the user reloads, auto-queue is
 * recaptured when they click their next library item.
 */
interface LibraryContext {
  filter: LibraryFilter;
  capturedFromId: number;
}

interface QueueStore {
  // Server-persisted manual queue (items the user explicitly added)
  manualItems: QueueItem[];
  loading: boolean;

  // Captured on library click, frozen filter used to build the non-manual queue
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
  // on. We don't reshuffle on every render. Otherwise the "next" item would
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
  setLibraryContext: (filter: LibraryFilter, capturedFromId: number) => void;
  setAutoplay: (v: boolean) => Promise<void>;
  setShuffleNonManual: (v: boolean, currentId?: number | null) => void;
  setManualAlwaysAutoplay: (v: boolean) => Promise<void>;
  markPendingRequeue: (contentId: number) => void;
  clearPendingRequeue: (contentId: number) => void;

  // --- Derived helpers (called by player/App) ---
  /**
   * Auto-advance next, respects the autoplay and manualAlwaysAutoplay
   * settings. Returns null if the user has gated auto-advance off.
   */
  getNextItem: (currentId: number | null) => ContentItem | null;
  /**
   * Manual-skip next, ignores autoplay gating. Used by the skip button
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

export const useQueueStore = create<QueueStore>((set, get) => {
  // Snapshot a stable random order over the full library, rotated so the
  // currently-playing item sits at position 0. Rotation keeps items that
  // landed before current in the random order playable (they move to the
  // end) instead of being dropped by the pivot. See commit history
  // ("shuffle next-goes-back" fix).
  const buildShuffleOrder = (currentId?: number | null): number[] => {
    const ids = useContentStore.getState().allItems.map(i => i.id);
    if (ids.length === 0) return [];
    const order = shuffled(ids);
    if (currentId != null) {
      const idx = order.indexOf(currentId);
      if (idx > 0) return [...order.slice(idx), ...order.slice(0, idx)];
    }
    return order;
  };

  // The shuffle flag can be hydrated from settings before the library has
  // loaded, in which case no order exists yet. Build it lazily on first use
  // instead of silently dropping the saved preference (the old hydrate-time
  // build raced fetchContent and lost the user's shuffle setting on reload).
  const ensureShuffleOrder = (currentId: number | null): number[] => {
    const { shuffleOrder } = get();
    if (shuffleOrder.length > 0) return shuffleOrder;
    const order = buildShuffleOrder(currentId);
    if (order.length > 0) set({ shuffleOrder: order });
    return order;
  };

  // Build the ordered non-manual id stream and locate the pivot for
  // currentId. The pivot is found on the FULL id stream (shuffle order or
  // library order), NOT the filtered list, so an item that stops matching
  // the captured filter mid-play (e.g. archived right before it ends, which
  // also wipes its audio) keeps its position and the stream continues
  // forward, instead of falling back to the original library click and
  // replaying already-played items.
  const getStream = (currentId: number | null) => {
    const { libraryContext, shuffleNonManual } = get();
    if (!libraryContext) return null;

    const allItems = useContentStore.getState().allItems;
    const byId = new Map(allItems.map(i => [i.id, i]));

    let streamIds: number[];
    if (shuffleNonManual) {
      const order = ensureShuffleOrder(currentId);
      // Items added to the library after shuffle started. Tack them on
      const inOrder = new Set(order);
      const added = allItems.filter(i => !inOrder.has(i.id)).map(i => i.id);
      streamIds = added.length > 0 ? [...order, ...added] : order;
    } else {
      streamIds = allItems.map(i => i.id);
    }

    let pivot = currentId != null ? streamIds.indexOf(currentId) : -1;
    if (pivot < 0) pivot = streamIds.indexOf(libraryContext.capturedFromId);

    // Items that match the captured library filter AND have audio. Used by the
    // visible "Up next" list and autoplay continuation (listening features).
    const matches = (item: ContentItem | undefined): item is ContentItem =>
      !!item && !!item.audio_url && itemMatchesFilter(item, libraryContext.filter);

    // Filter-only variant for the prev/next BUTTONS: they navigate every
    // matching item, audio or not, so reading flows item-to-item too
    // (user decision 2026-07-26). Autoplay and the queue keep `matches`.
    const matchesAnyAudio = (item: ContentItem | undefined): item is ContentItem =>
      !!item && itemMatchesFilter(item, libraryContext.filter);

    return { streamIds, byId, pivot, matches, matchesAnyAudio };
  };

  return {
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
    } catch { /* setting not set yet, default false */ }
    try {
      const res = await userSettingsAPI.get('manual_queue_always_autoplay');
      // Only override the default (true) when the user explicitly stored 'false'
      if (res.data.value === 'false') set({ manualAlwaysAutoplay: false });
    } catch { /* default true */ }
    try {
      const res = await userSettingsAPI.get('queue_shuffle');
      if (res.data.value === 'true') {
        // Only set the flag, the library may not be loaded yet, so the
        // shuffle order is built lazily by ensureShuffleOrder() on first use
        set({ shuffleNonManual: true });
      }
    } catch { /* default false */ }
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
    // If shuffle was hydrated from settings before the library loaded, the
    // order doesn't exist yet, build it now (rotated to the clicked item)
    // so render-time getters find it ready.
    if (get().shuffleNonManual) ensureShuffleOrder(capturedFromId);
  },

  setAutoplay: async (v) => {
    set({ autoplay: v });
    try {
      await userSettingsAPI.set('queue_autoplay', String(v));
    } catch (err) {
      console.error('Failed to save autoplay preference:', err);
    }
  },

  setShuffleNonManual: async (v, currentId) => {
    if (v) {
      set({ shuffleNonManual: true, shuffleOrder: buildShuffleOrder(currentId) });
    } else {
      set({ shuffleNonManual: false, shuffleOrder: [] });
    }
    userSettingsAPI.set('queue_shuffle', String(v)).catch(() => {});
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
    const stream = getStream(currentId);
    if (!stream) return [];

    const manualIds = new Set(get().manualItems.map(m => m.id));

    // "Up next" starts from the position AFTER the playing item. The pivot
    // is position-based (full id stream), so it survives the current item
    // being archived / losing audio mid-play. If there's no pivot at all,
    // fall back to the whole stream. Never silently drop everything.
    const after = stream.pivot >= 0 ? stream.streamIds.slice(stream.pivot + 1) : stream.streamIds;
    const result: ContentItem[] = [];
    for (const id of after) {
      const item = stream.byId.get(id);
      if (stream.matches(item) && !manualIds.has(item.id) && item.id !== currentId) {
        result.push(item);
      }
    }
    return result;
  },

  getNextItem: (currentId) => {
    const { manualItems, autoplay, manualAlwaysAutoplay } = get();

    // 1) Next manual item, first one that isn't the currently playing one.
    //    Gated by `autoplay` when the user has disabled "manual items always
    //    autoplay" in settings.
    const manualAllowed = manualAlwaysAutoplay || autoplay;
    if (manualAllowed) {
      const manualIdx = manualItems.findIndex(m => m.id === currentId);
      if (manualIdx >= 0 && manualIdx + 1 < manualItems.length) {
        return manualItems[manualIdx + 1];
      }
      if (manualIdx < 0 && manualItems.length > 0) {
        // currently playing is not in manual queue, next manual is the head
        return manualItems[0];
      }
    }

    // 2) Non-manual, only if autoplay is on
    if (!autoplay) return null;
    const nonManual = get().getNonManualItems(currentId);
    return nonManual.length > 0 ? nonManual[0] : null;
  },

  peekNextItem: (currentId) => {
    // Same ordering rules as getNextItem, but ignores autoplay /
    // manualAlwaysAutoplay gating AND does not require audio: the skip
    // button walks the whole filtered stream so reading can flow from one
    // audio-less article to the next (autoplay + the visible queue keep
    // requiring audio).
    const { manualItems } = get();
    const manualIdx = manualItems.findIndex(m => m.id === currentId);
    if (manualIdx >= 0 && manualIdx + 1 < manualItems.length) {
      return manualItems[manualIdx + 1];
    }
    if (manualIdx < 0 && manualItems.length > 0) {
      return manualItems[0];
    }
    const stream = getStream(currentId);
    if (!stream) return null;
    const manualIds = new Set(manualItems.map(m => m.id));
    const after = stream.pivot >= 0 ? stream.streamIds.slice(stream.pivot + 1) : stream.streamIds;
    for (const id of after) {
      const item = stream.byId.get(id);
      if (stream.matchesAnyAudio(item) && !manualIds.has(item.id) && item.id !== currentId) {
        return item;
      }
    }
    return null;
  },

  getPrevItem: (currentId) => {
    const { manualItems } = get();
    const manualIdx = manualItems.findIndex(m => m.id === currentId);
    if (manualIdx > 0) return manualItems[manualIdx - 1];

    // Step back through the non-manual stream to the nearest item, audio
    // or not (same navigate-everything rule as peekNextItem).
    const stream = getStream(currentId);
    if (!stream || stream.pivot <= 0) return null;
    for (let i = stream.pivot - 1; i >= 0; i--) {
      const item = stream.byId.get(stream.streamIds[i]);
      if (stream.matchesAnyAudio(item)) return item;
    }
    return null;
  },
  };
});
