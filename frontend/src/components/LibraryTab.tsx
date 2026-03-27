import { useState, useEffect, useRef } from 'react';
import { Star, Archive, ArchiveRestore, Trash2, CheckSquare, Square, MoreVertical, SquareArrowOutUpRight, Newspaper, NotebookPen, Podcast, FileText, X, ArrowUp, MessageCircle } from 'lucide-react';
import { contentAPI } from '../api';
import { useContentStore } from '../store/contentStore';
import type { ContentItem } from '../types';

function getDomainFromUrl(url: string): string {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

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
}

export function LibraryTab({ onPlayContent }: LibraryTabProps) {
  // Use Zustand store for content state
  const {
    items: content,
    filter,
    loading,
    allCount,
    setFilter,
    fetchContent,
    toggleStarred,
    toggleArchived,
    deleteItem,
    updateItem,
    refreshItem,
  } = useContentStore();

  const [selectedItems, setSelectedItems] = useState<Set<number>>(new Set());
  const [bulkMode, setBulkMode] = useState(false);
  const [openDropdown, setOpenDropdown] = useState<number | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Track recently completed items (show "Completed" for 5 seconds)
  const [recentlyCompleted, setRecentlyCompleted] = useState<Map<number, number>>(new Map());

  // Fetch content on mount
  useEffect(() => {
    fetchContent();
  }, []);

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
      item => item.generation_status && ['starting', 'extracting_content', 'content_ready', 'generating_audio', 'generating_transcript', 'ready'].includes(item.generation_status)
    );

    if (generatingItems.length === 0) return;

    // Poll every 2 seconds for active generation
    const pollInterval = setInterval(async () => {
      for (const item of generatingItems) {
        try {
          const response = await contentAPI.getById(item.id);
          const updated = response.data;

          // Update just this item in the store
          updateItem(item.id, updated);

          // If item completed, refresh to get full data and track completion time
          if (updated.generation_status === 'completed' && item.generation_status !== 'completed') {
            setRecentlyCompleted(prev => new Map(prev).set(item.id, Date.now()));
            setTimeout(() => refreshItem(item.id), 500);
            // Clear from recently completed after 5 seconds
            setTimeout(() => {
              setRecentlyCompleted(prev => {
                const newMap = new Map(prev);
                newMap.delete(item.id);
                return newMap;
              });
            }, 5000);
          }
        } catch (error) {
          console.error('Failed to fetch item status:', error);
        }
      }
    }, 2000);

    return () => clearInterval(pollInterval);
  }, [content, updateItem, refreshItem]);

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

  const handleToggleStarred = async (id: number) => {
    await toggleStarred(id);
  };

  const handleToggleArchive = async (id: number) => {
    await toggleArchived(id);
  };

  const handleDelete = async (id: number) => {
    await deleteItem(id);
  };

  const handleCancelGeneration = async (id: number) => {
    try {
      await contentAPI.cancelGeneration(id);
      // Refresh the item to show cancelled status
      await refreshItem(id);
    } catch (error) {
      console.error('Failed to cancel generation:', error);
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
      await Promise.all(Array.from(selectedItems).map(id => deleteItem(id)));
      setSelectedItems(new Set());
    } catch (error) {
      console.error('Failed to bulk delete:', error);
    }
  };

  const handleBulkArchive = async () => {
    try {
      await Promise.all(Array.from(selectedItems).map(id => toggleArchived(id)));
      setSelectedItems(new Set());
    } catch (error) {
      console.error('Failed to bulk archive:', error);
    }
  };

  const handleBulkStar = async () => {
    try {
      await Promise.all(Array.from(selectedItems).map(id => contentAPI.update(id, { is_starred: true })));
      setSelectedItems(new Set());
      fetchContent(); // Refresh after bulk operation
    } catch (error) {
      console.error('Failed to bulk star:', error);
    }
  };

  const handleGenerateAudio = async (id: number, regenerate: boolean = false) => {
    try {
      setOpenDropdown(null);
      await contentAPI.generateAudio(id, regenerate);
      // Generation started in background, polling will update status
      refreshItem(id);
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
      refreshItem(id);
    } catch (error) {
      console.error('Failed to remove audio:', error);
      alert('Failed to remove audio');
    }
  };

  const handleRefetchContent = async (id: number) => {
    try {
      setOpenDropdown(null);
      await contentAPI.refetch(id);
      // Wait a bit for backend to process, then refresh
      setTimeout(() => refreshItem(id), 1000);
    } catch (error) {
      console.error('Failed to refetch content:', error);
      alert('Failed to refetch content');
    }
  };

  const handleRegenerateTranscript = async (id: number) => {
    try {
      setOpenDropdown(null);
      await contentAPI.update(id, { regenerate_transcript: true } as any);
      refreshItem(id);
    } catch (error) {
      console.error('Failed to regenerate transcript:', error);
      alert('Failed to regenerate transcript');
    }
  };

  const downloadFile = (filename: string, data: string, mime = 'text/html') => {
    const blob = new Blob([data], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleDownloadCleanedHtml = async (item: ContentItem) => {
    try {
      setOpenDropdown(null);
      const response = await contentAPI.getById(item.id);
      const html = response.data.html_content || response.data.content || '';
      if (!html) { alert('No content available to download'); return; }
      const safeName = (item.title || 'content').replace(/[^a-zA-Z0-9-_ ]/g, '');
      downloadFile(`${safeName}.html`, html);
    } catch (error) {
      console.error('Failed to download HTML:', error);
      alert('Failed to download content');
    }
  };

  const handleDownloadReadAlongHtml = async (item: ContentItem) => {
    try {
      setOpenDropdown(null);
      const response = await contentAPI.getById(item.id);
      const fullItem = response.data;
      const alignment = fullItem.content_alignment;
      if (!alignment) { alert('No read-along alignment available for this item'); return; }
      const parsed = typeof alignment === 'string' ? JSON.parse(alignment) : alignment;
      if (!parsed.format || parsed.format !== 'llm') { alert('No LLM read-along alignment available'); return; }
      const elements = parsed.elements || [];
      const bodyHtml = elements
        .filter((e: any) => ['heading', 'paragraph', 'image', 'blockquote', 'list', 'code-block', 'title', 'meta'].includes(e.type))
        .map((e: any) => e.html)
        .join('\n');
      const commentHtml = elements
        .filter((e: any) => e.type === 'comment')
        .map((e: any) => {
          const meta = e.commentMeta;
          const header = meta ? `<p><strong>${meta.username}</strong>${meta.karma !== undefined ? ` (${meta.karma} upvotes)` : ''}</p>` : '';
          return `<div style="margin-left:${(meta?.depth || 0) * 20}px; border-left: 2px solid #555; padding-left: 8px; margin-bottom: 12px;">${header}${e.html}</div>`;
        })
        .join('\n');
      const safeName = (item.title || 'content').replace(/[^a-zA-Z0-9-_ ]/g, '');
      const fullHtml = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${fullItem.title || 'Read-Along'}</title>
<style>body{font-family:system-ui,sans-serif;max-width:700px;margin:40px auto;padding:0 20px;line-height:1.6;color:#e2e8f0;background:#0f172a}img{max-width:100%;height:auto;border-radius:0.5rem}blockquote{border-left:3px solid #60a5fa;padding-left:1rem;margin-left:0;color:#94a3b8}h1,h2,h3{color:#f1f5f9}a{color:#60a5fa}</style>
</head><body>
<h1>${fullItem.title || ''}</h1>
${bodyHtml}
${commentHtml ? '<hr><h2>Comments</h2>' + commentHtml : ''}
</body></html>`;
      downloadFile(`${safeName} (read-along).html`, fullHtml);
    } catch (error) {
      console.error('Failed to download read-along HTML:', error);
      alert('Failed to download read-along content');
    }
  };

  const handleDownloadOriginalHtml = async (item: ContentItem) => {
    try {
      setOpenDropdown(null);
      if (!item.url) { alert('No source URL available — cannot fetch original HTML'); return; }
      const response = await contentAPI.getOriginalHtml(item.id);
      const html = typeof response.data === 'string' ? response.data : String(response.data);
      if (!html) { alert('No content returned from source'); return; }
      const safeName = (item.title || 'content').replace(/[^a-zA-Z0-9-_ ]/g, '');
      downloadFile(`${safeName} (original).html`, html);
    } catch (error) {
      console.error('Failed to download original HTML:', error);
      alert('Failed to fetch original HTML');
    }
  };

  const getGenerationStatusDisplay = (item: ContentItem) => {
    if (!item.generation_status || item.generation_status === 'idle') {
      return null;
    }

    if (item.generation_status === 'completed') {
      // Show "Completed ✓" for 5 seconds after completion
      if (recentlyCompleted.has(item.id)) {
        return (
          <div className="generation-status completed" style={{ color: '#10b981' }}>
            <span>✓ Completed</span>
          </div>
        );
      }
      return null;
    }

    if (item.generation_status === 'failed') {
      return (
        <div className="generation-status error">
          <span>Generation failed</span>
          {item.generation_error && <span className="error-detail">: {item.generation_error}</span>}
        </div>
      );
    }

    let statusMessage = '';
    const progressPercent = item.generation_progress || 0;

    // Check current_operation first (more specific than generation_status)
    if (item.current_operation) {
      switch (item.current_operation) {
        case 'processing_images':
          statusMessage = `Processing image descriptions... ${progressPercent}%`;
          break;
        case 'scripting_content':
          statusMessage = `Preparing narration script... ${progressPercent}%`;
          break;
        case 'synthesizing_audio':
          statusMessage = `Generating audio... ${progressPercent}%`;
          break;
        case 'concatenating_audio':
          statusMessage = `Combining audio files... ${progressPercent}%`;
          break;
        case 'finalizing_audio':
          statusMessage = `Finalizing audio... ${progressPercent}%`;
          break;
        case 'transcribing':
          statusMessage = `Creating transcript... ${progressPercent}%`;
          break;
        case 'aligning_content':
          statusMessage = `Aligning content... ${progressPercent}%`;
          break;
        default:
          // Check for audio chunk pattern (e.g., "audio_chunk_3_of_10")
          if (item.current_operation.startsWith('audio_chunk_')) {
            const match = item.current_operation.match(/audio_chunk_(\d+)_of_(\d+)/);
            if (match) {
              const [, current, total] = match;
              statusMessage = `Generating audio: chunk ${current}/${total} (${progressPercent}%)`;
            } else {
              statusMessage = `Generating audio... ${progressPercent}%`;
            }
          }
          // Check for image processing pattern (e.g., "processing_image_3_of_10")
          else if (item.current_operation.startsWith('processing_image_')) {
            const match = item.current_operation.match(/processing_image_(\d+)_of_(\d+)/);
            if (match) {
              const [, current, total] = match;
              statusMessage = `Processing image ${current}/${total}... ${progressPercent}%`;
            } else {
              statusMessage = `Processing images... ${progressPercent}%`;
            }
          }
          else if (item.generation_status === 'starting') {
            statusMessage = 'Starting...';
          } else if (item.generation_status === 'extracting_content') {
            statusMessage = 'Extracting content...';
          } else if (item.generation_status === 'generating_transcript') {
            statusMessage = `Generating transcript... ${progressPercent}%`;
          } else {
            statusMessage = `Processing... ${progressPercent}%`;
          }
      }
    } else if (item.generation_status === 'starting') {
      statusMessage = 'Starting...';
    } else if (item.generation_status === 'extracting_content') {
      statusMessage = 'Extracting content...';
    } else if (item.generation_status === 'generating_transcript') {
      statusMessage = `Generating transcript... ${progressPercent}%`;
    } else {
      statusMessage = `Processing... ${progressPercent}%`;
    }

    return (
      <div className="generation-status generating">
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
          <span style={{ flex: 1 }}>{statusMessage}</span>
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleCancelGeneration(item.id);
            }}
            className="cancel-generation-btn"
            title="Stop generation"
            style={{
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              padding: '0.25rem',
              display: 'flex',
              alignItems: 'center',
              color: '#ef4444',
            }}
          >
            <X size={16} />
          </button>
        </div>
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
              All ({allCount})
            </button>
            <button
              className={filter === 'articles' ? 'active' : ''}
              onClick={() => setFilter('articles')}
            >
              <Newspaper size={16} />
              <span className="filter-label">Articles</span>
            </button>
            <button
              className={filter === 'texts' ? 'active' : ''}
              onClick={() => setFilter('texts')}
            >
              <NotebookPen size={16} />
              <span className="filter-label">Texts</span>
            </button>
            <button
              className={filter === 'podcasts' ? 'active' : ''}
              onClick={() => setFilter('podcasts')}
            >
              <Podcast size={16} />
              <span className="filter-label">Podcasts</span>
            </button>
            <button
              className={filter === 'favorites' ? 'active' : ''}
              onClick={() => setFilter('favorites')}
            >
              <Star size={16} />
              <span className="filter-label">Favorites</span>
            </button>
            <button
              className={filter === 'archived' ? 'active' : ''}
              onClick={() => setFilter('archived')}
            >
              <Archive size={16} />
              <span className="filter-label">Archived</span>
            </button>
          </div>
        </div>
        {bulkMode && selectedItems.size > 0 && (
          <div className="bulk-actions">
            <span className="bulk-count">{selectedItems.size} selected</span>
            <button onClick={selectAll}>All</button>
            <button onClick={deselectAll}>None</button>
            <button onClick={handleBulkStar} title="Star selected"><Star size={16} /></button>
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
                {item.author && (
                  <p className="author">
                    {item.author}
                    {item.published_at && (
                      <> &bull; {new Date(item.published_at).toLocaleDateString('en-GB')}</>
                    )}
                    {item.karma !== undefined && item.karma !== null && (
                      <> &bull; <ArrowUp size={12} style={{ verticalAlign: '-1px' }} /> {item.karma}</>
                    )}
                    {item.comment_count !== undefined && item.comment_count > 0 && (
                      <> &bull; <MessageCircle size={12} style={{ verticalAlign: '-1px' }} /> {item.comment_count}</>
                    )}
                  </p>
                )}
                {item.type === 'podcast_episode' && item.podcast_show_name && (
                  <p className="author">
                    {item.podcast_show_name}
                    {item.published_at && (
                      <> • {new Date(item.published_at).toLocaleDateString('en-GB')}</>
                    )}
                  </p>
                )}
                {/* Only show domain URL for articles (not podcasts/texts) */}
                {item.url && item.type === 'article' && (
                  <p className="content-source-link">
                    <a href={item.url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
                      {getDomainFromUrl(item.url)}
                      <SquareArrowOutUpRight size={12} style={{ marginLeft: '0.25rem' }} />
                    </a>
                  </p>
                )}
                {item.description && (
                  <p className="description">{cleanHtml(item.description).slice(0, 150)}...</p>
                )}
                <div className="metadata">
                  <span className="type" title={item.type}>
                    {item.type === 'article' && <Newspaper size={16} className="icon-article" />}
                    {item.type === 'text' && <NotebookPen size={16} className="icon-text" />}
                    {item.type === 'podcast_episode' && <Podcast size={16} className="icon-podcast" />}
                    {item.type === 'pdf' && <FileText size={16} />}
                  </span>
                  {item.audio_url && <span className="badge">Audio</span>}
                  {item.type === 'podcast_episode' && item.transcript_words && (
                    <span className="badge transcript">Transcript</span>
                  )}
                  {item.playback_position > 0 && item.duration && item.duration > 0 && (
                    <span className="progress">
                      {Math.round((item.playback_position / item.duration) * 100)}% complete
                    </span>
                  )}
                  {item.duration && <span className="duration">{formatDuration(item.duration)}</span>}
                </div>
                {getGenerationStatusDisplay(item)}
              </div>
              {!bulkMode && (
                <div className="content-actions" onClick={(e) => e.stopPropagation()}>
                  <button
                    onClick={() => handleToggleStarred(item.id)}
                    className={item.is_starred ? 'active' : ''}
                    title="Toggle star"
                  >
                    <Star size={16} fill={item.is_starred ? 'currentColor' : 'none'} />
                  </button>
                  <button
                    onClick={() => handleToggleArchive(item.id)}
                    title={item.is_archived ? "Restore from archive" : "Archive"}
                    className={item.is_archived ? 'active' : ''}
                  >
                    {item.is_archived ? <ArchiveRestore size={16} /> : <Archive size={16} />}
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
                        {(item.type === 'article' || item.type === 'text') && item.audio_url && (
                          <button
                            onClick={() => handleRegenerateTranscript(item.id)}
                            disabled={item.generation_status === 'generating_transcript'}
                          >
                            Regenerate transcript
                          </button>
                        )}
                        {item.type === 'article' && item.url && (
                          <button onClick={() => handleRefetchContent(item.id)}>
                            Refetch from web
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
                        {(item.type === 'article' || item.type === 'text') && (
                          <>
                            <button onClick={() => handleDownloadCleanedHtml(item)}>
                              Download cleaned HTML
                            </button>
                            <button onClick={() => handleDownloadReadAlongHtml(item)}>
                              Download read-along HTML
                            </button>
                            {item.url && (
                              <button onClick={() => handleDownloadOriginalHtml(item)}>
                                Download original (refetch)
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
