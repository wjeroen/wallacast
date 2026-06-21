import { useState } from 'react';
import { Star, Archive, ArchiveRestore, Trash2, CheckSquare, Square, MoreVertical, SquareArrowOutUpRight, Newspaper, NotebookPen, Podcast, FileText, X, ArrowUp, MessageCircle } from 'lucide-react';
import { getSearchSnippet } from '../store/contentStore';
import { cleanHtml, formatDuration, getDomainFromUrl, toTweets } from '../format';
import type { ContentItem } from '../types';

// The library content card — thumbnail, title, metadata badges, generation
// status, star/archive/delete buttons and the per-item dropdown menu. Extracted
// from LibraryTab so the markup lives in one place; all state and handlers stay
// in the parent and come in as props.
interface ContentCardProps {
  item: ContentItem;
  bulkMode: boolean;
  selected: boolean;
  onToggleSelect: (id: number) => void;
  onPlay: (item: ContentItem, opts?: { tab?: 'summary' }) => void;
  searchQuery: string;
  showSummary: boolean; // "Twitter feed" mode: summary instead of description
  justCompleted: boolean; // show "✓ Completed" for a few seconds after generation
  dropdownOpen: boolean;
  dropdownRef: React.Ref<HTMLDivElement> | null;
  onToggleDropdown: () => void;
  onCancelGeneration: (id: number) => void;
  onToggleStarred: (id: number) => void;
  onToggleArchive: (id: number) => void;
  onDelete: (id: number) => void;
  onGenerateAudio: (id: number, regenerate: boolean) => void;
  onRemoveAudio: (id: number) => void;
  onGenerateSummary: (id: number, regenerate: boolean) => void;
  onRemoveSummary: (id: number) => void;
  onRegenerateTranscript: (id: number) => void;
  onRefetch: (id: number) => void;
  onAddToQueue: (item: ContentItem) => void;
  onDownloadZip: (item: ContentItem) => void;
}

export function ContentCard({
  item,
  bulkMode,
  selected,
  onToggleSelect,
  onPlay,
  searchQuery,
  showSummary,
  justCompleted,
  dropdownOpen,
  dropdownRef,
  onToggleDropdown,
  onCancelGeneration,
  onToggleStarred,
  onToggleArchive,
  onDelete,
  onGenerateAudio,
  onRemoveAudio,
  onGenerateSummary,
  onRemoveSummary,
  onRegenerateTranscript,
  onRefetch,
  onAddToQueue,
  onDownloadZip,
}: ContentCardProps) {
  // "Twitter feed" mode shows the first 3 summary tweets; [N more] expands the
  // rest inline on the card (article summary only — never the comment summary)
  const [summaryExpanded, setSummaryExpanded] = useState(false);
  const generationStatusDisplay = () => {
    if (!item.generation_status || item.generation_status === 'idle') {
      return null;
    }

    if (item.generation_status === 'completed') {
      // Show "Completed ✓" for 5 seconds after completion
      if (justCompleted) {
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
              onCancelGeneration(item.id);
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
    <div
      className={`content-card ${selected ? 'selected' : ''}`}
      onClick={() => bulkMode ? onToggleSelect(item.id) : onPlay(item)}
    >
      {bulkMode && (
        <div className="checkbox">
          {selected ? <CheckSquare size={20} /> : <Square size={20} />}
        </div>
      )}
      <div className="content-info">
        {item.preview_picture && (
          <img src={item.preview_picture} alt={item.title} className="thumbnail" />
        )}
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
        {showSummary && item.summary ? (() => {
          const tweets = toTweets(item.summary);
          const shown = summaryExpanded ? tweets : tweets.slice(0, 3);
          const hasMore = !summaryExpanded && tweets.length > 3;
          const moreCount = tweets.length - shown.length;
          return (
            <div className="library-summary">
              {shown.map((tweet, i) => {
                const isLast = i === shown.length - 1;
                return (
                  <p key={i} className="description library-summary-tweet">
                    {tweet}
                    {hasMore && isLast && (
                      <>
                        {' '}
                        <span
                          className="read-more-link"
                          onClick={(e) => { e.stopPropagation(); setSummaryExpanded(true); }}
                        >
                          [{moreCount} more]
                        </span>
                      </>
                    )}
                  </p>
                );
              })}
            </div>
          );
        })() : item.description ? (
          <p className="description">{cleanHtml(item.description).slice(0, 280)}...</p>
        ) : null}
        {searchQuery.trim() && (() => {
          const snippet = getSearchSnippet(item, searchQuery);
          return snippet ? (
            <p className="search-snippet">matched in text: <em>“{snippet}”</em></p>
          ) : null;
        })()}
        <div className="metadata">
          <span className="type" title={item.type}>
            {item.type === 'article' && <Newspaper size={16} className="icon-article" />}
            {item.type === 'text' && <NotebookPen size={16} className="icon-text" />}
            {item.type === 'podcast_episode' && <Podcast size={16} className="icon-podcast" />}
            {item.type === 'pdf' && <FileText size={16} />}
          </span>
          {item.audio_url && <span className="badge">Audio</span>}
          {item.summary_status === 'generating' && (
            <span className="badge summarizing">Summarizing…</span>
          )}
          {item.summary_status !== 'generating' && item.summary_generated_at && (
            <span className="badge summary">Summary</span>
          )}
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
        {generationStatusDisplay()}
        {item.summary_status === 'failed' && (
          <div className="generation-status error">
            <span>Summary failed</span>
            {item.summary_error && <span className="error-detail">: {item.summary_error}</span>}
            <button
              className="error-retry-btn"
              onClick={(e) => { e.stopPropagation(); onGenerateSummary(item.id, !!item.summary_generated_at); }}
              title="Retry summary generation"
            >
              Retry
            </button>
          </div>
        )}
      </div>
      {/* Star/archive stay visible in bulk mode — they show each item's state
          (filled star, highlighted archive) and still work as toggles.
          Delete and the dropdown are hidden to keep selection taps safe. */}
      <div className="content-actions" onClick={(e) => e.stopPropagation()}>
        <button
          onClick={() => onToggleStarred(item.id)}
          className={item.is_starred ? 'active' : ''}
          title="Toggle star"
        >
          <Star size={16} fill={item.is_starred ? 'currentColor' : 'none'} />
        </button>
        <button
          onClick={() => onToggleArchive(item.id)}
          title={item.is_archived ? "Restore from archive" : "Archive"}
          className={item.is_archived ? 'active' : ''}
        >
          {item.is_archived ? <ArchiveRestore size={16} /> : <Archive size={16} />}
        </button>
        {!bulkMode && (
          <>
          <button
            onClick={() => onDelete(item.id)}
            className="delete-btn"
            title="Delete"
          >
            <Trash2 size={16} />
          </button>
          <div className="dropdown-container" ref={dropdownRef}>
            <button
              onClick={onToggleDropdown}
              title="More options"
              className="more-options-btn"
            >
              <MoreVertical size={16} />
            </button>
            {dropdownOpen && (
              <div className="dropdown-menu">
                {(item.type === 'article' || item.type === 'text') && (
                  <>
                    {!item.audio_url && (
                      <button
                        onClick={() => onGenerateAudio(item.id, false)}
                        disabled={item.generation_status === 'generating_audio'}
                      >
                        Generate audio
                      </button>
                    )}
                    {item.audio_url && (
                      <>
                        <button
                          onClick={() => onGenerateAudio(item.id, true)}
                          disabled={item.generation_status === 'generating_audio'}
                        >
                          Regenerate audio
                        </button>
                        <button onClick={() => onRemoveAudio(item.id)}>
                          Remove audio
                        </button>
                      </>
                    )}
                  </>
                )}
                {/* Summaries: articles/texts summarize their body; podcasts their transcript
                    (the parent warns + chains transcription when none exists yet) */}
                {(item.type === 'article' || item.type === 'text' || item.type === 'podcast_episode') && (
                  <>
                    {item.summary_status === 'generating' ? (
                      <button disabled>Generating summary…</button>
                    ) : !item.summary_generated_at ? (
                      <button onClick={() => onGenerateSummary(item.id, false)}>
                        Generate summary
                      </button>
                    ) : (
                      <>
                        <button onClick={() => onGenerateSummary(item.id, true)}>
                          Regenerate summary
                        </button>
                        <button onClick={() => onRemoveSummary(item.id)}>
                          Remove summary
                        </button>
                      </>
                    )}
                  </>
                )}
                {(item.type === 'article' || item.type === 'text') && item.audio_url && (
                  <button
                    onClick={() => onRegenerateTranscript(item.id)}
                    disabled={item.generation_status === 'generating_transcript'}
                  >
                    Regenerate transcript
                  </button>
                )}
                {item.type === 'article' && item.url && (
                  <button onClick={() => onRefetch(item.id)}>
                    Refetch from web
                  </button>
                )}
                {item.type === 'podcast_episode' && (
                  <button
                    onClick={() => onRegenerateTranscript(item.id)}
                    disabled={item.generation_status === 'generating_transcript'}
                  >
                    {/* transcript_words, not transcript — the list endpoint doesn't send
                        the (large) transcript column, so checking it always said "Generate" */}
                    {item.transcript_words ? 'Regenerate transcript' : 'Generate transcript'}
                  </button>
                )}
                <button onClick={() => onAddToQueue(item)}>
                  Add to queue
                </button>
                <button onClick={() => onDownloadZip(item)}>
                  Download data (zip)
                </button>
              </div>
            )}
          </div>
          </>
        )}
      </div>
    </div>
  );
}
