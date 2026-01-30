import { useState, useEffect } from 'react';
import { Search, Plus, X } from 'lucide-react';
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

export function FeedTab() {
  const [podcasts, setPodcasts] = useState<Podcast[]>([]);
  const [episodes, setEpisodes] = useState<any[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Podcast[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedPodcast, setSelectedPodcast] = useState<number | null>(null);
  const [addingToLibrary, setAddingToLibrary] = useState<string | null>(null);

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
      const allEpisodes: any[] = [];

      for (const podcast of podcastsResponse.data) {
        try {
          const episodesResponse = await podcastAPI.getPreviewEpisodes(podcast.id);
          const episodesWithPodcast = episodesResponse.data.map((ep: any) => ({
            ...ep,
            podcast_id: podcast.id,
            podcast_title: podcast.title,
          }));
          allEpisodes.push(...episodesWithPodcast);
        } catch (error) {
          console.error(`Failed to load episodes for podcast ${podcast.id}:`, error);
        }
      }

      // Sort by published date and take the 20 most recent
      allEpisodes.sort((a, b) => new Date(b.published_at).getTime() - new Date(a.published_at).getTime());
      setEpisodes(allEpisodes.slice(0, 20));
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

  const handleUnsubscribe = async (podcastId: number) => {
    if (!confirm('Are you sure you want to unsubscribe from this podcast?')) {
      return;
    }

    try {
      await podcastAPI.unsubscribe(podcastId);
      loadPodcasts();
      if (selectedPodcast === podcastId) {
        setSelectedPodcast(null);
        loadLatestEpisodes();
      }
    } catch (error) {
      console.error('Failed to unsubscribe:', error);
    }
  };

  const loadPodcastEpisodes = async (podcastId: number) => {
    try {
      const response = await podcastAPI.getPreviewEpisodes(podcastId);
      const podcast = podcasts.find(p => p.id === podcastId);
      const episodesWithPodcast = response.data.map((ep: any) => ({
        ...ep,
        podcast_id: podcastId,
        podcast_title: podcast?.title,
      }));
      setEpisodes(episodesWithPodcast);
      setSelectedPodcast(podcastId);
    } catch (error) {
      console.error('Failed to load podcast episodes:', error);
    }
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

  return (
    <div className="feed-tab">
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

      {searchResults.length > 0 && (
        <div className="search-results">
          <h3>Search Results</h3>
          {searchResults.map((podcast, index) => (
            <div key={index} className="podcast-card">
              {podcast.preview_picture && (
                <img src={podcast.preview_picture} alt={podcast.title} />
              )}
              <div className="podcast-info">
                <h4>{podcast.title}</h4>
                <p className="author">{podcast.author}</p>
                {podcast.description && (
                  <p className="description">{cleanHtml(podcast.description).slice(0, 150)}...</p>
                )}
              </div>
              <button onClick={() => handleSubscribe(podcast.feed_url)}>
                <Plus size={16} /> Subscribe
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="subscribed-podcasts">
        <h3>Subscribed Podcasts</h3>
        <div className="podcast-list">
          {podcasts.map((podcast) => (
            <div
              key={podcast.id}
              className={`podcast-card ${selectedPodcast === podcast.id ? 'selected' : ''}`}
              onClick={() => loadPodcastEpisodes(podcast.id)}
            >
              {podcast.preview_picture && (
                <img src={podcast.preview_picture} alt={podcast.title} />
              )}
              <div className="podcast-info">
                <h4>{podcast.title}</h4>
                <p className="author">{podcast.author}</p>
              </div>
              <div className="podcast-actions">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleUnsubscribe(podcast.id);
                  }}
                  className="unsubscribe-btn"
                  title="Unsubscribe"
                >
                  <X size={16} />
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="episodes-list">
        <h3>{selectedPodcast ? 'Episodes' : 'Latest Episodes'}</h3>
        {selectedPodcast && podcasts.find(p => p.id === selectedPodcast) && (
          <div className="podcast-details">
            <h4>{podcasts.find(p => p.id === selectedPodcast)?.title}</h4>
            {podcasts.find(p => p.id === selectedPodcast)?.description && (
              <p className="podcast-description">{cleanHtml(podcasts.find(p => p.id === selectedPodcast)?.description || '')}</p>
            )}
          </div>
        )}
        {episodes.map((episode, index) => (
          <div key={episode.audio_url || index} className="episode-card">
            {episode.preview_picture && (
              <img src={episode.preview_picture} alt={episode.title} />
            )}
            <div className="episode-info">
              <h4>{episode.title}</h4>
              {episode.podcast_title && (
                <p className="podcast-name">{episode.podcast_title}</p>
              )}
              {episode.description && (
                <p className="description">{cleanHtml(episode.description).slice(0, 150)}...</p>
              )}
              <div className="episode-meta">
                {episode.duration && (
                  <span className="duration">{formatDuration(episode.duration)}</span>
                )}
                {episode.published_at && (
                  <span className="date">{new Date(episode.published_at).toLocaleDateString()}</span>
                )}
              </div>
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
      </div>
    </div>
  );
}

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${secs.toString().padStart(2, '0')}`;
}
