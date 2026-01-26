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
  let cleaned = text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  cleaned = cleaned.replace(/<[^>]+>/g, ' ');
  cleaned = cleaned
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
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

  // Parse transcript words
  const transcriptWords = useMemo(() => {
    if (!content?.transcript_words) return [];
    try {
      return JSON.parse(content.transcript_words);
    } catch (error) {
      console.error('Failed to parse transcript words:', error);
      return [];
    }
  }, [content?.transcript_words]);

  // Calculate active word index (Sticky logic: highlighting stays on until next word)
  const activeWordIndex = useMemo(() => {
    if (!transcriptWords.length) return -1;
    // Find the last word that started before or at currentTime
    // This is more stable than checking start <= t <= end because spoken words have gaps
    for (let i = transcriptWords.length - 1; i >= 0; i--) {
      if (currentTime >= transcriptWords[i].start) {
        return i;
      }
    }
    return -1;
  }, [currentTime, transcriptWords]);

  const availableTabs = useMemo(() => {
    const tabs: TabType[] = [];
    if (content.type === 'article' || content.type === 'text') tabs.push('content');
    if (content.type === 'article' && isEAForumOrLessWrong(content.url || '')) tabs.push('comments');
    tabs.push('read-along');
    tabs.push('queue');
    return tabs;
  }, [content.type, content.url, parsedComments.length]);

  useState(() => {
    if (availableTabs.length > 0 && !availableTabs.includes(activeTab)) {
      setActiveTab(availableTabs[0]);
    }
  });

  const CommentComponent = ({ comment, depth = 0 }: { comment: Comment; depth?: number }) => {
    const metadataParts: string[] = [];
    if (comment.karma !== undefined && comment.karma !== null) {
      metadataParts.push(`${comment.karma} upvote${comment.karma !== 1 ? 's' : ''}`);
    }
    if (comment.extendedScore) {
      const isLessWrong = content.url ? content.url.includes('lesswrong.com') : false;
      if (isLessWrong) {
        if (typeof comment.extendedScore.agreement === 'number') {
          metadataParts.push(`${comment.extendedScore.agreement} agreement`);
        }
      } else {
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
                try { return new Date(comment.date).toLocaleDateString(); } catch { return comment.date; }
              })()}
            </span>
          )}
        </div>
        {hasMetadata && metadataParts.length > 0 && (
          <div className="comment-metadata">
            <span className="comment-votes">{metadataParts.join(' • ')}</span>
          </div>
        )}
        <div className="comment-content" dangerouslySetInnerHTML={{ __html: comment.content }} />
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
            <div className="article-content" dangerouslySetInnerHTML={{ __html: content.html_content || content.content || '<p>No content available</p>' }} />
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
        if (transcriptWords.length > 0) {
          return (
            <div className="tab-read-along-display">
              <div className="read-along-header"><h3>Read-along</h3></div>
              <p className="read-along-text">
                {transcriptWords.map((item: any, index: number) => {
                  const isActive = index === activeWordIndex;
                  return (
                    <span
                      key={index}
                      className={`transcript-word ${isActive ? 'current-word' : ''}`}
                      onClick={() => onTranscriptWordClick(item.start)}
                      style={{
                        backgroundColor: isActive ? 'rgba(37, 99, 235, 0.2)' : 'transparent',
                        borderRadius: '2px',
                        cursor: 'pointer',
                        transition: 'background-color 0.1s'
                      }}
                    >
                      {item.word}{' '}
                    </span>
                  );
                })}
              </p>
            </div>
          );
        }
        const displayText = cleanHtml(content.transcript || content.content || '');
        return (
          <div className="tab-read-along-display">
            <div className="read-along-header">
              <h3>Read-along (Text Only)</h3>
              {content.type === 'article' && (
                <button className="refetch-button" title="Regenerate audio">
                  <RefreshCw size={16} />
                </button>
              )}
            </div>
            {displayText ? (
              <p className="read-along-text">
                {displayText.split(/\s+/).map((word, index) => (
                  <span key={index} className="transcript-word" onClick={() => onTranscriptWordClick(index)}>
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
            <p style={{ fontSize: '0.875rem', color: '#9ca3af' }}>Queue functionality will be implemented soon.</p>
          </div>
        );
      default: return null;
    }
  };

  return (
    <div className="fullscreen-player">
      <div className="fullscreen-header">
        <div className="fullscreen-title-area">
          {content.preview_picture && (
            <img src={content.preview_picture} alt={content.title} className="fullscreen-thumbnail" />
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
            {content.author && <p className="fullscreen-author">{content.author}</p>}
          </div>
        </div>
        <div className="fullscreen-header-buttons">
          <button onClick={onMinimize} className="header-button" title="Minimize"><Minimize2 size={20} /></button>
          <button onClick={onClose} className="header-button" title="Close"><X size={20} /></button>
        </div>
      </div>
      <div className="fullscreen-tabs">
        {availableTabs.map((tab) => (
          <button key={tab} className={`tab-button ${activeTab === tab ? 'active' : ''}`} onClick={() => setActiveTab(tab)}>
            {tab === 'content' && 'Content'}
            {tab === 'comments' && `Comments${parsedComments.length > 0 ? ` (${parsedComments.length})` : ''}`}
            {tab === 'read-along' && 'Read-along'}
            {tab === 'queue' && 'Queue'}
          </button>
        ))}
      </div>
      <div className="fullscreen-tab-content">{renderTabContent()}</div>
      <div className="fullscreen-player-controls">
        <div className="fullscreen-progress-bar">
          <span className="time">{formatTime(currentTime)}</span>
          <input type="range" min="0" max={duration || 0} value={currentTime} onChange={(e) => onSeek(parseFloat(e.target.value))} className="progress-slider" />
          <span className="time">{formatTime(duration)}</span>
        </div>
        <div className="fullscreen-playback-controls">
          <button onClick={onSkipBackward} title="Seek backward 15 seconds" className="seek-btn">
            <RotateCcw className="seek-icon" /> <span className="seek-label">15</span>
          </button>
          <button onClick={onPlayPause} className="play-pause-btn">
            {isPlaying ? <Pause size={32} /> : <Play size={32} />}
          </button>
          <button onClick={onSkipForward} title="Seek forward 30 seconds" className="seek-btn">
            <RotateCw className="seek-icon" /> <span className="seek-label">30</span>
          </button>
        </div>
        <div className="fullscreen-player-options">
          <button onClick={onToggleSpeed} className="option-toggle"><Gauge size={20} /><span>{playbackSpeed}x</span></button>
          <button onClick={onToggleSleepTimer} className="option-toggle"><Clock size={20} /><span>{sleepTimer ? `${sleepTimer}m` : 'Off'}</span></button>
        </div>
      </div>
    </div>
  );
}
