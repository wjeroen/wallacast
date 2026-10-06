import { useState, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { Search, Plus, X, Check, ChevronDown, ChevronRight, ArrowLeft, Link, RefreshCw } from 'lucide-react';
import { podcastAPI, contentAPI } from '../api';
import { FeedCard, FeedEpisodeCard, type FeedEpisode } from './FeedCards';
import { cleanHtml } from '../format';
import type { Podcast as PodcastType } from '../types';
import { useFeedStore, feedKey, feedScroll, findSubscription, libraryUrlKey, type FeedList } from '../store/feedStore';
import { useAuthStore } from '../store/authStore';
import { useContentStore } from '../store/contentStore';

function formatRefreshTime(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins} min${diffMins > 1 ? 's' : ''} ago`;
  if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
  if (diffDays < 7) return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
  return date.toLocaleDateString('en-GB');
}

// Helper function to detect if query looks like a URL
function looksLikeUrl(query: string): boolean {
  return (
    query.includes('://') ||
    (query.includes('.') && !query.includes(' ')) ||
    query.startsWith('www.')
  );
}

// The feed an item belongs to, used when it is added to the library
interface ShowInfo {
  podcastId: number | null; // null when the user does not subscribe to the feed
  name?: string;
  author?: string;
}

const spinnerLine = (text: string) => (
  <p className="no-content"><RefreshCw size={14} className="spinning" style={{ verticalAlign: 'middle', marginRight: '0.5rem' }} />{text}</p>
);

// All state lives in useFeedStore (see store/feedStore.ts), so the tab is still where
// the user left it after a visit to another tab or to Settings.
export function FeedTab({ onRefreshComplete }: { onRefreshComplete?: () => void }) {
  const ownerKey = String(useAuthStore(s => s.user?.id ?? 'unknown'));
  const {
    podcasts, recent, lastRefresh, refreshing,
    searchQuery, searchResults, searchError, searching,
    view, feedList, subscriptionsExpanded, episodeSearchOpen, episodeSearchQuery, pendingFeeds,
    setSearchQuery, search, closeSearch, openFeed, goHome, subscribe, unsubscribe,
    loadMoreRecent, loadMoreFeed, refresh, setSubscriptionsExpanded, setEpisodeSearchOpen, setEpisodeSearchQuery,
  } = useFeedStore();

  const [addingToLibrary, setAddingToLibrary] = useState<string | null>(null);

  // What is already in the library (active and archived, the content store holds both), so
  // the plus of an item added before turns into a check mark
  const libraryItems = useContentStore(s => s.allItems);
  const libraryKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const item of libraryItems) {
      if (item.url) keys.add(`url:${libraryUrlKey(item.url)}`);
      if (item.type === 'podcast_episode' && item.audio_url) keys.add(`audio:${item.audio_url.trim()}`);
    }
    return keys;
  }, [libraryItems]);
  const isInLibrary = (episode: FeedEpisode) => episode.item_type === 'article'
    ? !!episode.url && libraryKeys.has(`url:${libraryUrlKey(episode.url)}`)
    : !!episode.audio_url && libraryKeys.has(`audio:${episode.audio_url.trim()}`);
  const [episodeSearchResults, setEpisodeSearchResults] = useState<FeedEpisode[] | null>(null);
  const [episodeSearchLoading, setEpisodeSearchLoading] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const episodeSearchInputRef = useRef<HTMLInputElement>(null);
  const focusEpisodeSearchRef = useRef(false);

  // --- Scroll memory ---
  // `.app-main` is the element that scrolls. Where it should be after the next render:
  // on mount that is the spot the tab had when the user left it.
  const pendingScrollRef = useRef<number | null>(feedScroll.tab);
  const getScroller = () => rootRef.current?.closest('.app-main') as HTMLElement | null;

  useLayoutEffect(() => {
    // A different account starts at the top
    if (useFeedStore.getState().ensureLoaded(ownerKey)) pendingScrollRef.current = 0;
  }, [ownerKey]);

  useLayoutEffect(() => {
    if (pendingScrollRef.current === null) return;
    const scroller = getScroller();
    if (scroller) scroller.scrollTop = pendingScrollRef.current;
    pendingScrollRef.current = null;
  });

  useLayoutEffect(() => {
    const scroller = getScroller();
    if (!scroller) return;
    const onScroll = () => { feedScroll.tab = scroller.scrollTop; };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => scroller.removeEventListener('scroll', onScroll);
  }, []);

  const openFeedFrom = async (feed: PodcastType, from: 'search' | 'subscriptions') => {
    // A feed page starts at the top, Back returns to this spot
    feedScroll.home = getScroller()?.scrollTop ?? 0;
    pendingScrollRef.current = 0;
    const error = await openFeed(feed, from);
    if (error) {
      alert(`Failed to load preview: ${error}`);
      goBackHome();
    }
  };

  const goBackHome = () => {
    pendingScrollRef.current = feedScroll.home;
    goHome();
  };

  const openFeedUrl = view.kind === 'feed' ? view.feed.feed_url : null;
  const openFeedTitle = view.kind === 'feed' ? view.feed.title : undefined;

  // Debounced server-side search (scans cached RSS XML on server)
  useEffect(() => {
    setEpisodeSearchResults(null);
    const query = episodeSearchQuery.trim();

    if (!query || !openFeedUrl) {
      setEpisodeSearchLoading(false);
      return;
    }

    setEpisodeSearchLoading(true);
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const response = await podcastAPI.searchFeed(openFeedUrl, query);
        if (!cancelled) {
          setEpisodeSearchResults(response.data.map((ep: FeedEpisode) => ({ ...ep, podcast_title: openFeedTitle })));
        }
      } catch (error) {
        console.error('Episode search failed:', error);
      } finally {
        if (!cancelled) setEpisodeSearchLoading(false);
      }
    }, 400);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [episodeSearchQuery, openFeedUrl, openFeedTitle]);

  // Focus the episode search field only when the user opens it, not when the tab
  // comes back with the field already open (that would pop up the phone keyboard)
  useEffect(() => {
    if (episodeSearchOpen && focusEpisodeSearchRef.current) {
      focusEpisodeSearchRef.current = false;
      episodeSearchInputRef.current?.focus();
    }
  }, [episodeSearchOpen]);

  const handleRefresh = async () => {
    const ok = await refresh();
    if (ok) onRefreshComplete?.();
    else alert('Could not refresh feeds. Check your connection and try again.');
  };

  const handleSearch = () => {
    if (!searchQuery.trim()) return;
    // The results appear at the top of the home screen
    if (view.kind === 'feed') pendingScrollRef.current = 0;
    void search();
  };

  const handleSubscribe = async (feed: PodcastType) => {
    try {
      await subscribe(feed);
    } catch (error) {
      console.error('Failed to subscribe:', error);
      alert('Could not subscribe to this feed. Check the URL and try again.');
    }
  };

  // In the subscriptions list the feed disappears when unsubscribed, so ask first
  const handleUnsubscribeFromList = (podcast: PodcastType) => {
    if (!confirm('Are you sure you want to unsubscribe from this podcast?')) return;
    void unsubscribe(podcast);
  };

  // Plus or X for a search result or a feed page. The feed stays on screen either way,
  // so a wrong tap is undone with the other button and needs no confirmation.
  const subscriptionButton = (feed: PodcastType, plusClassName?: string) => {
    const subscription = findSubscription(podcasts, feed.feed_url);
    const pending = pendingFeeds.includes(feedKey(feed.feed_url));
    return subscription ? (
      <button onClick={() => unsubscribe(subscription)} className="unsubscribe-btn" title="Unsubscribe" disabled={pending}>
        <X size={16} />
      </button>
    ) : (
      <button onClick={() => handleSubscribe(feed)} className={plusClassName} title="Subscribe" disabled={pending}>
        <Plus size={16} />
      </button>
    );
  };

  const handleAddToLibrary = async (episode: FeedEpisode, show: ShowInfo) => {
    const itemKey = episode.audio_url || episode.url || null;
    setAddingToLibrary(itemKey);
    try {
      let created;
      if (episode.item_type === 'article') {
        // RSS article (from newsletter / blog)
        created = await contentAPI.create({
          type: 'article',
          title: episode.title,
          description: episode.description,
          url: episode.url,
          podcast_id: show.podcastId ?? undefined,
          podcast_show_name: show.name,
          published_at: episode.published_at,
          preview_picture: episode.preview_picture,
        });
      } else {
        // Podcast episode. The author is the episode's own when the feed names one, else the
        // show's author (most feeds only set the channel-level itunes:author).
        created = await contentAPI.create({
          type: 'podcast_episode',
          title: episode.title,
          description: episode.description,
          audio_url: episode.audio_url,
          podcast_id: show.podcastId ?? undefined,
          podcast_show_name: show.name,
          published_at: episode.published_at,
          duration: episode.duration,
          preview_picture: episode.preview_picture,
          author: episode.author || show.author || undefined,
        });
      }
      // Into the library list at once, which also turns this plus into a check mark
      useContentStore.getState().addItem(created.data);
    } catch (error) {
      console.error('Failed to add to library:', error);
      alert('Could not add this to your library. Please try again.');
    } finally {
      setAddingToLibrary(null);
    }
  };

  // The add-to-library plus button passed into FeedEpisodeCard. An item already in the
  // library shows a check mark in the same grey instead, and tapping it does nothing.
  const addToLibraryButton = (episode: FeedEpisode, show: ShowInfo) => {
    if (isInLibrary(episode)) {
      return (
        <button className="in-library" title="In your library" aria-disabled="true">
          <Check size={16} />
        </button>
      );
    }
    const itemKey = episode.audio_url || episode.url;
    return (
      <button
        onClick={() => handleAddToLibrary(episode, show)}
        disabled={addingToLibrary === itemKey}
        title={addingToLibrary === itemKey ? 'Adding...' : 'Add to Library'}
      >
        <Plus size={16} />
      </button>
    );
  };

  const loadMoreButton = (list: FeedList, onLoadMore: () => void) => (
    list.loadingMore
      ? spinnerLine('Loading more...')
      : <button className="load-more-btn" onClick={onLoadMore}>Load More</button>
  );

  const renderEpisodeSectionHeader = (label: string) => (
    <div className="episode-section-header">
      {episodeSearchOpen ? (
        <div className="episode-search-field">
          <Search size={16} />
          <input
            ref={episodeSearchInputRef}
            type="text"
            placeholder={`Search ${label.toLowerCase()}…`}
            value={episodeSearchQuery}
            onChange={(e) => setEpisodeSearchQuery(e.target.value)}
          />
          <button
            className="episode-search-close"
            onClick={() => setEpisodeSearchOpen(false)}
            title="Close search"
          >
            <X size={16} />
          </button>
        </div>
      ) : (
        <>
          <h3>{label}</h3>
          <button
            className="episode-search-btn"
            onClick={() => { focusEpisodeSearchRef.current = true; setEpisodeSearchOpen(true); }}
            title={`Search ${label.toLowerCase()}`}
          >
            <Search size={16} />
          </button>
        </>
      )}
    </div>
  );

  // One page for every feed, a search result or a subscription. Subscribing or
  // unsubscribing only swaps the plus/X button, the episode list stays.
  const renderFeedPage = (feed: PodcastType, from: 'search' | 'subscriptions') => {
    const subscription = findSubscription(podcasts, feed.feed_url);
    const label = (subscription || feed).type === 'podcast' ? 'Episodes' : 'Articles';
    const show: ShowInfo = { podcastId: subscription?.id ?? null, name: feed.title, author: (subscription || feed).author };
    const query = episodeSearchQuery.trim();
    const visibleEpisodes = episodeSearchResults !== null
      ? episodeSearchResults
      : query
        ? feedList.items.filter(ep => {
            const q = query.toLowerCase();
            return (ep.title && ep.title.toLowerCase().includes(q))
              || (ep.description && cleanHtml(ep.description).toLowerCase().includes(q))
              || (ep.author && ep.author.toLowerCase().includes(q));
          })
        : feedList.items;

    return (
      <div className="selected-podcast-view">
        <button className="show-all-btn" onClick={goBackHome}>
          <ArrowLeft size={16} />
          {from === 'search' ? 'Show All Search Results' : 'Show All Subscriptions'}
        </button>

        <FeedCard
          feed={feed}
          variant="expanded"
          actionButton={subscriptionButton(feed, 'subscribe-btn')}
        />

        <div className="episodes-section">
          {renderEpisodeSectionHeader(label)}
          {feedList.loading && spinnerLine(`Loading ${label.toLowerCase()}...`)}
          {query && episodeSearchLoading && spinnerLine('Searching full feed...')}
          {query && !episodeSearchLoading && !feedList.loading && visibleEpisodes.length === 0 && (
            <p className="no-content">No matches found.</p>
          )}
          {visibleEpisodes.map((episode, index) => (
            <FeedEpisodeCard
              key={episode.audio_url || episode.url || index}
              episode={episode}
              actionButton={addToLibraryButton(episode, show)}
            />
          ))}
          {!query && feedList.hasMore && loadMoreButton(feedList, loadMoreFeed)}
        </div>
      </div>
    );
  };

  const renderHome = () => (
    <>
      {/* Search Results */}
      {searchResults.length > 0 && (
        <div className="search-results">
          <div className="search-results-header">
            <h3>Search Results</h3>
            <button
              className="search-results-close"
              onClick={closeSearch}
              title="Close search results"
            >
              <X size={20} />
            </button>
          </div>
          {searchResults.map((podcast, index) => (
            <FeedCard
              key={index}
              feed={podcast}
              variant="search-result"
              onClick={() => openFeedFrom(podcast, 'search')}
              actionButton={subscriptionButton(podcast)}
            />
          ))}
        </div>
      )}

      {/* Collapsible Subscriptions Section */}
      <div className="subscribed-podcasts-section">
        <button
          className="section-header"
          onClick={() => setSubscriptionsExpanded(!subscriptionsExpanded)}
        >
          <h3>Subscriptions ({podcasts.length})</h3>
          {subscriptionsExpanded ? <ChevronDown size={20} /> : <ChevronRight size={20} />}
        </button>

        {subscriptionsExpanded && (
          <div className="podcast-list">
            {podcasts.map((podcast) => (
              <FeedCard
                key={podcast.id}
                feed={podcast}
                variant="subscription"
                onClick={() => openFeedFrom(podcast, 'subscriptions')}
                actionButton={
                  <button
                    onClick={() => handleUnsubscribeFromList(podcast)}
                    className="unsubscribe-btn"
                    title="Unsubscribe"
                    disabled={pendingFeeds.includes(feedKey(podcast.feed_url))}
                  >
                    <X size={16} />
                  </button>
                }
              />
            ))}
          </div>
        )}
      </div>

      {/* Recent Updates */}
      <div className="episodes-section">
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1rem' }}>
          <h3 style={{ margin: 0 }}>Recent Updates</h3>
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            title={refreshing ? 'Refreshing...' : 'Refresh feeds from network'}
            style={{
              padding: '0.5rem',
              border: 'none',
              background: 'transparent',
              cursor: refreshing ? 'wait' : 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              color: 'var(--t3)',
              fontSize: '0.9rem'
            }}
          >
            <RefreshCw size={16} className={refreshing ? 'spinning' : ''} />
            {lastRefresh && !refreshing && (
              <span style={{ fontSize: '0.85rem' }}>
                {formatRefreshTime(new Date(lastRefresh))}
              </span>
            )}
            {refreshing && <span>Refreshing...</span>}
          </button>
        </div>
        {recent.items.map((episode, index) => (
          <FeedEpisodeCard
            key={episode.audio_url || episode.url || index}
            episode={episode}
            showShowName
            actionButton={addToLibraryButton(episode, {
              podcastId: episode.podcast_id ?? null,
              name: episode.podcast_title,
              author: podcasts.find(p => p.id === episode.podcast_id)?.author,
            })}
          />
        ))}
        {recent.hasMore && !recent.loading && loadMoreButton(recent, loadMoreRecent)}
      </div>
    </>
  );

  const isUrl = looksLikeUrl(searchQuery);

  return (
    <div className="feed-tab" ref={rootRef}>
      {/* Search Bar */}
      <div className="search-bar">
        <div className="search-input-group">
          {isUrl ? <Link size={20} /> : <Search size={20} />}
          <input
            type="text"
            placeholder="Search podcasts or paste RSS feed..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && handleSearch()}
          />
          <button onClick={handleSearch} disabled={searching}>
            {searching ? 'Loading...' : 'Search'}
          </button>
        </div>
      </div>

      {/* Search Error */}
      {searchError && (
        <div className="search-error">
          {searchError}
        </div>
      )}

      {view.kind === 'feed' ? renderFeedPage(view.feed, view.from) : renderHome()}
    </div>
  );
}
