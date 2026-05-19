import React, { useState, useEffect } from 'react';
import { Search, Plus, X, ChevronDown, ChevronRight, ArrowLeft, Podcast, Newspaper, Link, RefreshCw, SquareArrowOutUpRight } from 'lucide-react';
import { podcastAPI, contentAPI } from '../api';
import type { Podcast as PodcastType } from '../types';

function cleanHtml(text: string): string {
  if (!text) return '';
  // Remove CDATA wrapper
  let cleaned = text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  // Remove HTML tags
  cleaned = cleaned.replace(/<[^>]+>/g, ' ');
  // Decode HTML entities
  cleaned = cleaned
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
  // Clean up whitespace
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  return cleaned;
}

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

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

function getDomainFromUrl(url: string): string {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

const PAGE_SIZE = 50;

// Helper function to detect if query looks like a URL
function looksLikeUrl(query: string): boolean {
  return (
    query.includes('://') ||
    (query.includes('.') && !query.includes(' ')) ||
    query.startsWith('www.')
  );
}

export function FeedTab({ onRefreshComplete }: { onRefreshComplete?: () => void }) {
  const [podcasts, setPodcasts] = useState<PodcastType[]>([]);
  const [allEpisodes, setAllEpisodes] = useState<any[]>([]);
  const [visibleEpisodeCount, setVisibleEpisodeCount] = useState(PAGE_SIZE);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<PodcastType[]>([]);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedPodcast, setSelectedPodcast] = useState<PodcastType | null>(null);
  const [selectedSearchResult, setSelectedSearchResult] = useState<PodcastType | null>(null);
  const [addingToLibrary, setAddingToLibrary] = useState<string | null>(null);
  const [podcastsExpanded, setPodcastsExpanded] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastRefreshTime, setLastRefreshTime] = useState<Date | null>(null);
  const [episodeSearchOpen, setEpisodeSearchOpen] = useState(false);
  const [episodeSearchQuery, setEpisodeSearchQuery] = useState('');
  const [episodeSearchResults, setEpisodeSearchResults] = useState<any[] | null>(null);
  const [episodeSearchLoading, setEpisodeSearchLoading] = useState(false);
  const [fullFeedLoaded, setFullFeedLoaded] = useState(false);
  const [fullFeedLoading, setFullFeedLoading] = useState(false);
  const [hasMoreFromServer, setHasMoreFromServer] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    loadCachedData();
    loadLastRefreshTime();
  }, []);

  const currentFeedUrl = selectedPodcast?.feed_url || selectedSearchResult?.feed_url;

  // Debounced server-side search (only needed before full feed is loaded)
  useEffect(() => {
    setEpisodeSearchResults(null);

    if (!episodeSearchQuery.trim() || !currentFeedUrl || fullFeedLoaded) {
      setEpisodeSearchLoading(false);
      return;
    }

    setEpisodeSearchLoading(true);
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const response = await podcastAPI.searchFeed(currentFeedUrl, episodeSearchQuery.trim());
        if (!cancelled) {
          const results = response.data.map((ep: any) => ({
            ...ep,
            podcast_id: selectedPodcast?.id || null,
            podcast_title: selectedPodcast?.title || selectedSearchResult?.title,
          }));
          setEpisodeSearchResults(results);
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
  }, [episodeSearchQuery, currentFeedUrl, fullFeedLoaded]);

  // Background prefetch: load full feed after initial 20 are displayed
  useEffect(() => {
    if (!currentFeedUrl || (!selectedPodcast && !selectedSearchResult)) {
      setFullFeedLoaded(false);
      setFullFeedLoading(false);
      return;
    }

    const abortController = new AbortController();
    setFullFeedLoaded(false);
    setFullFeedLoading(true);

    const loadFullFeed = async () => {
      try {
        const response = await podcastAPI.getPreviewByUrl(currentFeedUrl, 0, abortController.signal);
        const episodes = response.data.map((ep: any) => ({
          ...ep,
          podcast_id: selectedPodcast?.id || null,
          podcast_title: selectedPodcast?.title || selectedSearchResult?.title,
        }));
        setAllEpisodes(episodes);
        setFullFeedLoaded(true);
      } catch (error: any) {
        if (error?.name !== 'CanceledError' && error?.code !== 'ERR_CANCELED') {
          console.error('Failed to load full feed:', error);
        }
      } finally {
        if (!abortController.signal.aborted) setFullFeedLoading(false);
      }
    };

    loadFullFeed();

    return () => abortController.abort();
  }, [selectedPodcast?.id, selectedSearchResult?.feed_url]);

  const loadCachedData = async () => {
    setLoading(true);
    try {
      const podcastsResponse = await podcastAPI.getAll();
      setPodcasts(podcastsResponse.data);

      const feedItemsResponse = await podcastAPI.getFeedItems(undefined, PAGE_SIZE);
      const items = feedItemsResponse.data;

      const episodes = items.map((item: any) => ({
        ...item,
        podcast_id: item.feed_id,
        podcast_title: item.podcast_show_name,
      }));

      setAllEpisodes(episodes);
      setHasMoreFromServer(items.length >= PAGE_SIZE);
    } catch (error) {
      console.error('Failed to load cached feed data:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadLastRefreshTime = async () => {
    try {
      const response = await podcastAPI.getLastRefresh();
      if (response.data.lastRefresh) {
        setLastRefreshTime(new Date(response.data.lastRefresh));
      }
    } catch (error) {
      console.error('Failed to load last refresh time:', error);
    }
  };

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      console.log('Refreshing feeds from network...');
      const response = await podcastAPI.refreshFeeds();
      console.log(`Refresh complete: ${response.data.totalFeeds} feeds, ${response.data.totalItemsAdded} new items`);

      // Reload cached data
      await loadCachedData();
      await loadLastRefreshTime();
      onRefreshComplete?.();
    } catch (error) {
      console.error('Failed to refresh feeds:', error);
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleSearch = async () => {
    if (!searchQuery.trim()) return;

    setSelectedSearchResult(null);
    setSelectedPodcast(null);
    setEpisodeSearchOpen(false);
    setEpisodeSearchQuery('');
    setEpisodeSearchResults(null);
    setAllEpisodes([]);
    setLoading(true);
    setSearchError(null);
    try {
      const [searchResponse, feedItemsResponse] = await Promise.all([
        podcastAPI.search(searchQuery),
        podcastAPI.getFeedItems(undefined, PAGE_SIZE),
      ]);
      setSearchResults(searchResponse.data);
      const episodes = feedItemsResponse.data.map((item: any) => ({
        ...item,
        podcast_id: item.feed_id,
        podcast_title: item.podcast_show_name,
      }));
      setAllEpisodes(episodes);
      setHasMoreFromServer(feedItemsResponse.data.length >= PAGE_SIZE);
    } catch (error: any) {
      console.error('Search failed:', error);
      const errorMsg = error?.response?.data?.error || error?.message || 'Failed to search';
      setSearchError(errorMsg);
      setSearchResults([]);
    } finally {
      setLoading(false);
    }
  };

  const handleSubscribe = async (feedUrl: string) => {
    try {
      await podcastAPI.subscribe(feedUrl);
      // Reload subscriptions and cached data
      await loadCachedData();
      setSearchQuery('');
      setSearchResults([]);
    } catch (error) {
      console.error('Failed to subscribe:', error);
    }
  };

  const handleUnsubscribe = async (podcastId: number, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    if (!confirm('Are you sure you want to unsubscribe from this podcast?')) {
      return;
    }

    try {
      await podcastAPI.unsubscribe(podcastId);

      // Manually remove from local state to avoid full reload
      const newPodcasts = podcasts.filter(p => p.id !== podcastId);
      const newEpisodes = allEpisodes.filter(ep => ep.podcast_id !== podcastId);

      setPodcasts(newPodcasts);
      setAllEpisodes(newEpisodes);

      if (selectedPodcast?.id === podcastId) {
        setSelectedPodcast(null);
        // If we were viewing the podcast we just unsubscribed from, go back to main feed
        setAllEpisodes(newEpisodes);
        setVisibleEpisodeCount(PAGE_SIZE);
      }
    } catch (error) {
      console.error('Failed to unsubscribe:', error);
    }
  };

  const loadPodcastEpisodes = async (podcast: PodcastType) => {
    try {
      setEpisodeSearchOpen(false);
      setEpisodeSearchQuery('');
      setEpisodeSearchResults(null);
      const response = await podcastAPI.getPreviewEpisodes(podcast.id);
      const episodesWithPodcast = response.data.map((ep: any) => ({
        ...ep,
        podcast_id: podcast.id,
        podcast_title: podcast.title,
      }));
      setAllEpisodes(episodesWithPodcast);
      setVisibleEpisodeCount(PAGE_SIZE);
      setSelectedPodcast(podcast);
    } catch (error) {
      console.error('Failed to load podcast episodes:', error);
    }
  };

  const handleShowAllPodcasts = async () => {
    setSelectedPodcast(null);
    setEpisodeSearchOpen(false);
    setEpisodeSearchQuery('');
    setEpisodeSearchResults(null);
    await loadCachedData();
    setVisibleEpisodeCount(PAGE_SIZE);
  };

  const handleShowAllSearchResults = () => {
    setSelectedSearchResult(null);
    setEpisodeSearchOpen(false);
    setEpisodeSearchQuery('');
    setEpisodeSearchResults(null);
    setAllEpisodes([]);
  };

  const loadSearchResultEpisodes = async (feed: PodcastType) => {
    console.log('=== Loading search result episodes ===');
    console.log('Feed URL:', feed.feed_url);
    console.log('Feed type:', feed.type);

    try {
      const response = await podcastAPI.getPreviewByUrl(feed.feed_url);
      console.log('Episodes returned:', response.data.length, response.data);

      const episodesWithPodcast = response.data.map((ep: any) => ({
        ...ep,
        podcast_id: null,
        podcast_title: feed.title,
      }));

      console.log('Setting episodes:', episodesWithPodcast.length);
      setAllEpisodes(episodesWithPodcast);
      setVisibleEpisodeCount(PAGE_SIZE);

      console.log('Setting selected search result:', feed.title);
      setSelectedSearchResult(feed);
      console.log('=== Done ===');
    } catch (error: any) {
      console.error('Failed to load feed preview:', error);
      const errorMsg = error?.response?.data?.error || error?.message || 'Failed to load preview';
      alert(`Failed to load preview: ${errorMsg}`);
    }
  };

  const handleLoadMore = async () => {
    if (!selectedPodcast && !selectedSearchResult) {
      setLoadingMore(true);
      try {
        const offset = allEpisodes.length;
        const response = await podcastAPI.getFeedItems(undefined, PAGE_SIZE, offset);
        const newItems = response.data.map((item: any) => ({
          ...item,
          podcast_id: item.feed_id,
          podcast_title: item.podcast_show_name,
        }));
        setAllEpisodes(prev => [...prev, ...newItems]);
        if (response.data.length < PAGE_SIZE) setHasMoreFromServer(false);
      } catch (error) {
        console.error('Failed to load more:', error);
      } finally {
        setLoadingMore(false);
      }
    } else {
      setVisibleEpisodeCount(prev => prev + PAGE_SIZE);
    }
  };

  const handleAddToLibrary = async (episode: any) => {
    try {
      const itemKey = episode.audio_url || episode.url;
      setAddingToLibrary(itemKey);

      if (episode.item_type === 'article') {
        // RSS article (from newsletter / blog)
        await contentAPI.create({
          type: 'article',
          title: episode.title,
          description: episode.description,
          url: episode.url,
          podcast_id: episode.podcast_id,
          published_at: episode.published_at,
          preview_picture: episode.preview_picture, // <--- ADDED THIS
        });
      } else {
        // Podcast episode
        await contentAPI.create({
          type: 'podcast_episode',
          title: episode.title,
          description: episode.description,
          audio_url: episode.audio_url,
          podcast_id: episode.podcast_id,
          published_at: episode.published_at,
          duration: episode.duration,
          preview_picture: episode.preview_picture, // <--- ADDED THIS
        });
      }
      setAddingToLibrary(null);
    } catch (error) {
      console.error('Failed to add to library:', error);
      setAddingToLibrary(null);
    }
  };

  const clientFilteredEpisodes = episodeSearchQuery.trim()
    ? allEpisodes.filter(ep => {
        const q = episodeSearchQuery.toLowerCase();
        return (ep.title && ep.title.toLowerCase().includes(q))
          || (ep.description && cleanHtml(ep.description).toLowerCase().includes(q))
          || (ep.author && ep.author.toLowerCase().includes(q));
      })
    : allEpisodes;
  const displayEpisodes = episodeSearchResults !== null ? episodeSearchResults : clientFilteredEpisodes;
  const isDetailView = !!(selectedPodcast || selectedSearchResult);
  const visibleEpisodes = episodeSearchQuery.trim()
    ? displayEpisodes
    : isDetailView
      ? displayEpisodes.slice(0, visibleEpisodeCount)
      : displayEpisodes;
  const hasMoreEpisodes = !episodeSearchQuery.trim() && (
    isDetailView
      ? (allEpisodes.length > visibleEpisodeCount || fullFeedLoading)
      : hasMoreFromServer
  );

  const isUrl = looksLikeUrl(searchQuery);
  const buttonText = loading ? 'Loading...' : 'Search';

  const episodeSearchInputRef = React.useRef<HTMLInputElement>(null);

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
            autoFocus
          />
          <button
            className="episode-search-close"
            onClick={() => { setEpisodeSearchOpen(false); setEpisodeSearchQuery(''); setEpisodeSearchResults(null); }}
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
            onClick={() => setEpisodeSearchOpen(true)}
            title={`Search ${label.toLowerCase()}`}
          >
            <Search size={16} />
          </button>
        </>
      )}
    </div>
  );

  return (
    <div className="feed-tab">
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
          <button onClick={handleSearch} disabled={loading}>
            {buttonText}
          </button>
        </div>
      </div>

      {/* Search Error */}
      {searchError && (
        <div className="search-error" style={{ padding: '1rem', margin: '1rem 0', backgroundColor: '#fee', borderRadius: '8px', color: '#c00' }}>
          {searchError}
        </div>
      )}

      {/* Search Results */}
      {searchResults.length > 0 && !selectedSearchResult && (
        <div className="search-results">
          <div className="search-results-header">
            <h3>Search Results</h3>
            <button
              className="search-results-close"
              onClick={() => { setSearchResults([]); setSearchQuery(''); loadCachedData(); }}
              title="Close search results"
            >
              <X size={20} />
            </button>
          </div>
          {searchResults.map((podcast, index) => (
            <div
              key={index}
              className="content-card podcast-list-card"
              onClick={() => loadSearchResultEpisodes(podcast)}
              style={{ cursor: 'pointer' }}
            >
              {podcast.preview_picture && (
                <img src={podcast.preview_picture} alt={podcast.title} className="thumbnail" />
              )}
              <div className="content-info">
                <h3>{podcast.title}</h3>
                <p className="author">{podcast.author}</p>
                {podcast.description && (
                  <p className="description">{cleanHtml(podcast.description).slice(0, 150)}...</p>
                )}
                <div className="metadata">
                  <span className="type">
                    {podcast.type === 'podcast' && <Podcast size={16} className="icon-podcast" />}
                    {podcast.type === 'newsletter' && <Newspaper size={16} className="icon-article" />}
                  </span>
                </div>
              </div>
              <div className="content-actions" onClick={(e) => e.stopPropagation()}>
                <button onClick={() => handleSubscribe(podcast.feed_url)} title="Subscribe">
                  <Plus size={16} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Selected Search Result Preview */}
      {selectedSearchResult && (
        <div className="selected-podcast-view">
          {/* Back button */}
          <button className="show-all-btn" onClick={handleShowAllSearchResults}>
            <ArrowLeft size={16} />
            Show All Search Results
          </button>

          {/* Expanded Feed Card */}
          <div className="content-card selected-podcast-card">
            {selectedSearchResult.preview_picture && (
              <img src={selectedSearchResult.preview_picture} alt={selectedSearchResult.title} className="thumbnail" />
            )}
            <div className="content-info">
              <h3>{selectedSearchResult.title}</h3>
              <p className="author">{selectedSearchResult.author}</p>
              {selectedSearchResult.description && (
                <p className="description selected-podcast-description">
                  {cleanHtml(selectedSearchResult.description)}
                </p>
              )}
              <div className="metadata">
                <span className="type">
                  {selectedSearchResult.type === 'podcast' && <Podcast size={16} className="icon-podcast" />}
                  {selectedSearchResult.type === 'newsletter' && <Newspaper size={16} className="icon-article" />}
                </span>
              </div>
            </div>
            <div className="content-actions">
              <button
                onClick={() => handleSubscribe(selectedSearchResult.feed_url)}
                className="subscribe-btn"
                title="Subscribe"
              >
                <Plus size={16} />
              </button>
            </div>
          </div>

          {/* Episodes/Articles preview */}
          <div className="episodes-section">
            {renderEpisodeSectionHeader('Preview')}
            {episodeSearchQuery.trim() && episodeSearchLoading && (
              <p className="no-content"><RefreshCw size={14} className="spinning" style={{ verticalAlign: 'middle', marginRight: '0.5rem' }} />Searching full feed...</p>
            )}
            {episodeSearchQuery.trim() && !episodeSearchLoading && visibleEpisodes.length === 0 && (
              <p className="no-content">No matches found.</p>
            )}
            {visibleEpisodes.map((episode, index) => (
              <div key={episode.audio_url || episode.url || index} className="content-card">
                {episode.preview_picture && (
                  <img src={episode.preview_picture} alt={episode.title} className="thumbnail" />
                )}
                <div className="content-info">
                  <h3>{episode.title}</h3>
                  <p className="author">
                    {episode.author && <>{episode.author} • </>}
                    {episode.published_at && new Date(episode.published_at).toLocaleDateString('en-GB')}
                    {episode.duration && <> • {formatDuration(episode.duration)}</>}
                  </p>
                  {episode.url && episode.item_type === 'article' && (
                    <p className="content-source-link">
                      <a href={episode.url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
                        {getDomainFromUrl(episode.url)}
                        <SquareArrowOutUpRight size={12} style={{ marginLeft: '0.25rem' }} />
                      </a>
                    </p>
                  )}
                  {episode.description && (
                    <p className="description">{cleanHtml(episode.description).slice(0, 150)}...</p>
                  )}
                  <div className="metadata">
                    <span className="type">
                      {episode.item_type === 'podcast_episode' && <Podcast size={16} className="icon-podcast" />}
                      {episode.item_type === 'article' && <Newspaper size={16} className="icon-article" />}
                    </span>
                    {episode.duration && <span className="duration">{formatDuration(episode.duration)}</span>}
                  </div>
                </div>
                <div className="content-actions">
                  <button
                    onClick={() => handleAddToLibrary(episode)}
                    disabled={addingToLibrary === (episode.audio_url || episode.url)}
                    title={addingToLibrary === (episode.audio_url || episode.url) ? 'Adding...' : 'Add to Library'}
                  >
                    <Plus size={16} />
                  </button>
                </div>
              </div>
            ))}
            {hasMoreEpisodes && (
              (fullFeedLoading && allEpisodes.length <= visibleEpisodeCount) ? (
                <p className="no-content"><RefreshCw size={14} className="spinning" style={{ verticalAlign: 'middle', marginRight: '0.5rem' }} />Loading more...</p>
              ) : (
                <button className="load-more-btn" onClick={handleLoadMore}>Load More</button>
              )
            )}
          </div>
        </div>
      )}

      {/* Selected Podcast View - Expanded card with episodes below */}
      {selectedPodcast && !selectedSearchResult ? (
        <div className="selected-podcast-view">
          {/* Back / Show All button */}
          <button className="show-all-btn" onClick={handleShowAllPodcasts}>
            <ArrowLeft size={16} />
            Show All Subscriptions
          </button>

          {/* Expanded Podcast Card */}
          <div className="content-card selected-podcast-card">
            {selectedPodcast.preview_picture && (
              <img src={selectedPodcast.preview_picture} alt={selectedPodcast.title} className="thumbnail" />
            )}
            <div className="content-info">
              <h3>{selectedPodcast.title}</h3>
              <p className="author">{selectedPodcast.author}</p>
              {selectedPodcast.description && (
                <p className="description selected-podcast-description">
                  {cleanHtml(selectedPodcast.description)}
                </p>
              )}
              <div className="metadata">
                <span className="type">
                  {selectedPodcast.type === 'podcast' && <Podcast size={16} className="icon-podcast" />}
                  {selectedPodcast.type === 'newsletter' && <Newspaper size={16} className="icon-article" />}
                </span>
              </div>
            </div>
            <div className="content-actions">
              <button
                onClick={(e) => handleUnsubscribe(selectedPodcast.id, e)}
                className="unsubscribe-btn"
                title="Unsubscribe"
              >
                <X size={16} />
              </button>
            </div>
          </div>

          {/* Episodes for selected podcast */}
          <div className="episodes-section">
            {renderEpisodeSectionHeader(selectedPodcast.type === 'podcast' ? 'Episodes' : 'Articles')}
            {episodeSearchQuery.trim() && episodeSearchLoading && (
              <p className="no-content"><RefreshCw size={14} className="spinning" style={{ verticalAlign: 'middle', marginRight: '0.5rem' }} />Searching full feed...</p>
            )}
            {episodeSearchQuery.trim() && !episodeSearchLoading && visibleEpisodes.length === 0 && (
              <p className="no-content">No matches found.</p>
            )}
            {visibleEpisodes.map((episode, index) => (
              <div key={episode.audio_url || episode.url || index} className="content-card">
                {episode.preview_picture && (
                  <img src={episode.preview_picture} alt={episode.title} className="thumbnail" />
                )}
                <div className="content-info">
                  <h3>{episode.title}</h3>
                  <p className="author">
                    {episode.author && <>{episode.author} • </>}
                    {episode.published_at && new Date(episode.published_at).toLocaleDateString('en-GB')}
                    {episode.duration && <> • {formatDuration(episode.duration)}</>}
                  </p>
                  {episode.url && episode.item_type === 'article' && (
                    <p className="content-source-link">
                      <a href={episode.url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
                        {getDomainFromUrl(episode.url)}
                        <SquareArrowOutUpRight size={12} style={{ marginLeft: '0.25rem' }} />
                      </a>
                    </p>
                  )}
                  {episode.description && (
                    <p className="description">{cleanHtml(episode.description).slice(0, 150)}...</p>
                  )}
                  <div className="metadata">
                    <span className="type">
                      {episode.item_type === 'podcast_episode' && <Podcast size={16} className="icon-podcast" />}
                      {episode.item_type === 'article' && <Newspaper size={16} className="icon-article" />}
                    </span>
                    {episode.duration && <span className="duration">{formatDuration(episode.duration)}</span>}
                  </div>
                </div>
                <div className="content-actions">
                  <button
                    onClick={() => handleAddToLibrary(episode)}
                    disabled={addingToLibrary === (episode.audio_url || episode.url)}
                    title={addingToLibrary === (episode.audio_url || episode.url) ? 'Adding...' : 'Add to Library'}
                  >
                    <Plus size={16} />
                  </button>
                </div>
              </div>
            ))}
            {hasMoreEpisodes && (
              (fullFeedLoading && allEpisodes.length <= visibleEpisodeCount) ? (
                <p className="no-content"><RefreshCw size={14} className="spinning" style={{ verticalAlign: 'middle', marginRight: '0.5rem' }} />Loading more...</p>
              ) : (
                <button className="load-more-btn" onClick={handleLoadMore}>Load More</button>
              )
            )}
          </div>
        </div>
      ) : !selectedSearchResult && (
        <>
          {/* Collapsible Subscriptions Section */}
          <div className="subscribed-podcasts-section">
            <button
              className="section-header"
              onClick={() => setPodcastsExpanded(!podcastsExpanded)}
            >
              <h3>Subscriptions ({podcasts.length})</h3>
              {podcastsExpanded ? <ChevronDown size={20} /> : <ChevronRight size={20} />}
            </button>

            {podcastsExpanded && (
              <div className="podcast-list">
                {podcasts.map((podcast) => (
                  <div
                    key={podcast.id}
                    className="content-card podcast-list-card"
                    onClick={() => loadPodcastEpisodes(podcast)}
                  >
                    {podcast.preview_picture && (
                      <img src={podcast.preview_picture} alt={podcast.title} className="thumbnail" />
                    )}
                    <div className="content-info">
                      <h3>{podcast.title}</h3>
                      <p className="author">{podcast.author}</p>
                      <div className="metadata">
                        <span className="type">
                          {podcast.type === 'podcast' && <Podcast size={16} className="icon-podcast" />}
                          {podcast.type === 'newsletter' && <Newspaper size={16} className="icon-article" />}
                        </span>
                      </div>
                    </div>
                    <div className="content-actions" onClick={(e) => e.stopPropagation()}>
                      <button
                        onClick={(e) => handleUnsubscribe(podcast.id, e)}
                        className="unsubscribe-btn"
                        title="Unsubscribe"
                      >
                        <X size={16} />
                      </button>
                    </div>
                  </div>
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
                disabled={isRefreshing}
                title={isRefreshing ? 'Refreshing...' : 'Refresh feeds from network'}
                style={{
                  padding: '0.5rem',
                  border: 'none',
                  background: 'transparent',
                  cursor: isRefreshing ? 'wait' : 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                  color: 'var(--text-secondary)',
                  fontSize: '0.9rem'
                }}
              >
                <RefreshCw size={16} className={isRefreshing ? 'spinning' : ''} />
                {lastRefreshTime && !isRefreshing && (
                  <span style={{ fontSize: '0.85rem' }}>
                    {formatRefreshTime(lastRefreshTime)}
                  </span>
                )}
                {isRefreshing && <span>Refreshing...</span>}
              </button>
            </div>
            {visibleEpisodes.map((episode, index) => (
              <div key={episode.audio_url || episode.url || index} className="content-card">
                {episode.preview_picture && (
                  <img src={episode.preview_picture} alt={episode.title} className="thumbnail" />
                )}
                <div className="content-info">
                  <h3>{episode.title}</h3>
                  <p className="author">
                    {episode.author && <>{episode.author} • </>}
                    {episode.podcast_title}
                    {episode.published_at && <> • {new Date(episode.published_at).toLocaleDateString('en-GB')}</>}
                  </p>
                  {episode.url && episode.item_type === 'article' && (
                    <p className="content-source-link">
                      <a href={episode.url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
                        {getDomainFromUrl(episode.url)}
                        <SquareArrowOutUpRight size={12} style={{ marginLeft: '0.25rem' }} />
                      </a>
                    </p>
                  )}
                  {episode.description && (
                    <p className="description">{cleanHtml(episode.description).slice(0, 150)}...</p>
                  )}
                  <div className="metadata">
                    <span className="type">
                      {episode.item_type === 'podcast_episode' && <Podcast size={16} className="icon-podcast" />}
                      {episode.item_type === 'article' && <Newspaper size={16} className="icon-article" />}
                    </span>
                    {episode.duration && <span className="duration">{formatDuration(episode.duration)}</span>}
                  </div>
                </div>
                <div className="content-actions">
                  <button
                    onClick={() => handleAddToLibrary(episode)}
                    disabled={addingToLibrary === (episode.audio_url || episode.url)}
                    title={addingToLibrary === (episode.audio_url || episode.url) ? 'Adding...' : 'Add to Library'}
                  >
                    <Plus size={16} />
                  </button>
                </div>
              </div>
            ))}
            {hasMoreEpisodes && (
              loadingMore ? (
                <p className="no-content"><RefreshCw size={14} className="spinning" style={{ verticalAlign: 'middle', marginRight: '0.5rem' }} />Loading more...</p>
              ) : (
                <button className="load-more-btn" onClick={handleLoadMore}>Load More</button>
              )
            )}
          </div>
        </>
      )}
    </div>
  );
}
