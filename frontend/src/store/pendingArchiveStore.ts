import { create } from 'zustand';
import { useContentStore } from './contentStore';

/**
 * Delayed archiving from the fullscreen player. Pressing Archive there schedules
 * the real archive 10 seconds out (button flips to Undo with a draining bar), so
 * the queue can advance naturally first and an accidental tap can be taken back
 * before the server wipes anything (archiving deletes generated audio for
 * non-starred articles). The timers live app-level, so they fire even after the
 * player moved on or closed. If the item is STILL loaded in the player when the
 * timer fires, the archive defers until the player leaves it (never breaks a
 * playing stream). Closing the tab within the window silently drops the archive
 * (the safe direction). LibraryTab archiving stays instant.
 */

const DELAY_MS = 10_000;

const timers = new Map<number, ReturnType<typeof setTimeout>>();
let currentPlayerId: number | null = null;

// Called by App whenever the player's current item changes (null = closed).
export function notifyArchivePlayerItem(id: number | null): void {
  const prev = currentPlayerId;
  currentPlayerId = id;
  if (prev !== null && prev !== id && usePendingArchiveStore.getState().deferred[prev]) {
    usePendingArchiveStore.getState().consumeDeferred(prev);
    useContentStore.getState().toggleArchived(prev);
  }
}

interface PendingArchiveStore {
  /** contentId -> epoch ms when the archive fires (drives the button's Undo state). */
  pending: Record<number, number>;
  /**
   * Timers that fired while their item was still loaded in the player; these
   * archive the moment the player leaves the item. Tracked in state (not a bare
   * Set) so the button keeps showing Undo, otherwise a second Archive press in
   * this window would schedule another timer whose later toggleArchived would
   * UN-archive the by-then-archived item.
   */
  deferred: Record<number, true>;
  schedule: (id: number) => void;
  cancel: (id: number) => void;
  consumeDeferred: (id: number) => void;
}

export const usePendingArchiveStore = create<PendingArchiveStore>((set, get) => ({
  pending: {},
  deferred: {},
  schedule: (id) => {
    if (timers.has(id) || get().deferred[id]) return;
    timers.set(id, setTimeout(() => {
      timers.delete(id);
      set(s => {
        const pending = { ...s.pending };
        delete pending[id];
        return currentPlayerId === id
          ? { pending, deferred: { ...s.deferred, [id]: true as const } }
          : { pending };
      });
      if (currentPlayerId !== id) {
        useContentStore.getState().toggleArchived(id);
      }
    }, DELAY_MS));
    set(s => ({ pending: { ...s.pending, [id]: Date.now() + DELAY_MS } }));
  },
  cancel: (id) => {
    const t = timers.get(id);
    if (t) clearTimeout(t);
    timers.delete(id);
    set(s => {
      const pending = { ...s.pending };
      const deferred = { ...s.deferred };
      delete pending[id];
      delete deferred[id];
      return { pending, deferred };
    });
  },
  consumeDeferred: (id) => {
    set(s => {
      const deferred = { ...s.deferred };
      delete deferred[id];
      return { deferred };
    });
  },
}));
