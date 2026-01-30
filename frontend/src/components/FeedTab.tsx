import { useState, useEffect } from 'react';
import { Search, Plus, X, ChevronDown, ChevronRight, ArrowLeft } from 'lucide-react';
import { podcastAPI, contentAPI } from '../api';
import type { Podcast } from '../types';

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

export function FeedTab() {
  const [podcasts, setPodcasts] = useState<Podcast[]>([]);
  const [allEpisodes, setAllEpisodes] = useState<any[]>([]);
  const [visibleEpisodeCount, setVisibleEpisodeCount] = useState(EPISODES_PER_PAGE);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Podcast[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedPodcast, setSelectedPodcast] = useState<Podcast | null>(null);
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
    try {
      const response = await podcastAPI.search(searchQuery);
      setSearchResults(response.data);
    } catch (error) {
      console.error('Search failed:', error);
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

  const loadPodcastEpisodes = async (podcast: Podcast) => {
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

  const handleLoadMore = () => {
    setVisibleEpisodeCount(prev => prev + EPISODES_PER_PAGE);
  };

  const handleAddToLibrary = async (episode: any) => {
    try {
      setAddingToLibrary(episode.audio_url);
      await contentAPI.create({
        type: 'podcast_episode',
        title: episode.title,
        description: episode.description,
        audio_url: episode.audio_url,
        podcast_id: episode.podcast_id,
        published_at: episode.published_at,
        duration: episode.duration,
      });
      setAddingToLibrary(null);
    } catch (error) {
      console.error('Failed to add to library:', error);
      setAddingToLibrary(null);
    }
  };

  const visibleEpisodes = allEpisodes.slice(0, visibleEpisodeCount);
  const hasMoreEpisodes = allEpisodes.length > visibleEpisodeCount;

  return (
    <div className="feed-tab">
      {/* Search Bar */}
      <div className="search-bar">
        <div className="search-input-group">
          <Search size={20} />
          <input
            type="text"
            placeholder="Search for podcasts..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && handleSearch()}
          />
          <button onClick={handleSearch} disabled={loading}>
            {loading ? 'Searching...' : 'Search'}
          </button>
        </div>
      </div>

      {/* Search Results */}
      {searchResults.length > 0 && (
        <div className="search-results">
          <button
            className="search-results-header"
            onClick={() => { setSearchResults([]); setSearchQuery(''); }}
          >
            <h3>Search Results</h3>
            <X size={20} />
          </button>
          {searchResults.map((podcast, index) => (
            <div key={index} className="content-card">
              {podcast.preview_picture && (
                <img src={podcast.preview_picture} alt={podcast.title} className="thumbnail" />
              )}
              <div className="content-info">
                <h3>{podcast.title}</h3>
                <p className="author">{podcast.author}</p>
                {podcast.description && (
                  <p className="description">{cleanHtml(podcast.description).slice(0, 150)}...</p>
                )}
              </div>
              <div className="content-actions">
                <button onClick={() => handleSubscribe(podcast.feed_url)} title="Subscribe">
                  <Plus size={16} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Selected Podcast View - Expanded card with episodes below */}
      {selectedPodcast ? (
        <div className="selected-podcast-view">
          {/* Back / Show All button */}
          <button className="show-all-btn" onClick={handleShowAllPodcasts}>
            <ArrowLeft size={16} />
            Show All Podcasts
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
            <h3>Episodes</h3>
            {visibleEpisodes.map((episode, index) => (
              <div key={episode.audio_url || index} className="content-card">
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
                </div>
                <div className="content-actions">
                  <button
                    onClick={() => handleAddToLibrary(episode)}
                    disabled={addingToLibrary === episode.audio_url}
                    title={addingToLibrary === episode.audio_url ? 'Adding...' : 'Add to Library'}
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
      ) : (
        <>
          {/* Collapsible Subscribed Podcasts Section */}
          <div className="subscribed-podcasts-section">
            <button
              className="section-header"
              onClick={() => setPodcastsExpanded(!podcastsExpanded)}
            >
              <h3>Subscribed Podcasts ({podcasts.length})</h3>
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

          {/* Latest Episodes */}
          <div className="episodes-section">
            <h3>Latest Episodes</h3>
            {visibleEpisodes.map((episode, index) => (
              <div key={episode.audio_url || index} className="content-card">
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
                  {episode.duration && (
                    <div className="metadata">
                      <span className="duration">{formatDuration(episode.duration)}</span>
                    </div>
                  )}
                </div>
                <div className="content-actions">
                  <button
                    onClick={() => handleAddToLibrary(episode)}
                    disabled={addingToLibrary === episode.audio_url}
                    title={addingToLibrary === episode.audio_url ? 'Adding...' : 'Add to Library'}
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
