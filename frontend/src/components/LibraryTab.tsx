import { useState, useEffect, useRef } from 'react';
import { Star, Archive, Trash2, CheckSquare, Square, MoreVertical } from 'lucide-react';
import { contentAPI } from '../api';
import type { ContentItem } from '../types';

type FilterType = 'all' | 'articles' | 'texts' | 'podcasts' | 'favorites' | 'archived';

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

interface LibraryTabProps {
  onPlayContent: (content: ContentItem) => void;
  content: ContentItem[];
  setContent: React.Dispatch<React.SetStateAction<ContentItem[]>>;
  loading: boolean;
  onRefresh: (params?: any) => Promise<void>;
}

export function LibraryTab({ onPlayContent, content, setContent, loading, onRefresh }: LibraryTabProps) {
  const [filter, setFilter] = useState<FilterType>('all');
  const [selectedItems, setSelectedItems] = useState<Set<number>>(new Set());
  const [bulkMode, setBulkMode] = useState(false);
  const [openDropdown, setOpenDropdown] = useState<number | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const params: any = {};

    if (filter === 'articles') {
      params.type = 'article';
    } else if (filter === 'texts') {
      params.type = 'text';
    } else if (filter === 'podcasts') {
      params.type = 'podcast_episode';
    } else if (filter === 'favorites') {
      params.starred = true;
    } else if (filter === 'archived') {
      params.archived = true;
    } else if (filter === 'all') {
      params.archived = false; // Explicitly exclude archived items
    }

    onRefresh(params);
  }, [filter]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setOpenDropdown(null);
      }
    };

    if (openDropdown !== null) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [openDropdown]);

  // Poll for progress updates on items that are generating
  useEffect(() => {
    const generatingItems = content.filter(
      item => item.generation_status && ['starting', 'extracting_content', 'content_ready', 'generating_audio', 'generating_transcript'].includes(item.generation_status)
    );

    if (generatingItems.length === 0) return;

    // Poll every 2 seconds for active generation, complete when done
    const pollInterval = setInterval(async () => {
      // Fetch only the generating items, not the entire list
      for (const item of generatingItems) {
        try {
          const response = await contentAPI.getById(item.id);
          const updated = response.data;

          // Update just this item in the state
          setContent(prevContent =>
            prevContent.map(c => c.id === item.id ? updated : c)
          );

          // If item completed, reload the full list once to ensure fresh data
          if (updated.generation_status === 'completed' && item.generation_status !== 'completed') {
            setTimeout(() => onRefresh(), 500);
          }
        } catch (error) {
          console.error('Failed to fetch item status:', error);
        }
      }
    }, 2000); // Poll every 2 seconds for responsive updates

    return () => clearInterval(pollInterval);
  }, [content]);

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

  const handleToggleStarred = async (id: number, isFavorite: boolean) => {
    try {
      await contentAPI.update(id, { is_starred: !isFavorite });
      onRefresh();
    } catch (error) {
      console.error('Failed to toggle favorite:', error);
    }
  };

  const handleToggleArchive = async (id: number, isArchived: boolean) => {
    try {
      await contentAPI.update(id, { is_archived: !isArchived });
      onRefresh();
    } catch (error) {
      console.error('Failed to toggle archive:', error);
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await contentAPI.delete(id);
      onRefresh();
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
      onRefresh();
    } catch (error) {
      console.error('Failed to bulk delete:', error);
    }
  };

  const handleBulkArchive = async () => {
    try {
      await Promise.all(Array.from(selectedItems).map(id => contentAPI.update(id, { is_archived: true })));
      setSelectedItems(new Set());
      onRefresh();
    } catch (error) {
      console.error('Failed to bulk archive:', error);
    }
  };

  const handleBulkStar = async () => {
    try {
      await Promise.all(Array.from(selectedItems).map(id => contentAPI.update(id, { is_starred: true })));
      setSelectedItems(new Set());
      onRefresh();
    } catch (error) {
      console.error('Failed to bulk favorite:', error);
    }
  };

  const handleGenerateAudio = async (id: number, regenerate: boolean = false) => {
    try {
      setOpenDropdown(null);
      await contentAPI.generateAudio(id, regenerate);
      // Generation started in background, polling will update status
      onRefresh();
    } catch (error: any) {
      console.error('Failed to generate audio:', error);
      const errorMsg = error?.response?.data?.error || 'Failed to generate audio';
      alert(errorMsg);
    }
  };

  const handleRemoveAudio = async (id: number) => {
    try {
      setOpenDropdown(null);
      await contentAPI.update(id, { audio_data: null, audio_url: null } as any);
      onRefresh();
    } catch (error) {
      console.error('Failed to remove audio:', error);
      alert('Failed to remove audio');
    }
  };

  const handleRegenerateContent = async (id: number) => {
    try {
      setOpenDropdown(null);
      // This will re-extract and re-process the article through the LLM
      await contentAPI.update(id, { regenerate_content: true } as any);
      onRefresh();
    } catch (error) {
      console.error('Failed to regenerate content:', error);
      alert('Failed to regenerate content');
    }
  };

  const handleRegenerateTranscript = async (id: number) => {
    try {
      setOpenDropdown(null);
      // Re-generate transcript for podcast
      await contentAPI.update(id, { regenerate_transcript: true } as any);
      onRefresh();
    } catch (error) {
      console.error('Failed to regenerate transcript:', error);
      alert('Failed to regenerate transcript');
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

    // Generate detailed status message
    let statusMessage = '';
    let progressPercent = item.generation_progress || 0;

    if (item.generation_status === 'starting') {
      statusMessage = '⏳ Starting...';
    } else if (item.generation_status === 'extracting_content') {
      statusMessage = '📄 Extracting content...';
    } else if (item.generation_status === 'content_ready') {
      // Parse chunk progress from current_operation
      if (item.current_operation?.startsWith('audio_chunk_')) {
        const match = item.current_operation.match(/audio_chunk_(\d+)_of_(\d+)/);
        if (match) {
          const [_, current, total] = match;
          statusMessage = `🔊 Generating audio: chunk ${current}/${total} (${progressPercent}%)`;
        } else {
          statusMessage = `🔊 Generating audio... ${progressPercent}%`;
        }
      } else if (item.current_operation === 'concatenating_audio') {
        statusMessage = `🔗 Combining audio files... ${progressPercent}%`;
      } else {
        statusMessage = `🔊 Generating audio... ${progressPercent}%`;
      }
    } else if (item.generation_status === 'generating_transcript') {
      statusMessage = `📝 Generating transcript... ${progressPercent}%`;
    } else {
      statusMessage = `🔄 Processing... ${progressPercent}%`;
    }

    return (
      <div className="generation-status generating">
        <span>{statusMessage}</span>
        {progressPercent > 0 && (
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: `${progressPercent}%` }}></div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="library-tab">
      <div className="library-header">
        <div className="header-top">
          <button
            onClick={() => { setBulkMode(!bulkMode); setSelectedItems(new Set()); }}
            className="select-mode-btn"
          >
            {bulkMode ? 'Cancel' : 'Select'}
          </button>
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
              className={filter === 'texts' ? 'active' : ''}
              onClick={() => setFilter('texts')}
            >
              Texts
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
        {bulkMode && selectedItems.size > 0 && (
          <div className="bulk-actions">
            <span className="bulk-count">{selectedItems.size} selected</span>
            <button onClick={selectAll}>All</button>
            <button onClick={deselectAll}>None</button>
            <button onClick={handleBulkStar} title="Favorite selected"><Star size={16} /></button>
            <button onClick={handleBulkArchive} title="Archive selected"><Archive size={16} /></button>
            <button onClick={handleBulkDelete} title="Delete selected"><Trash2 size={16} /></button>
          </div>
        )}
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
              className={`content-card ${selectedItems.has(item.id) ? 'selected' : ''}`}
              onClick={() => bulkMode ? toggleSelection(item.id) : handlePlayContent(item)}
            >
              {bulkMode && (
                <div className="checkbox">
                  {selectedItems.has(item.id) ? <CheckSquare size={20} /> : <Square size={20} />}
                </div>
              )}
              {item.preview_picture && (
                <img src={item.preview_picture} alt={item.title} className="thumbnail" />
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
                  {item.playback_position > 0 && item.duration && item.duration > 0 && (
                    <span className="progress">
                      {Math.round((item.playback_position / item.duration) * 100)}% complete
                    </span>
                  )}
                </div>
                {getGenerationStatusDisplay(item)}
              </div>
              {!bulkMode && (
                <div className="content-actions" onClick={(e) => e.stopPropagation()}>
                  <button
                    onClick={() => handleToggleStarred(item.id, item.is_starred)}
                    className={item.is_starred ? 'active' : ''}
                    title="Toggle favorite"
                  >
                    <Star size={16} fill={item.is_starred ? 'currentColor' : 'none'} />
                  </button>
                  <button
                    onClick={() => handleToggleArchive(item.id, item.is_archived)}
                    title="Toggle archive"
                  >
                    <Archive size={16} />
                  </button>
                  <button
                    onClick={() => handleDelete(item.id)}
                    className="delete-btn"
                    title="Delete"
                  >
                    <Trash2 size={16} />
                  </button>
                  <div className="dropdown-container" ref={openDropdown === item.id ? dropdownRef : null}>
                    <button
                      onClick={() => setOpenDropdown(openDropdown === item.id ? null : item.id)}
                      title="More options"
                      className="more-options-btn"
                    >
                      <MoreVertical size={16} />
                    </button>
                    {openDropdown === item.id && (
                      <div className="dropdown-menu">
                        {(item.type === 'article' || item.type === 'text') && (
                          <>
                            {!item.audio_url && (
                              <button
                                onClick={() => handleGenerateAudio(item.id, false)}
                                disabled={item.generation_status === 'generating_audio'}
                              >
                                Generate audio
                              </button>
                            )}
                            {item.audio_url && (
                              <>
                                <button
                                  onClick={() => handleGenerateAudio(item.id, true)}
                                  disabled={item.generation_status === 'generating_audio'}
                                >
                                  Regenerate audio
                                </button>
                                <button onClick={() => handleRemoveAudio(item.id)}>
                                  Remove audio
                                </button>
                              </>
                            )}
                          </>
                        )}
                        {item.type === 'article' && (
                          <button onClick={() => handleRegenerateContent(item.id)}>
                            Regenerate content
                          </button>
                        )}
                        {item.type === 'podcast_episode' && (
                          <>
                            {(!item.transcript || item.transcript.trim() === '') ? (
                              <button
                                onClick={() => handleRegenerateTranscript(item.id)}
                                disabled={item.generation_status === 'generating_transcript'}
                              >
                                Generate transcript
                              </button>
                            ) : (
                              <button
                                onClick={() => handleRegenerateTranscript(item.id)}
                                disabled={item.generation_status === 'generating_transcript'}
                              >
                                Regenerate transcript
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    )}
                  </div>
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
