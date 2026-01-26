import { useState, useMemo, memo } from 'react';
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
  // Kept in interface so AudioPlayer.tsx doesn't break
  onTranscriptWordClick: (wordIndex: number) => void; 
  onRefetch?: () => void;
}

type TabType = 'content' | 'comments' | 'read-along' | 'queue';

// --- Helper Types & Functions ---

interface TranscriptWord {
  word: string;
  start: number;
  end: number;
}

interface TranscriptSentence {
  text: string;
  start: number;
  end: number;
  words: TranscriptWord[];
}

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
  return cleaned.replace(/\s+/g, ' ').trim();
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
  if (hours > 0) return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

/**
 * OPTIMIZED COMPONENT: Sentence-based Read Along
 * Uses memo to prevent re-rendering on every millisecond tick.
 * Only re-renders when the active sentence index changes.
 */
const ReadAlongDisplay = memo(({ 
  sentences, 
  activeIndex, 
  onSentenceClick 
}: { 
  sentences: TranscriptSentence[]; 
  activeIndex: number; 
  onSentenceClick: (start: number) => void;
}) => {
  return (
    <div className="tab-read-along-display">
      <div className="read-along-header">
        <h3>Read-along</h3>
      </div>
      <div className="read-along-text" style={{ lineHeight: '1.8', fontSize: '1.1rem' }}>
        {sentences.map((sentence, index) => {
          const isActive = index === activeIndex;
          return (
            <span
              key={index}
              onClick={() => onSentenceClick(sentence.start)}
              style={{
                backgroundColor: isActive ? 'rgba(251, 191, 36, 0.4)' : 'transparent', // Golden highlight
                borderRadius: '4px',
                padding: '2px 4px',
                margin: '0 2px',
                cursor: 'pointer',
                transition: 'background-color 0.2s ease',
                display: 'inline',
                boxDecorationBreak: 'clone',
                WebkitBoxDecorationBreak: 'clone'
              }}
            >
              {sentence.text}{' '}
            </span>
          );
        })}
      </div>
    </div>
  );
});

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
  // Removed onTranscriptWordClick from arguments to fix unused var error
  // It is still in the Interface above, so AudioPlayer won't crash
  onRefetch,
}: FullscreenPlayerProps) {
  const [activeTab, setActiveTab] = useState<TabType>('content');

  // --- DATA PREPARATION ---

  const parsedComments: Comment[] = useMemo(() => {
    if (!content?.comments) return [];
    try {
      const comments = typeof content.comments === 'string' ? JSON.parse(content.comments) : content.comments;
      return comments || [];
    } catch (error) { return []; }
  }, [content?.comments]);

  // Transform words into sentences
  const transcriptSentences = useMemo(() => {
    if (!content?.transcript_words) return [];
    try {
      const words: TranscriptWord[] = JSON.parse(content.transcript_words);
      const sentences: TranscriptSentence[] = [];
      let currentSentence: TranscriptWord[] = [];

      words.forEach((word) => {
        currentSentence.push(word);
        // Break on punctuation or newlines
        if (/[.!?]$/.test(word.word.trim()) || word.word.includes('\n')) {
          if (currentSentence.length > 0) {
            sentences.push({
              text: currentSentence.map(w => w.word).join(' '),
              start: currentSentence[0].start,
              end: currentSentence[currentSentence.length - 1].end,
              words: [...currentSentence]
            });
            currentSentence = [];
          }
        }
      });

      // Flush remaining words
      if (currentSentence.length > 0) {
        sentences.push({
          text: currentSentence.map(w => w.word).join(' '),
          start: currentSentence[0].start,
          end: currentSentence[currentSentence.length - 1].end,
          words: currentSentence
        });
      }
      return sentences;
    } catch (e) { return []; }
  }, [content?.transcript_words]);

  // Efficiently find the active sentence
  const activeSentenceIndex = useMemo(() => {
    if (!transcriptSentences.length) return -1;
    // Iterate backwards to find the latest started sentence
    for (let i = transcriptSentences.length - 1; i >= 0; i--) {
      if (currentTime >= transcriptSentences[i].start) {
        return i;
      }
    }
    return -1;
  }, [currentTime, transcriptSentences]);

  // --- TABS LOGIC ---

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

  // --- RENDERING ---

  const CommentComponent = ({ comment, depth = 0 }: { comment: Comment; depth?: number }) => {
    const metadataParts: string[] = [];
    if (comment.karma !== undefined && comment.karma !== null) {
      metadataParts.push(`${comment.karma} upvote${comment.karma !== 1 ? 's' : ''}`);
    }
    if (comment.extendedScore) {
      const isLessWrong = content.url ? content.url.includes('lesswrong.com') : false;
      if (isLessWrong) {
        // LessWrong: prioritize 'agreement'
        if (typeof comment.extendedScore.agreement === 'number') {
          metadataParts.push(`${comment.extendedScore.agreement} agreement`);
        }
      } else {
        // EA Forum: show all
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
              {(() => { try { return new Date(comment.date).toLocaleDateString(); } catch { return comment.date; } })()}
            </span>
          )}
        </div>
        {hasMetadata && <div className="comment-metadata"><span className="comment-votes">{metadataParts.join(' • ')}</span></div>}
        <div className="comment-content" dangerouslySetInnerHTML={{ __html: comment.content }} />
        {comment.replies && comment.replies.length > 0 && (
          <div className="comment-replies">
            {comment.replies.map((reply, idx) => <CommentComponent key={idx} comment={reply} depth={depth + 1} />)}
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
                <button className="refetch-button" title="Refetch content" onClick={onRefetch}><RefreshCw size={16} /></button>
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
              {onRefetch && <button className="refetch-button" title="Refetch comments" onClick={onRefetch}><RefreshCw size={16} /></button>}
            </div>
            {parsedComments.length > 0 ? (
              <div className="comments-list">
                {parsedComments.map((comment, index) => <CommentComponent key={index} comment={comment} depth={0} />)}
              </div>
            ) : <p className="no-content">No comments available.</p>}
          </div>
        );

      case 'read-along':
        if (transcriptSentences.length > 0) {
          return (
            <ReadAlongDisplay 
              sentences={transcriptSentences} 
              activeIndex={activeSentenceIndex} 
              onSentenceClick={onSeek} 
            />
          );
        }
        
        const displayText = cleanHtml(content.transcript || content.content || '');
        return (
          <div className="tab-read-along-display">
            <div className="read-along-header">
              <h3>Read-along (Text Only)</h3>
              {content.type === 'article' && (
                <button className="refetch-button" title="Regenerate audio"><RefreshCw size={16} /></button>
              )}
            </div>
            <p className="read-along-text">{displayText || 'No transcript available'}</p>
          </div>
        );

      case 'queue':
        return (
          <div className="tab-queue-display">
            <h3>Queue</h3>
            <p className="work-in-progress">🚧 Work in progress</p>
          </div>
        );
      default: return null;
    }
  };

  return (
    <div className="fullscreen-player">
      <div className="fullscreen-header">
        <div className="fullscreen-title-area">
          {content.preview_picture && <img src={content.preview_picture} alt={content.title} className="fullscreen-thumbnail" />}
          <div>
            <h2 className="fullscreen-title">{content.title}</h2>
            {content.url && (
              <p className="fullscreen-source-link">
                <a href={content.url} target="_blank" rel="noopener noreferrer">{getDomainFromUrl(content.url)}<SquareArrowOutUpRight size={14} style={{ marginLeft: '0.25rem' }} /></a>
              </p>
            )}
            {content.author && <p className="fullscreen-author">{content.author}</p>}
          </div>
        </div>
        <div className="fullscreen-header-buttons">
          <button onClick={onMinimize} className="header-button"><Minimize2 size={20} /></button>
          <button onClick={onClose} className="header-button"><X size={20} /></button>
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
          <button onClick={onSkipBackward} className="seek-btn"><RotateCcw className="seek-icon" /> <span className="seek-label">15</span></button>
          <button onClick={onPlayPause} className="play-pause-btn">{isPlaying ? <Pause size={32} /> : <Play size={32} />}</button>
          <button onClick={onSkipForward} className="seek-btn"><RotateCw className="seek-icon" /> <span className="seek-label">30</span></button>
        </div>
        <div className="fullscreen-player-options">
          <button onClick={onToggleSpeed} className="option-toggle"><Gauge size={20} /><span>{playbackSpeed}x</span></button>
          <button onClick={onToggleSleepTimer} className="option-toggle"><Clock size={20} /><span>{sleepTimer ? `${sleepTimer}m` : 'Off'}</span></button>
        </div>
      </div>
    </div>
  );
}
