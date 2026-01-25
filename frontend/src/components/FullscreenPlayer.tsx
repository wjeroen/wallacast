import { useState, useMemo } from 'react';
import {
  Play,
  Pause,
  RotateCcw,
  RotateCw,
  Gauge,
  Clock,
  X,
  Minimize2,
  SquareArrowOutUpRight,
  RefreshCw,
} from 'lucide-react';
import type { ContentItem, Comment } from '../types';

interface FullscreenPlayerProps {
  content: ContentItem;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  playbackSpeed: number;
  sleepTimer: number | null;
  onPlayPause: () => void;
  onSeek: (time: number) => void;
  onSkipBackward: () => void;
  onSkipForward: () => void;
  onSpeedChange: (speed: number) => void;
  onToggleSpeed: () => void;
  onToggleSleepTimer: () => void;
  onMinimize: () => void;
  onClose: () => void;
  onTranscriptWordClick: (wordIndex: number) => void;
  onRefetch?: () => void;
}

type TabType = 'content' | 'comments' | 'read-along' | 'queue';

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

function getDomainFromUrl(url: string): string {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function isEAForumOrLessWrong(url: string): boolean {
  if (!url) return false;
  const domain = getDomainFromUrl(url);
  
  return domain.includes('forum.effectivealtruism.org') || domain.includes('lesswrong.com');
}

function formatTime(seconds: number): string {
  if (!seconds || !isFinite(seconds)) return '0:00';

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

export function FullscreenPlayer({
  content,
  isPlaying,
  currentTime,
  duration,
  playbackSpeed,
  sleepTimer,
  onPlayPause,
  onSeek,
  onSkipBackward,
  onSkipForward,
  onToggleSpeed,
  onToggleSleepTimer,
  onMinimize,
  onClose,
  onTranscriptWordClick,
  onRefetch,
}: FullscreenPlayerProps) {
  const [activeTab, setActiveTab] = useState<TabType>('content');

  // Parse comments from JSON string if available
  const parsedComments: Comment[] = useMemo(() => {
    if (!content?.comments) return [];
    try {
      const comments = typeof content.comments === 'string'
        ? JSON.parse(content.comments)
        : content.comments;
      return comments || [];
    } catch (error) {
      console.error('Failed to parse comments:', error);
      return [];
    }
  }, [content?.comments]);

  // Determine which tabs are available
  const availableTabs = useMemo(() => {
    const tabs: TabType[] = [];

    // Content tab for articles and texts only
    if (content.type === 'article' || content.type === 'text') {
      tabs.push('content');
    }

    // Comments tab for EA Forum/LessWrong articles (even if no comments yet)
    if (content.type === 'article' && isEAForumOrLessWrong(content.url || '')) {
      tabs.push('comments');
    }

    // Read-along tab for all content types
    tabs.push('read-along');

    // Queue tab (always available but work in progress)
    tabs.push('queue');

    return tabs;
  }, [content.type, content.url, parsedComments.length]);

  // Auto-select first available tab
  useState(() => {
    if (availableTabs.length > 0 && !availableTabs.includes(activeTab)) {
      setActiveTab(availableTabs[0]);
    }
  });

  // Recursive component to render comments with replies
  const CommentComponent = ({ comment, depth = 0 }: { comment: Comment; depth?: number }) => {
    // Build metadata string like "94 upvotes • 16 agreement"
    const metadataParts: string[] = [];

    // Always show karma as "upvotes"
    if (comment.karma !== undefined && comment.karma !== null) {
      metadataParts.push(`${comment.karma} upvote${comment.karma !== 1 ? 's' : ''}`);
    }

    // Handle extended scores (reactions)
    if (comment.extendedScore) {
      const isLessWrong = content.url ? content.url.includes('lesswrong.com') : false;

      if (isLessWrong) {
        // LessWrong: Only show 'agreement' score (simplify - ignore other reactions)
        if (typeof comment.extendedScore.agreement === 'number') {
          metadataParts.push(`${comment.extendedScore.agreement} agreement`);
        }
      } else {
        // EA Forum (and others): Show ALL reactions
        Object.entries(comment.extendedScore).forEach(([reactionType, count]) => {
          const label = reactionType.toLowerCase();
          metadataParts.push(`${count} ${label}`);
        });
      }
    }

    const hasMetadata = metadataParts.length > 0;

    return (
      <div className="comment" style={{ marginLeft: `${depth * 20}px` }}>
        <div className="comment-header">
          <span className="comment-username">{comment.username}</span>
          {comment.date && (
            <span className="comment-date">
              {' • '}
              {(() => {
                try {
                  return new Date(comment.date).toLocaleDateString();
                } catch {
                  return comment.date;
                }
              })()}
            </span>
          )}
        </div>
        {hasMetadata && metadataParts.length > 0 && (
          <div className="comment-metadata">
            <span className="comment-votes">{metadataParts.join(' • ')}</span>
          </div>
        )}

        {/* Render HTML content (blockquotes, links, etc.) */}
        <div
          className="comment-content"
          dangerouslySetInnerHTML={{ __html: comment.content }}
        />

        {comment.replies && comment.replies.length > 0 && (
          <div className="comment-replies">
            {comment.replies.map((reply, idx) => (
              <CommentComponent key={idx} comment={reply} depth={depth + 1} />
            ))}
          </div>
        )}
      </div>
    );
  };

  const renderTabContent = () => {
    switch (activeTab) {
      case 'content':
        return (
          <div className="tab-content-display">
            <div className="content-header-with-button">
              <div className="content-header">
                <h2>{content.title}</h2>
                {content.author && <p className="content-author">By {content.author}</p>}
                {/* Only show domain URL for articles (not podcasts/texts) */}
                {content.url && content.type === 'article' && (
                  <p className="content-source">
                    <a href={content.url} target="_blank" rel="noopener noreferrer">
                      {getDomainFromUrl(content.url)}
                      <SquareArrowOutUpRight size={14} style={{ marginLeft: '0.25rem' }} />
                    </a>
                  </p>
                )}
              </div>
              {content.url && onRefetch && (
                <button className="refetch-button" title="Refetch content" onClick={onRefetch}>
                  <RefreshCw size={16} />
                </button>
              )}
            </div>
            <div
              className="article-content"
              dangerouslySetInnerHTML={{ __html: content.html_content || content.content || '<p>No content available</p>' }}
            />
          </div>
        );
      case 'comments':
        return (
          <div className="tab-comments-display">
            <div className="comments-header">
              <h3>Comments ({parsedComments.length})</h3>
              {onRefetch && (
                <button className="refetch-button" title="Refetch comments" onClick={onRefetch}>
                  <RefreshCw size={16} />
                </button>
              )}
            </div>
            {parsedComments.length > 0 ? (
              <div className="comments-list">
                {parsedComments.map((comment, index) => (
                  <CommentComponent key={index} comment={comment} depth={0} />
                ))}
              </div>
            ) : (
              <p className="no-content">No comments available. Click the refresh button to fetch comments.</p>
            )}
          </div>
        );
      case 'read-along':
        const transcript = content.transcript || content.content || '';
        const displayText = cleanHtml(transcript);

        return (
          <div className="tab-read-along-display">
            <div className="read-along-header">
              <h3>Read-along</h3>
              {content.type === 'article' && (
                <button className="refetch-button" title="Regenerate audio">
                  <RefreshCw size={16} />
                </button>
              )}
            </div>
            {displayText ? (
              <p className="read-along-text">
                {displayText.split(/\s+/).map((word, index) => (
                  <span
                    key={index}
                    className="transcript-word"
                    onClick={() => onTranscriptWordClick(index)}
                  >
                    {word}{' '}
                  </span>
                ))}
              </p>
            ) : (
              <p className="no-content">No transcript available</p>
            )}
          </div>
        );
      case 'queue':
        return (
          <div className="tab-queue-display">
            <h3>Queue</h3>
            <p className="work-in-progress">🚧 Work in progress</p>
            <p style={{ fontSize: '0.875rem', color: '#9ca3af' }}>
              Queue functionality will be implemented soon. Stay tuned!
            </p>
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <div className="fullscreen-player">
      <div className="fullscreen-header">
        <div className="fullscreen-title-area">
          {content.preview_picture && (
            <img
              src={content.preview_picture}
              alt={content.title}
              className="fullscreen-thumbnail"
            />
          )}
          <div>
            <h2 className="fullscreen-title">{content.title}</h2>
            {content.url && (
              <p className="fullscreen-source-link">
                <a href={content.url} target="_blank" rel="noopener noreferrer">
                  {getDomainFromUrl(content.url)}
                  <SquareArrowOutUpRight size={14} style={{ marginLeft: '0.25rem' }} />
                </a>
              </p>
            )}
            {content.author && (
              <p className="fullscreen-author">
                {content.author}
                {content.published_date && (
                  <> • {new Date(content.published_date).toLocaleDateString()}</>
                )}
                {(content.karma !== undefined && content.karma !== null) && (
                  <> • {content.karma} upvotes</>
                )}
              </p>
            )}
          </div>
        </div>
        <div className="fullscreen-header-buttons">
          <button onClick={onMinimize} className="header-button" title="Minimize">
            <Minimize2 size={20} />
          </button>
          <button onClick={onClose} className="header-button" title="Close">
            <X size={20} />
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="fullscreen-tabs">
        {availableTabs.map((tab) => (
          <button
            key={tab}
            className={`tab-button ${activeTab === tab ? 'active' : ''}`}
            onClick={() => setActiveTab(tab)}
          >
            {tab === 'content' && 'Content'}
            {tab === 'comments' && `Comments${parsedComments.length > 0 ? ` (${parsedComments.length})` : ''}`}
            {tab === 'read-along' && 'Read-along'}
            {tab === 'queue' && 'Queue'}
          </button>
        ))}
      </div>

      {/* Tab Content Area */}
      <div className="fullscreen-tab-content">
        {renderTabContent()}
      </div>

      {/* Player Controls */}
      <div className="fullscreen-player-controls">
        <div className="fullscreen-progress-bar">
          <span className="time">{formatTime(currentTime)}</span>
          <input
            type="range"
            min="0"
            max={duration || 0}
            value={currentTime}
            onChange={(e) => onSeek(parseFloat(e.target.value))}
            className="progress-slider"
          />
          <span className="time">{formatTime(duration)}</span>
        </div>

        <div className="fullscreen-playback-controls">
          <button onClick={onSkipBackward} title="Seek backward 15 seconds" className="seek-btn">
            <RotateCcw className="seek-icon" />
            <span className="seek-label">15</span>
          </button>

          <button onClick={onPlayPause} className="play-pause-btn">
            {isPlaying ? <Pause size={32} /> : <Play size={32} />}
          </button>

          <button onClick={onSkipForward} title="Seek forward 30 seconds" className="seek-btn">
            <RotateCw className="seek-icon" />
            <span className="seek-label">30</span>
          </button>
        </div>

        <div className="fullscreen-player-options">
          <button onClick={onToggleSpeed} className="option-toggle">
            <Gauge size={20} />
            <span>{playbackSpeed}x</span>
          </button>

          <button onClick={onToggleSleepTimer} className="option-toggle">
            <Clock size={20} />
            <span>{sleepTimer ? `${sleepTimer}m` : 'Off'}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
