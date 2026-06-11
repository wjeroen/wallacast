import { useState, useEffect, useRef, useMemo } from 'react';
import { Star, Archive, ArchiveRestore, Trash2, MoreVertical, Newspaper, NotebookPen, Podcast, X, Search, Filter } from 'lucide-react';
import { contentAPI, userSettingsAPI } from '../api';
import { useContentStore, itemMatchesFilter } from '../store/contentStore';
import { useQueueStore } from '../store/queueStore';
import { ContentCard } from './ContentCard';
import type { ContentItem } from '../types';

interface LibraryTabProps {
  onPlayContent: (content: ContentItem, opts?: { tab?: 'summary' }) => void;
}

export function LibraryTab({ onPlayContent }: LibraryTabProps) {
  // Use Zustand store for content state
  const {
    items: content,
    allItems,
    typeFilter,
    statusFilter,
    searchQuery,
    loading,
    setTypeFilter,
    setStatusFilter,
    setSearchQuery,
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

  // Search bar (expands above the filter row when the search icon is tapped)
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchInput, setSearchInput] = useState(''); // immediate value, debounced into the store

  // Status filter funnel menu (Active / Favorites / Archived)
  const [statusMenuOpen, setStatusMenuOpen] = useState(false);
  const statusMenuRef = useRef<HTMLDivElement>(null);

  // Bulk actions overflow menu + sequential progress counter
  const [bulkMenuOpen, setBulkMenuOpen] = useState(false);
  const bulkMenuRef = useRef<HTMLDivElement>(null);
  const [bulkProgress, setBulkProgress] = useState<{ label: string; done: number; total: number } | null>(null);

  // Track recently completed items (show "Completed" for 5 seconds)
  const [recentlyCompleted, setRecentlyCompleted] = useState<Map<number, number>>(new Map());
  const [commentWarning, setCommentWarning] = useState<{ id: number; regenerate: boolean; commentCount: number; maxComments: number } | null>(null);
  // "Twitter feed" mode: show the article summary instead of the description on library cards.
  const [showSummaryInLibrary, setShowSummaryInLibrary] = useState(false);

  // Fetch content on mount
  useEffect(() => {
    fetchContent();
  }, []);

  // Load the "show summary on library cards" preference
  useEffect(() => {
    userSettingsAPI.get('library_show_summary')
      .then(res => setShowSummaryInLibrary(res.data.value === 'true'))
      .catch(() => {});
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

  // Close the status funnel menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (statusMenuRef.current && !statusMenuRef.current.contains(event.target as Node)) {
        setStatusMenuOpen(false);
      }
    };
    if (statusMenuOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [statusMenuOpen]);

  // Close the bulk overflow menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (bulkMenuRef.current && !bulkMenuRef.current.contains(event.target as Node)) {
        setBulkMenuOpen(false);
      }
    };
    if (bulkMenuOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [bulkMenuOpen]);

  // Debounce the search input into the store (the store filters on every change).
  // Also drops the selection — a select-all from a previous search shouldn't
  // keep acting on now-hidden items.
  useEffect(() => {
    const t = setTimeout(() => {
      setSearchQuery(searchInput);
      setSelectedItems(new Set());
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput, setSearchQuery]);

  // Filter changes clear the selection for the same reason
  const changeTypeFilter = (t: Parameters<typeof setTypeFilter>[0]) => {
    setTypeFilter(t);
    setSelectedItems(new Set());
  };
  const changeStatusFilter = (s: Parameters<typeof setStatusFilter>[0]) => {
    setStatusFilter(s);
    setStatusMenuOpen(false);
    setSelectedItems(new Set());
  };

  // Count for the "All" chip: items matching the current status across all
  // types, ignoring search (so the number stays stable while typing)
  const statusCount = useMemo(
    () => allItems.filter(i => itemMatchesFilter(i, { typeFilter: 'all', statusFilter, searchQuery: '' })).length,
    [allItems, statusFilter]
  );

  // Poll for progress updates on items that are generating
  useEffect(() => {
    const generatingItems = content.filter(
      item =>
        (item.generation_status && ['starting', 'extracting_content', 'content_ready', 'generating_audio', 'generating_transcript', 'ready'].includes(item.generation_status)) ||
        item.summary_status === 'generating'
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

  const handlePlayContent = async (item: ContentItem, opts?: { tab?: 'summary' }) => {
    try {
      // Fetch latest content data to get current playback position
      const response = await contentAPI.getById(item.id);
      onPlayContent(response.data, opts);
    } catch (error) {
      console.error('Failed to load content details:', error);
      // Fall back to using the list item if fetch fails
      onPlayContent(item, opts);
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

  type BulkAction = 'star' | 'unstar' | 'archive' | 'unarchive' | 'delete' | 'remove_audio' | 'remove_summary';

  // Instant bulk actions: one request to POST /content/bulk, then refetch.
  // Refetching (instead of optimistic updates) keeps us in sync with server
  // side effects like archive wiping audio or delete propagating to Wallabag.
  const runInstantBulk = async (action: BulkAction, confirmMsg?: string) => {
    // Intersect with the visible list — defensive, selection should already
    // only contain visible items
    const ids = content.filter(item => selectedItems.has(item.id)).map(item => item.id);
    if (ids.length === 0) return;
    if (confirmMsg && !confirm(confirmMsg)) return;
    setBulkMenuOpen(false);
    try {
      await contentAPI.bulkAction(action, ids);
      setSelectedItems(new Set());
      await fetchContent();
    } catch (error) {
      console.error(`Bulk ${action} failed:`, error);
      alert('Bulk action failed');
    }
  };

  // Long-running bulk actions: kick off existing per-item endpoints one by
  // one. The start endpoints return immediately; real progress comes from the
  // existing 2-second generation poll once each item's status flips.
  const runSequentialBulk = async (label: string, ids: number[], fn: (id: number) => Promise<unknown>) => {
    setBulkMenuOpen(false);
    setBulkProgress({ label, done: 0, total: ids.length });
    let failed = 0;
    for (let i = 0; i < ids.length; i++) {
      try {
        await fn(ids[i]);
        refreshItem(ids[i]);
      } catch (error) {
        failed++;
        console.error(`${label} failed for item ${ids[i]}:`, error);
      }
      setBulkProgress({ label, done: i + 1, total: ids.length });
    }
    setBulkProgress(null);
    setSelectedItems(new Set());
    if (failed > 0) alert(`${label}: ${failed} of ${ids.length} failed (see console).`);
  };

  const selectedContentItems = () => content.filter(item => selectedItems.has(item.id));

  const handleBulkGenerateAudio = async () => {
    setBulkMenuOpen(false);
    let maxComments = 50;
    try {
      const res = await userSettingsAPI.get('max_narrated_comments');
      if (res.data.value) maxComments = parseInt(res.data.value, 10) || 50;
    } catch { /* use default */ }

    const candidates = selectedContentItems().filter(item =>
      (item.type === 'article' || item.type === 'text') &&
      !item.audio_url &&
      (!item.generation_status || ['idle', 'failed', 'completed'].includes(item.generation_status))
    );
    const eligible = candidates.filter(item => !item.comment_count || item.comment_count <= maxComments);
    const skipped = candidates.length - eligible.length;

    if (eligible.length === 0) {
      alert('No selected items are eligible (needs to be an article/text without audio).');
      return;
    }
    const skipNote = skipped > 0 ? `\n\nSkipping ${skipped} item(s) with more than ${maxComments} comments — generate those individually.` : '';
    if (!confirm(`Generate audio for ${eligible.length} item(s)? This uses your TTS API credits.${skipNote}`)) return;
    await runSequentialBulk('Starting audio generation', eligible.map(i => i.id), id => contentAPI.generateAudio(id, false));
  };

  const handleBulkGenerateSummaries = async () => {
    setBulkMenuOpen(false);
    const eligible = selectedContentItems().filter(item =>
      (item.type === 'article' || item.type === 'text') &&
      !item.summary_generated_at &&
      item.summary_status !== 'generating'
    );
    if (eligible.length === 0) {
      alert('No selected items are eligible (needs to be an article/text without a summary).');
      return;
    }
    if (!confirm(`Generate summaries for ${eligible.length} item(s)? This uses your LLM API credits.`)) return;
    await runSequentialBulk('Starting summaries', eligible.map(i => i.id), async (id) => {
      await contentAPI.generateSummary(id, false);
      // Mark as generating immediately so the badge/poll kick in without waiting for a refetch
      updateItem(id, { summary_status: 'generating' });
    });
  };

  const handleBulkRefetch = async () => {
    setBulkMenuOpen(false);
    const eligible = selectedContentItems().filter(item => item.type === 'article' && item.url);
    if (eligible.length === 0) {
      alert('No selected items are eligible (needs to be an article with a URL).');
      return;
    }
    if (!confirm(`Refetch ${eligible.length} article(s) from the web?`)) return;
    await runSequentialBulk('Refetching', eligible.map(i => i.id), id => contentAPI.refetch(id));
    // Refetch is fire-and-forget on the backend — refresh after delays to pick
    // up updated data (bulk analogue of the 3s/8s per-item refreshes)
    setTimeout(() => fetchContent(), 4000);
    setTimeout(() => fetchContent(), 10000);
  };

  const doGenerateAudio = async (id: number, regenerate: boolean, excludeComments: boolean) => {
    try {
      setOpenDropdown(null);
      await contentAPI.generateAudio(id, regenerate, excludeComments);
      refreshItem(id);
    } catch (error: any) {
      console.error('Failed to generate audio:', error);
      const errorMsg = error?.response?.data?.error || 'Failed to generate audio';
      alert(errorMsg);
    }
  };

  const handleGenerateAudio = async (id: number, regenerate: boolean = false) => {
    setOpenDropdown(null);
    const item = content.find(c => c.id === id);
    if (item && item.comment_count && item.comment_count > 0) {
      let maxComments = 50;
      try {
        const res = await userSettingsAPI.get('max_narrated_comments');
        if (res.data.value) maxComments = parseInt(res.data.value, 10) || 50;
      } catch { /* use default */ }
      if (item.comment_count > maxComments) {
        setCommentWarning({ id, regenerate, commentCount: item.comment_count, maxComments });
        return;
      }
    }
    doGenerateAudio(id, regenerate, false);
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

  const handleGenerateSummary = async (id: number, regenerate: boolean = false) => {
    try {
      setOpenDropdown(null);
      await contentAPI.generateSummary(id, regenerate);
      // Mark as generating immediately so the badge/poll kick in without waiting for a refetch
      updateItem(id, { summary_status: 'generating' } as any);
      refreshItem(id);
    } catch (error: any) {
      console.error('Failed to generate summary:', error);
      alert(error?.response?.data?.error || 'Failed to generate summary');
    }
  };

  const handleRemoveSummary = async (id: number) => {
    try {
      setOpenDropdown(null);
      await contentAPI.update(id, { summary: null } as any);
      refreshItem(id);
    } catch (error) {
      console.error('Failed to remove summary:', error);
      alert('Failed to remove summary');
    }
  };

  const handleRefetchContent = async (id: number) => {
    try {
      setOpenDropdown(null);
      await contentAPI.refetch(id);
      // Refetch is async on the backend — refresh after delay to pick up updated data.
      // Two refreshes: first at 3s for fast sites, second at 8s for slower ones (e.g. Substack /comments fetch)
      setTimeout(() => refreshItem(id), 3000);
      setTimeout(() => refreshItem(id), 8000);
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

  const handleDownloadDataZip = async (item: ContentItem) => {
    setOpenDropdown(null);
    try {
      const response = await contentAPI.exportZip(item.id);
      const blob = new Blob([response.data], { type: 'application/zip' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${(item.title || 'content').replace(/[^a-zA-Z0-9-_ ]/g, '')}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Failed to export data:', error);
      alert('Failed to download data');
    }
  };

  return (
    <div className="library-tab">
      <div className="library-header">
        {searchOpen && (
          <div className="library-search">
            <Search size={16} className="library-search-icon" />
            <input
              type="search"
              className="library-search-input"
              placeholder="Search library…"
              value={searchInput}
              onChange={e => setSearchInput(e.target.value)}
              autoFocus
              autoCapitalize="off"
              autoCorrect="off"
              enterKeyHint="search"
            />
            <button
              className="library-search-clear"
              onClick={() => { setSearchInput(''); setSearchQuery(''); setSearchOpen(false); }}
              title="Close search"
            >
              <X size={16} />
            </button>
          </div>
        )}
        <div className="header-top">
          <button
            onClick={() => { setBulkMode(!bulkMode); setSelectedItems(new Set()); }}
            className="select-mode-btn"
          >
            {bulkMode ? 'Cancel' : 'Select'}
          </button>
          <div className="filter-buttons">
            <button
              className={searchOpen || searchQuery.trim() ? 'active' : ''}
              onClick={() => {
                if (searchOpen) {
                  setSearchInput('');
                  setSearchQuery('');
                  setSearchOpen(false);
                } else {
                  setSearchOpen(true);
                }
              }}
              title="Search library"
            >
              <Search size={16} />
            </button>
            <button
              className={typeFilter === 'all' ? 'active' : ''}
              onClick={() => changeTypeFilter('all')}
            >
              All ({statusCount})
            </button>
            <button
              className={typeFilter === 'articles' ? 'active' : ''}
              onClick={() => changeTypeFilter('articles')}
            >
              <Newspaper size={16} />
              <span className="filter-label">Articles</span>
            </button>
            <button
              className={typeFilter === 'texts' ? 'active' : ''}
              onClick={() => changeTypeFilter('texts')}
            >
              <NotebookPen size={16} />
              <span className="filter-label">Texts</span>
            </button>
            <button
              className={typeFilter === 'podcasts' ? 'active' : ''}
              onClick={() => changeTypeFilter('podcasts')}
            >
              <Podcast size={16} />
              <span className="filter-label">Podcasts</span>
            </button>
            <div className="dropdown-container" ref={statusMenuRef}>
              <button
                className={`status-funnel-btn ${statusFilter !== 'active' ? 'active' : ''}`}
                onClick={() => setStatusMenuOpen(!statusMenuOpen)}
                title="Filter by status"
              >
                <Filter size={16} />
                {statusFilter !== 'active' && (
                  <span>{statusFilter === 'favorites' ? 'Favorites' : 'Archived'}</span>
                )}
              </button>
              {statusMenuOpen && (
                <div className="dropdown-menu">
                  <button onClick={() => changeStatusFilter('active')}>
                    {statusFilter === 'active' ? '✓ ' : ''}Active
                  </button>
                  <button onClick={() => changeStatusFilter('favorites')}>
                    {statusFilter === 'favorites' ? '✓ ' : ''}Favorites
                  </button>
                  <button onClick={() => changeStatusFilter('archived')}>
                    {statusFilter === 'archived' ? '✓ ' : ''}Archived
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
        {bulkMode && selectedItems.size > 0 && (
          <div className="bulk-actions">
            <span className="bulk-count">{selectedItems.size} selected</span>
            <button onClick={selectAll}>All</button>
            <button onClick={deselectAll}>None</button>
            <button onClick={() => runInstantBulk('star')} title="Star selected"><Star size={16} /></button>
            {statusFilter === 'archived' ? (
              <button onClick={() => runInstantBulk('unarchive')} title="Unarchive selected"><ArchiveRestore size={16} /></button>
            ) : (
              <button onClick={() => runInstantBulk('archive')} title="Archive selected"><Archive size={16} /></button>
            )}
            <button
              onClick={() => runInstantBulk('delete', `Delete ${selectedItems.size} item(s)? Wallabag-synced items will be deleted there too. This cannot be undone.`)}
              title="Delete selected"
            >
              <Trash2 size={16} />
            </button>
            <div className="dropdown-container" ref={bulkMenuRef}>
              <button onClick={() => setBulkMenuOpen(!bulkMenuOpen)} title="More bulk actions">
                <MoreVertical size={16} />
              </button>
              {bulkMenuOpen && (
                <div className="dropdown-menu">
                  <button onClick={() => runInstantBulk('unstar')}>Unstar selected</button>
                  <button onClick={() => runInstantBulk('unarchive')}>Unarchive selected</button>
                  <button onClick={() => runInstantBulk('remove_audio', `Remove generated audio from ${selectedItems.size} item(s)? (Podcast episodes are never affected.)`)}>
                    Remove audio
                  </button>
                  <button onClick={() => runInstantBulk('remove_summary', `Remove summaries from ${selectedItems.size} item(s)?`)}>
                    Remove summaries
                  </button>
                  <button onClick={handleBulkGenerateAudio}>Generate audio…</button>
                  <button onClick={handleBulkGenerateSummaries}>Generate summaries…</button>
                  <button onClick={handleBulkRefetch}>Refetch from web…</button>
                </div>
              )}
            </div>
          </div>
        )}
        {bulkProgress && (
          <div className="bulk-progress">{bulkProgress.label} {bulkProgress.done}/{bulkProgress.total}…</div>
        )}
      </div>

      {loading ? (
        <div className="loading">Loading...</div>
      ) : content.length === 0 ? (
        <div className="empty-state">
          {searchQuery.trim() ? (
            <p>No results for “{searchQuery.trim()}”.</p>
          ) : (
            <p>No content found. Start by adding some articles or subscribing to podcasts!</p>
          )}
        </div>
      ) : (
        <div className={`content-list${showSummaryInLibrary ? ' tweet-mode' : ''}`}>
          {content.map((item) => (
            <ContentCard
              key={item.id}
              item={item}
              bulkMode={bulkMode}
              selected={selectedItems.has(item.id)}
              onToggleSelect={toggleSelection}
              onPlay={handlePlayContent}
              searchQuery={searchQuery}
              showSummary={showSummaryInLibrary}
              justCompleted={recentlyCompleted.has(item.id)}
              dropdownOpen={openDropdown === item.id}
              dropdownRef={openDropdown === item.id ? dropdownRef : null}
              onToggleDropdown={() => setOpenDropdown(openDropdown === item.id ? null : item.id)}
              onCancelGeneration={handleCancelGeneration}
              onToggleStarred={handleToggleStarred}
              onToggleArchive={handleToggleArchive}
              onDelete={handleDelete}
              onGenerateAudio={handleGenerateAudio}
              onRemoveAudio={handleRemoveAudio}
              onGenerateSummary={handleGenerateSummary}
              onRemoveSummary={handleRemoveSummary}
              onRegenerateTranscript={handleRegenerateTranscript}
              onRefetch={handleRefetchContent}
              onAddToQueue={(it) => { setOpenDropdown(null); useQueueStore.getState().addToQueue(it); }}
              onDownloadZip={handleDownloadDataZip}
            />
          ))}
        </div>
      )}

      {commentWarning && (
        <div className="comment-warning-overlay" onClick={() => setCommentWarning(null)}>
          <div className="comment-warning-modal" onClick={e => e.stopPropagation()}>
            <p>This article has <strong>{commentWarning.commentCount} comments</strong> (your auto-generate limit is {commentWarning.maxComments}). Generating audio with this many comments may take a long time.</p>
            <div className="comment-warning-buttons">
              <button
                className="comment-warning-btn exclude"
                onClick={() => {
                  const { id, regenerate } = commentWarning;
                  setCommentWarning(null);
                  doGenerateAudio(id, regenerate, true);
                }}
              >
                Exclude comments
              </button>
              <button
                className="comment-warning-btn include"
                onClick={() => {
                  const { id, regenerate } = commentWarning;
                  setCommentWarning(null);
                  doGenerateAudio(id, regenerate, false);
                }}
              >
                Include comments
              </button>
              <button
                className="comment-warning-btn cancel"
                onClick={() => setCommentWarning(null)}
              >
                Don't generate audio
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
