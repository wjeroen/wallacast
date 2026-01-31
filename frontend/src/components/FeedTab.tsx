import { useState, useEffect } from 'react';
import { Search, Plus, X, ChevronDown, ChevronRight, ArrowLeft, Podcast, Newspaper, Link } from 'lucide-react';
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

const EPISODES_PER_PAGE = 20;

// Helper function to detect if query looks like a URL
function looksLikeUrl(query: string): boolean {
  return (
    query.includes('://') ||
    (query.includes('.') && !query.includes(' ')) ||
    query.startsWith('www.')
  );
}

export function FeedTab() {
  const [podcasts, setPodcasts] = useState<PodcastType[]>([]);
  const [allEpisodes, setAllEpisodes] = useState<any[]>([]);
  const [visibleEpisodeCount, setVisibleEpisodeCount] = useState(EPISODES_PER_PAGE);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<PodcastType[]>([]);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedPodcast, setSelectedPodcast] = useState<PodcastType | null>(null);
  const [selectedSearchResult, setSelectedSearchResult] = useState<PodcastType | null>(null);
  const [addingToLibrary, setAddingToLibrary] = useState<string | null>(null);
  const [podcastsExpanded, setPodcastsExpanded] = useState(false);

  useEffect(() => {
    loadPodcasts();
    loadLatestEpisodes();
  }, []);

  const loadPodcasts = async () => {
    try {
      const response = await podcastAPI.getAll();
      setPodcasts(response.data);
    } catch (error) {
      console.error('Failed to load podcasts:', error);
    }
  };

  const loadLatestEpisodes = async () => {
    try {
      // Load episodes from all subscribed podcasts
      const podcastsResponse = await podcastAPI.getAll();
      const episodes: any[] = [];

      for (const podcast of podcastsResponse.data) {
        try {
          const episodesResponse = await podcastAPI.getPreviewEpisodes(podcast.id);
          const episodesWithPodcast = episodesResponse.data.map((ep: any) => ({
            ...ep,
            podcast_id: podcast.id,
            podcast_title: podcast.title,
          }));
          episodes.push(...episodesWithPodcast);
        } catch (error) {
          console.error(`Failed to load episodes for podcast ${podcast.id}:`, error);
        }
      }

      // Sort by published date
      episodes.sort((a, b) => new Date(b.published_at).getTime() - new Date(a.published_at).getTime());
      setAllEpisodes(episodes);
      setVisibleEpisodeCount(EPISODES_PER_PAGE);
    } catch (error) {
      console.error('Failed to load episodes:', error);
    }
  };

  const handleSearch = async () => {
    if (!searchQuery.trim()) return;

    setLoading(true);
    setSearchError(null);
    try {
      const response = await podcastAPI.search(searchQuery);
      setSearchResults(response.data);
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
      loadPodcasts();
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
      loadPodcasts();
      if (selectedPodcast?.id === podcastId) {
        setSelectedPodcast(null);
        loadLatestEpisodes();
      }
    } catch (error) {
      console.error('Failed to unsubscribe:', error);
    }
  };

  const loadPodcastEpisodes = async (podcast: PodcastType) => {
    try {
      const response = await podcastAPI.getPreviewEpisodes(podcast.id);
      const episodesWithPodcast = response.data.map((ep: any) => ({
        ...ep,
        podcast_id: podcast.id,
        podcast_title: podcast.title,
      }));
      setAllEpisodes(episodesWithPodcast);
      setVisibleEpisodeCount(EPISODES_PER_PAGE);
      setSelectedPodcast(podcast);
    } catch (error) {
      console.error('Failed to load podcast episodes:', error);
    }
  };

  const handleShowAllPodcasts = () => {
    setSelectedPodcast(null);
    loadLatestEpisodes();
  };

  const handleShowAllSearchResults = () => {
    setSelectedSearchResult(null);
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
      setVisibleEpisodeCount(EPISODES_PER_PAGE);

      console.log('Setting selected search result:', feed.title);
      setSelectedSearchResult(feed);
      console.log('=== Done ===');
    } catch (error: any) {
      console.error('Failed to load feed preview:', error);
      const errorMsg = error?.response?.data?.error || error?.message || 'Failed to load preview';
      alert(`Failed to load preview: ${errorMsg}`);
    }
  };

  const handleLoadMore = () => {
    setVisibleEpisodeCount(prev => prev + EPISODES_PER_PAGE);
  };

  const handleAddToLibrary = async (episode: any) => {
    try {
      const itemKey = episode.audio_url || episode.url;
      setAddingToLibrary(itemKey);

      if (episode.item_type === 'article') {
        // RSS article (from newsletter/blog)
        await contentAPI.create({
          type: 'article',
          title: episode.title,
          description: episode.description,
          url: episode.url,
          podcast_id: episode.podcast_id,
          published_at: episode.published_at,
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
        });
      }
      setAddingToLibrary(null);
    } catch (error) {
      console.error('Failed to add to library:', error);
      setAddingToLibrary(null);
    }
  };

  const visibleEpisodes = allEpisodes.slice(0, visibleEpisodeCount);
  const hasMoreEpisodes = allEpisodes.length > visibleEpisodeCount;

  const isUrl = looksLikeUrl(searchQuery);
  const buttonText = loading ? 'Loading...' : 'Search';

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
              onClick={() => { setSearchResults([]); setSearchQuery(''); }}
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
                    {podcast.type === 'podcast' && <Podcast size={16} />}
                    {podcast.type === 'newsletter' && <Newspaper size={16} />}
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
                  {selectedSearchResult.type === 'podcast' && <Podcast size={16} />}
                  {selectedSearchResult.type === 'newsletter' && <Newspaper size={16} />}
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
            <h3>Preview</h3>
            {visibleEpisodes.map((episode, index) => (
              <div key={episode.audio_url || episode.url || index} className="content-card">
                {episode.preview_picture && (
                  <img src={episode.preview_picture} alt={episode.title} className="thumbnail" />
                )}
                <div className="content-info">
                  <h3>{episode.title}</h3>
                  <p className="author">
                    {episode.published_at && new Date(episode.published_at).toLocaleDateString()}
                    {episode.duration && <> • {formatDuration(episode.duration)}</>}
                  </p>
                  {episode.description && (
                    <p className="description">{cleanHtml(episode.description).slice(0, 150)}...</p>
                  )}
                  <div className="metadata">
                    <span className="type">
                      {episode.item_type === 'podcast_episode' && <Podcast size={16} />}
                      {episode.item_type === 'article' && <Newspaper size={16} />}
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
              <button className="load-more-btn" onClick={handleLoadMore}>
                Load More
              </button>
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
                  {selectedPodcast.type === 'podcast' && <Podcast size={16} />}
                  {selectedPodcast.type === 'newsletter' && <Newspaper size={16} />}
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
            <h3>{selectedPodcast.type === 'podcast' ? 'Episodes' : 'Articles'}</h3>
            {visibleEpisodes.map((episode, index) => (
              <div key={episode.audio_url || episode.url || index} className="content-card">
                {episode.preview_picture && (
                  <img src={episode.preview_picture} alt={episode.title} className="thumbnail" />
                )}
                <div className="content-info">
                  <h3>{episode.title}</h3>
                  <p className="author">
                    {episode.published_at && new Date(episode.published_at).toLocaleDateString()}
                    {episode.duration && <> • {formatDuration(episode.duration)}</>}
                  </p>
                  {episode.description && (
                    <p className="description">{cleanHtml(episode.description).slice(0, 150)}...</p>
                  )}
                  <div className="metadata">
                    <span className="type">
                      {episode.item_type === 'podcast_episode' && <Podcast size={16} />}
                      {episode.item_type === 'article' && <Newspaper size={16} />}
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
              <button className="load-more-btn" onClick={handleLoadMore}>
                Load More
              </button>
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
                          {podcast.type === 'podcast' && <Podcast size={16} />}
                          {podcast.type === 'newsletter' && <Newspaper size={16} />}
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
            <h3>Recent Updates</h3>
            {visibleEpisodes.map((episode, index) => (
              <div key={episode.audio_url || episode.url || index} className="content-card">
                {episode.preview_picture && (
                  <img src={episode.preview_picture} alt={episode.title} className="thumbnail" />
                )}
                <div className="content-info">
                  <h3>{episode.title}</h3>
                  <p className="author">
                    {episode.podcast_title}
                    {episode.published_at && <> • {new Date(episode.published_at).toLocaleDateString()}</>}
                  </p>
                  {episode.description && (
                    <p className="description">{cleanHtml(episode.description).slice(0, 150)}...</p>
                  )}
                  <div className="metadata">
                    <span className="type">
                      {episode.item_type === 'podcast_episode' && <Podcast size={16} />}
                      {episode.item_type === 'article' && <Newspaper size={16} />}
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
              <button className="load-more-btn" onClick={handleLoadMore}>
                Load More
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
