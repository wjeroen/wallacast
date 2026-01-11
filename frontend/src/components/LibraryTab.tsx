import { useState, useEffect } from 'react';
import { Star, Archive, Trash2, Volume2, FileText, CheckSquare, Square } from 'lucide-react';
import { contentAPI } from '../api';
import type { ContentItem } from '../types';

type FilterType = 'all' | 'articles' | 'podcasts' | 'favorites' | 'archived';

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

export function LibraryTab({ onPlayContent }: { onPlayContent: (content: ContentItem) => void }) {
  const [content, setContent] = useState<ContentItem[]>([]);
  const [filter, setFilter] = useState<FilterType>('all');
  const [loading, setLoading] = useState(true);
  const [selectedItems, setSelectedItems] = useState<Set<number>>(new Set());
  const [bulkMode, setBulkMode] = useState(false);

  useEffect(() => {
    loadContent();
  }, [filter]);

  // Poll for progress updates on items that are generating
  useEffect(() => {
    const generatingItems = content.filter(
      item => item.generation_status === 'generating_audio' || item.generation_status === 'generating_transcript'
    );

    if (generatingItems.length === 0) return;

    const pollInterval = setInterval(() => {
      // Refresh content to get latest generation status
      loadContent();
    }, 2000); // Poll every 2 seconds

    return () => clearInterval(pollInterval);
  }, [content]);

  const loadContent = async () => {
    setLoading(true);
    try {
      const params: any = {};

      if (filter === 'articles') {
        params.type = 'article';
      } else if (filter === 'podcasts') {
        params.type = 'podcast_episode';
      } else if (filter === 'favorites') {
        params.favorite = true;
      } else if (filter === 'archived') {
        params.archived = true;
      }

      const response = await contentAPI.getAll(params);
      setContent(response.data);
    } catch (error) {
      console.error('Failed to load content:', error);
    } finally {
      setLoading(false);
    }
  };

  const handlePlayContent = async (item: ContentItem) => {
    try {
      // Fetch latest content data to get current playback position
      const response = await contentAPI.getById(item.id);
      onPlayContent(response.data);
    } catch (error) {
      console.error('Failed to load content details:', error);
      // Fall back to using the list item if fetch fails
      onPlayContent(item);
    }
  };

  const handleToggleFavorite = async (id: number, isFavorite: boolean) => {
    try {
      await contentAPI.update(id, { is_favorite: !isFavorite });
      loadContent();
    } catch (error) {
      console.error('Failed to toggle favorite:', error);
    }
  };

  const handleToggleArchive = async (id: number, isArchived: boolean) => {
    try {
      await contentAPI.update(id, { is_archived: !isArchived });
      loadContent();
    } catch (error) {
      console.error('Failed to toggle archive:', error);
    }
  };

  const handleMarkAsRead = async (id: number) => {
    try {
      await contentAPI.update(id, { is_read: true });
      loadContent();
    } catch (error) {
      console.error('Failed to mark as read:', error);
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await contentAPI.delete(id);
      loadContent();
    } catch (error) {
      console.error('Failed to delete content:', error);
    }
  };

  const toggleSelection = (id: number) => {
    const newSelected = new Set(selectedItems);
    if (newSelected.has(id)) {
      newSelected.delete(id);
    } else {
      newSelected.add(id);
    }
    setSelectedItems(newSelected);
  };

  const selectAll = () => {
    setSelectedItems(new Set(content.map(item => item.id)));
  };

  const deselectAll = () => {
    setSelectedItems(new Set());
  };

  const handleBulkDelete = async () => {
    try {
      await Promise.all(Array.from(selectedItems).map(id => contentAPI.delete(id)));
      setSelectedItems(new Set());
      loadContent();
    } catch (error) {
      console.error('Failed to bulk delete:', error);
    }
  };

  const handleBulkArchive = async () => {
    try {
      await Promise.all(Array.from(selectedItems).map(id => contentAPI.update(id, { is_archived: true })));
      setSelectedItems(new Set());
      loadContent();
    } catch (error) {
      console.error('Failed to bulk archive:', error);
    }
  };

  const handleBulkFavorite = async () => {
    try {
      await Promise.all(Array.from(selectedItems).map(id => contentAPI.update(id, { is_favorite: true })));
      setSelectedItems(new Set());
      loadContent();
    } catch (error) {
      console.error('Failed to bulk favorite:', error);
    }
  };

  const handleGenerateAudio = async (id: number, regenerate: boolean = false) => {
    try {
      const response = await contentAPI.generateAudio(id, regenerate);
      // Generation started in background, polling will update status
      loadContent();
    } catch (error: any) {
      console.error('Failed to generate audio:', error);
      const errorMsg = error?.response?.data?.error || 'Failed to generate audio';
      alert(errorMsg);
    }
  };

  const getGenerationStatusDisplay = (item: ContentItem) => {
    if (!item.generation_status || item.generation_status === 'idle') {
      return null;
    }

    if (item.generation_status === 'completed') {
      return null; // Don't show anything for completed
    }

    if (item.generation_status === 'failed') {
      return (
        <div className="generation-status error">
          <span>❌ Generation failed</span>
          {item.generation_error && <span className="error-detail">: {item.generation_error}</span>}
        </div>
      );
    }

    // Generating
    const operation = item.current_operation === 'audio' ? 'Audio' : 'Transcript';
    const progress = item.generation_progress || 0;

    return (
      <div className="generation-status generating">
        <span>🔄 Generating {operation}...</span>
        <div className="progress-bar-container">
          <div className="progress-bar-fill" style={{ width: `${progress}%` }}></div>
          <span className="progress-text">{progress}%</span>
        </div>
      </div>
    );
  };

  return (
    <div className="library-tab">
      <div className="library-header">
        <h2>Library</h2>
        <button onClick={() => { setBulkMode(!bulkMode); setSelectedItems(new Set()); }} className="bulk-mode-btn">
          {bulkMode ? 'Cancel' : 'Select'}
        </button>
        {bulkMode && selectedItems.size > 0 && (
          <div className="bulk-actions">
            <span>{selectedItems.size} selected</span>
            <button onClick={selectAll}>All</button>
            <button onClick={deselectAll}>None</button>
            <button onClick={handleBulkFavorite}><Star size={16} /></button>
            <button onClick={handleBulkArchive}><Archive size={16} /></button>
            <button onClick={handleBulkDelete}><Trash2 size={16} /></button>
          </div>
        )}
        <div className="filter-buttons">
          <button
            className={filter === 'all' ? 'active' : ''}
            onClick={() => setFilter('all')}
          >
            All
          </button>
          <button
            className={filter === 'articles' ? 'active' : ''}
            onClick={() => setFilter('articles')}
          >
            Articles
          </button>
          <button
            className={filter === 'podcasts' ? 'active' : ''}
            onClick={() => setFilter('podcasts')}
          >
            Podcasts
          </button>
          <button
            className={filter === 'favorites' ? 'active' : ''}
            onClick={() => setFilter('favorites')}
          >
            <Star size={16} /> Favorites
          </button>
          <button
            className={filter === 'archived' ? 'active' : ''}
            onClick={() => setFilter('archived')}
          >
            <Archive size={16} /> Archived
          </button>
        </div>
      </div>

      {loading ? (
        <div className="loading">Loading...</div>
      ) : content.length === 0 ? (
        <div className="empty-state">
          <p>No content found. Start by adding some articles or subscribing to podcasts!</p>
        </div>
      ) : (
        <div className="content-list">
          {content.map((item) => (
            <div
              key={item.id}
              className={`content-card ${item.is_read ? 'read' : ''} ${selectedItems.has(item.id) ? 'selected' : ''}`}
              onClick={() => bulkMode ? toggleSelection(item.id) : handlePlayContent(item)}
            >
              {bulkMode && (
                <div className="checkbox">
                  {selectedItems.has(item.id) ? <CheckSquare size={20} /> : <Square size={20} />}
                </div>
              )}
              {item.thumbnail_url && (
                <img src={item.thumbnail_url} alt={item.title} className="thumbnail" />
              )}
              <div className="content-info">
                <h3>{item.title}</h3>
                {item.author && <p className="author">{item.author}</p>}
                {item.description && (
                  <p className="description">{cleanHtml(item.description).slice(0, 150)}...</p>
                )}
                <div className="metadata">
                  <span className="type">{item.type}</span>
                  {item.audio_url && <span className="badge">🔊 Audio</span>}
                  {item.transcript && <span className="badge">📝 Transcript</span>}
                  {item.duration && <span className="duration">{formatDuration(item.duration)}</span>}
                  {item.playback_position > 0 && (
                    <span className="progress">
                      {Math.round((item.playback_position / (item.duration || 1)) * 100)}% complete
                    </span>
                  )}
                </div>
                {getGenerationStatusDisplay(item)}
              </div>
              {!bulkMode && (
                <div className="content-actions" onClick={(e) => e.stopPropagation()}>
                  {item.type === 'article' && (
                    <button
                      onClick={() => handleGenerateAudio(item.id, !!item.audio_url)}
                      title={item.audio_url ? 'Regenerate audio' : 'Generate audio'}
                      disabled={item.generation_status === 'generating_audio'}
                    >
                      <Volume2 size={16} />
                      {item.audio_url && <span className="regenerate-indicator">🔄</span>}
                    </button>
                  )}
                <button
                  onClick={() => handleToggleFavorite(item.id, item.is_favorite)}
                  className={item.is_favorite ? 'active' : ''}
                  title="Toggle favorite"
                >
                  <Star size={16} fill={item.is_favorite ? 'currentColor' : 'none'} />
                </button>
                <button
                  onClick={() => handleToggleArchive(item.id, item.is_archived)}
                  title="Toggle archive"
                >
                  <Archive size={16} />
                </button>
                {!item.is_read && (
                  <button onClick={() => handleMarkAsRead(item.id)} title="Mark as read">
                    <FileText size={16} />
                  </button>
                )}
                <button
                  onClick={() => handleDelete(item.id)}
                  className="delete-btn"
                  title="Delete"
                >
                  <Trash2 size={16} />
                </button>
              </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}
