import { create } from 'zustand';
import { podcastAPI } from '../api';
import type { Podcast } from '../types';
import type { FeedEpisode } from '../components/FeedCards';

/**
 * State of the Feed tab. It lives in a store instead of inside FeedTab, so the tab
 * looks the same when the user comes back to it from another tab or from Settings
 * (FeedTab unmounts in both cases).
 *
 * The tab has two screens:
 * - home: the search results (while a search is active), the subscriptions list
 *   and Recent Updates.
 * - feed: one feed's page. A search result and a subscription use the same page.
 *   Its plus/X button follows whether the feed is in `podcasts`.
 *
 * Recent Updates and the open feed each have their own list, so loading one can
 * never overwrite the other.
 */

export const FEED_PAGE_SIZE = 50;

// One list of feed items with its own paging flags.
export interface FeedList {
  items: FeedEpisode[];
  hasMore: boolean;
  loading: boolean;
  loadingMore: boolean;
}

// `from` only picks the label of the back button.
export type FeedView =
  | { kind: 'home' }
  | { kind: 'feed'; feed: Podcast; from: 'search' | 'subscriptions' };

const emptyList = (loading = false): FeedList => ({ items: [], hasMore: false, loading, loadingMore: false });

// Feed URLs are compared without protocol, case, or trailing slash, so one feed found
// through iTunes and through a pasted URL still counts as the same subscription.
export function feedKey(url: string): string {
  return url.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase();
}

export function findSubscription(podcasts: Podcast[], feedUrl: string): Podcast | null {
  const key = feedKey(feedUrl);
  return podcasts.find(p => feedKey(p.feed_url) === key) || null;
}

// Recent Updates rows come from the feed_items cache (feed_id, podcast_show_name).
type CachedFeedItem = FeedEpisode & { feed_id: number; podcast_show_name?: string };

function toRecentEpisode(item: CachedFeedItem): FeedEpisode {
  return { ...item, podcast_id: item.feed_id, podcast_title: item.podcast_show_name };
}

// The server's error text when it sent one, else the request error, else the fallback
function errorMessage(error: unknown, fallback: string): string {
  const e = error as { response?: { data?: { error?: string } }; message?: string } | null;
  return e?.response?.data?.error || e?.message || fallback;
}

function sortByTitle(podcasts: Podcast[]): Podcast[] {
  return [...podcasts].sort((a, b) => (a.title || '').localeCompare(b.title || ''));
}

// Every load bumps its counter, and an answer is only used while its counter is still
// the latest. So a slow answer for a screen the user already left is thrown away.
let recentGen = 0;
let feedGen = 0;
let searchGen = 0;
let feedAbort: AbortController | null = null;

// Scroll spots, kept outside React state so scrolling never re-renders the tab.
// `tab` is where the tab was when the user left it, `home` is where the home screen
// was when the user opened a feed page.
export const feedScroll = { tab: 0, home: 0 };

interface FeedState {
  ownerKey: string | null; // the account the state belongs to
  podcasts: Podcast[];     // subscriptions
  recent: FeedList;
  lastRefresh: string | null;
  refreshing: boolean;
  searchQuery: string;
  searchResults: Podcast[];
  searchError: string | null;
  searching: boolean;
  view: FeedView;
  feedList: FeedList;
  subscriptionsExpanded: boolean;
  episodeSearchOpen: boolean;
  episodeSearchQuery: string;
  pendingFeeds: string[];  // feedKeys with a subscribe/unsubscribe in flight
}

interface FeedActions {
  // Loads everything the first time, and again only for a different account.
  // Returns true when it started over.
  ensureLoaded: (ownerKey: string) => boolean;
  loadSubscriptions: () => Promise<void>;
  loadRecent: (limit?: number) => Promise<void>;
  loadMoreRecent: () => Promise<void>;
  loadLastRefresh: () => Promise<void>;
  // Fetches every subscribed feed from the network. Returns false on failure.
  refresh: () => Promise<boolean>;
  setSearchQuery: (query: string) => void;
  search: () => Promise<void>;
  closeSearch: () => void;
  // Returns an error message when the feed could not load and the page is still open.
  openFeed: (feed: Podcast, from: 'search' | 'subscriptions') => Promise<string | null>;
  loadMoreFeed: () => Promise<void>;
  goHome: () => void;
  subscribe: (feed: Podcast) => Promise<void>;
  unsubscribe: (podcast: Podcast) => Promise<void>;
  setSubscriptionsExpanded: (expanded: boolean) => void;
  setEpisodeSearchOpen: (open: boolean) => void;
  setEpisodeSearchQuery: (query: string) => void;
}

const initialState = (): FeedState => ({
  ownerKey: null,
  podcasts: [],
  recent: emptyList(true),
  lastRefresh: null,
  refreshing: false,
  searchQuery: '',
  searchResults: [],
  searchError: null,
  searching: false,
  view: { kind: 'home' },
  feedList: emptyList(),
  subscriptionsExpanded: false,
  episodeSearchOpen: false,
  episodeSearchQuery: '',
  pendingFeeds: [],
});

export const useFeedStore = create<FeedState & FeedActions>((set, get) => {
  // Leaves the feed page: drops its pending answers and clears its list and search.
  const leaveFeed = () => {
    feedGen++;
    feedAbort?.abort();
    feedAbort = null;
    set({ view: { kind: 'home' }, feedList: emptyList(), episodeSearchOpen: false, episodeSearchQuery: '' });
  };

  const setPending = (key: string, pending: boolean) =>
    set(s => ({ pendingFeeds: pending ? [...s.pendingFeeds, key] : s.pendingFeeds.filter(k => k !== key) }));

  return {
    ...initialState(),

    ensureLoaded: (ownerKey) => {
      if (get().ownerKey === ownerKey) return false;
      recentGen++;
      searchGen++;
      leaveFeed();
      feedScroll.tab = 0;
      feedScroll.home = 0;
      set({ ...initialState(), ownerKey });
      void get().loadSubscriptions();
      void get().loadRecent();
      void get().loadLastRefresh();
      return true;
    },

    loadSubscriptions: async () => {
      try {
        const response = await podcastAPI.getAll();
        set({ podcasts: response.data });
      } catch (error) {
        console.error('Failed to load subscriptions:', error);
      }
    },

    loadRecent: async (limit = FEED_PAGE_SIZE) => {
      const gen = ++recentGen;
      set(s => ({ recent: { ...s.recent, loading: true, loadingMore: false } }));
      try {
        const response = await podcastAPI.getFeedItems(undefined, limit);
        if (gen !== recentGen) return;
        set({
          recent: {
            items: response.data.map(toRecentEpisode),
            hasMore: response.data.length >= limit,
            loading: false,
            loadingMore: false,
          },
        });
      } catch (error) {
        console.error('Failed to load Recent Updates:', error);
        if (gen === recentGen) set(s => ({ recent: { ...s.recent, loading: false } }));
      }
    },

    loadMoreRecent: async () => {
      const { recent } = get();
      if (recent.loading || recent.loadingMore) return;
      const gen = recentGen;
      set({ recent: { ...recent, loadingMore: true } });
      try {
        const response = await podcastAPI.getFeedItems(undefined, FEED_PAGE_SIZE, recent.items.length);
        if (gen !== recentGen) return;
        set(s => ({
          recent: {
            ...s.recent,
            items: [...s.recent.items, ...response.data.map(toRecentEpisode)],
            hasMore: response.data.length >= FEED_PAGE_SIZE,
            loadingMore: false,
          },
        }));
      } catch (error) {
        console.error('Failed to load more Recent Updates:', error);
        if (gen === recentGen) set(s => ({ recent: { ...s.recent, loadingMore: false } }));
      }
    },

    loadLastRefresh: async () => {
      try {
        const response = await podcastAPI.getLastRefresh();
        set({ lastRefresh: response.data.lastRefresh });
      } catch (error) {
        console.error('Failed to load last refresh time:', error);
      }
    },

    refresh: async () => {
      if (get().refreshing) return true;
      set({ refreshing: true });
      try {
        console.log('Refreshing feeds from network...');
        const response = await podcastAPI.refreshFeeds();
        console.log(`Refresh complete: ${response.data.totalFeeds} feeds, ${response.data.totalItemsAdded} new items`);
        await Promise.all([get().loadRecent(), get().loadLastRefresh()]);
        return true;
      } catch (error) {
        console.error('Failed to refresh feeds:', error);
        return false;
      } finally {
        set({ refreshing: false });
      }
    },

    setSearchQuery: (query) => set({ searchQuery: query }),

    search: async () => {
      const query = get().searchQuery.trim();
      if (!query) return;
      const gen = ++searchGen;
      // The results show on the home screen
      if (get().view.kind !== 'home') leaveFeed();
      set({ searching: true, searchError: null });
      try {
        const response = await podcastAPI.search(query);
        if (gen !== searchGen) return;
        set({ searchResults: response.data, searching: false });
      } catch (error) {
        if (gen !== searchGen) return;
        console.error('Search failed:', error);
        set({
          searchError: errorMessage(error, 'Failed to search'),
          searchResults: [],
          searching: false,
        });
      }
    },

    closeSearch: () => {
      searchGen++;
      set({ searchResults: [], searchQuery: '', searchError: null, searching: false });
    },

    openFeed: async (feed, from) => {
      const gen = ++feedGen;
      feedAbort?.abort();
      const controller = new AbortController();
      feedAbort = controller;
      set({
        view: { kind: 'feed', feed, from },
        feedList: emptyList(true),
        episodeSearchOpen: false,
        episodeSearchQuery: '',
      });
      try {
        const response = await podcastAPI.getPreviewByUrl(feed.feed_url, FEED_PAGE_SIZE, 0, controller.signal);
        if (gen !== feedGen) return null;
        set({
          feedList: {
            items: response.data.episodes.map((ep: FeedEpisode) => ({ ...ep, podcast_title: feed.title })),
            hasMore: response.data.hasMore,
            loading: false,
            loadingMore: false,
          },
        });
        return null;
      } catch (error) {
        if (gen !== feedGen) return null;
        console.error('Failed to load feed:', error);
        set(s => ({ feedList: { ...s.feedList, loading: false } }));
        return errorMessage(error, 'Failed to load preview');
      }
    },

    loadMoreFeed: async () => {
      const { view, feedList } = get();
      if (view.kind !== 'feed' || feedList.loading || feedList.loadingMore) return;
      const gen = feedGen;
      const feed = view.feed;
      set({ feedList: { ...feedList, loadingMore: true } });
      try {
        const response = await podcastAPI.getPreviewByUrl(feed.feed_url, FEED_PAGE_SIZE, feedList.items.length, feedAbort?.signal);
        if (gen !== feedGen) return;
        const newItems = response.data.episodes.map((ep: FeedEpisode) => ({ ...ep, podcast_title: feed.title }));
        set(s => ({
          feedList: { ...s.feedList, items: [...s.feedList.items, ...newItems], hasMore: response.data.hasMore, loadingMore: false },
        }));
      } catch (error) {
        if (gen !== feedGen) return;
        console.error('Failed to load more:', error);
        set(s => ({ feedList: { ...s.feedList, loadingMore: false } }));
      }
    },

    goHome: leaveFeed,

    subscribe: async (feed) => {
      const key = feedKey(feed.feed_url);
      if (get().pendingFeeds.includes(key)) return;
      setPending(key, true);
      try {
        const response = await podcastAPI.subscribe(feed.feed_url);
        const row = response.data;
        set(s => ({ podcasts: sortByTitle([...s.podcasts.filter(p => p.id !== row.id), row]) }));
        // A feed subscribed before still has cached items, which return to Recent Updates.
        // Reloaded at the current depth so a list the user paged through keeps its length.
        void get().loadRecent(Math.max(FEED_PAGE_SIZE, get().recent.items.length));
      } finally {
        setPending(key, false);
      }
    },

    unsubscribe: async (podcast) => {
      const key = feedKey(podcast.feed_url);
      if (get().pendingFeeds.includes(key)) return;
      setPending(key, true);
      try {
        await podcastAPI.unsubscribe(podcast.id);
        set(s => ({
          podcasts: s.podcasts.filter(p => p.id !== podcast.id),
          recent: { ...s.recent, items: s.recent.items.filter(ep => ep.podcast_id !== podcast.id) },
        }));
      } catch (error) {
        console.error('Failed to unsubscribe:', error);
      } finally {
        setPending(key, false);
      }
    },

    setSubscriptionsExpanded: (expanded) => set({ subscriptionsExpanded: expanded }),
    setEpisodeSearchOpen: (open) => set(open ? { episodeSearchOpen: true } : { episodeSearchOpen: false, episodeSearchQuery: '' }),
    setEpisodeSearchQuery: (query) => set({ episodeSearchQuery: query }),
  };
});
