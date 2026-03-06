import { useState, useMemo, useEffect, useCallback, useRef } from 'react';
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
  ArrowDownToLine,
} from 'lucide-react';
import type { ContentItem, Comment } from '../types';

interface TranscriptWord {
  word: string;
  start: number;
  end: number;
}

interface LLMAlignmentElement {
  type: string;
  html: string;
  startTime: number;
  commentMeta?: {
    username: string;
    date?: string;
    karma?: number;
    extendedScore?: Record<string, number>;
    depth: number;
  };
}

interface FullscreenPlayerProps {
  content: ContentItem;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  playbackSpeed: number;
  sleepTimer: number | null;
  activeWordIndex?: number;
  transcriptWords?: TranscriptWord[];
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

type TabType = 'content' | 'description' | 'comments' | 'read-along' | 'queue';

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

/**
 * Count total comments including all nested replies.
 * parsedComments only gives top-level count; this recurses into replies.
 */
function countAllComments(comments: Comment[]): number {
  let count = 0;
  for (const c of comments) {
    count += 1;
    if (c.replies && c.replies.length > 0) {
      count += countAllComments(c.replies);
    }
  }
  return count;
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

/**
 * Build metadata string for a comment (e.g., "5 upvotes · 3 agreement")
 */
function buildCommentMetadata(
  meta: LLMAlignmentElement['commentMeta'],
  isLessWrong: boolean
): string {
  if (!meta) return '';
  const parts: string[] = [];

  if (meta.karma !== undefined && meta.karma !== null) {
    parts.push(`${meta.karma} upvote${meta.karma !== 1 ? 's' : ''}`);
  }

  if (meta.extendedScore) {
    if (isLessWrong) {
      if (typeof meta.extendedScore.agreement === 'number') {
        parts.push(`${meta.extendedScore.agreement} agreement`);
      }
    } else {
      Object.entries(meta.extendedScore).forEach(([reaction, count]) => {
        if (count > 0 && reaction !== 'baseScore') {
          parts.push(`${count} ${reaction.toLowerCase()}`);
        }
      });
    }
  }

  return parts.join(' \u00B7 ');
}

export function FullscreenPlayer({
  content,
  isPlaying,
  currentTime,
  duration,
  playbackSpeed,
  sleepTimer,
  activeWordIndex = -1,
  transcriptWords = [],
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
  // Default tab: 'description' for podcasts, 'read-along' (now labeled "Content") for everything else
  const [activeTab, setActiveTab] = useState<TabType>(
    content.type === 'podcast_episode' ? 'description' : 'read-along'
  );
  const [autoScroll, setAutoScroll] = useState(() => {
    return localStorage.getItem('readAlongAutoScroll') !== 'false';
  });
  // Toggle: show newest fetched html_content vs synced LLM alignment
  const [showUnsyncedContent, setShowUnsyncedContent] = useState(false);

  // Reset unsynced toggle when content changes
  useEffect(() => {
    setShowUnsyncedContent(false);
  }, [content.id]);

  // Show "newest fetch" toggle when article was refetched after audio was generated
  const canShowUnsyncedToggle = useMemo(() => {
    if (!content.audio_generated_at || !content.content_fetched_at) return false;
    return new Date(content.content_fetched_at) > new Date(content.audio_generated_at);
  }, [content.audio_generated_at, content.content_fetched_at]);

  // Persist autoscroll preference
  useEffect(() => {
    localStorage.setItem('readAlongAutoScroll', String(autoScroll));
  }, [autoScroll]);

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

  // Total comment count including all nested replies
  const totalCommentCount = useMemo(() => countAllComments(parsedComments), [parsedComments]);

  // Parse content alignment data if available
  const parsedAlignment = useMemo(() => {
    if (!content?.content_alignment) return null;
    try {
      const alignment = typeof content.content_alignment === 'string'
        ? JSON.parse(content.content_alignment)
        : content.content_alignment;
      return alignment || null;
    } catch (error) {
      console.error('Failed to parse content alignment:', error);
      return null;
    }
  }, [content?.content_alignment]);

  // Check if this is the new LLM-based alignment
  const isLLMAlignment = parsedAlignment?.version === 'llm-v1';

  // Extract comments start time for timeline marker
  const commentsStartTime = parsedAlignment?.commentsStartTime || null;

  // Calculate marker position as percentage
  const commentsMarkerPosition = useMemo(() => {
    if (!commentsStartTime || !duration || duration === 0) return null;
    return (commentsStartTime / duration) * 100;
  }, [commentsStartTime, duration]);

  // Find active element index for LLM alignment
  const activeElementIndex = useMemo(() => {
    if (!isLLMAlignment || !parsedAlignment?.elements) return -1;
    const elements = parsedAlignment.elements as LLMAlignmentElement[];

    let activeIdx = -1;
    for (let i = 0; i < elements.length; i++) {
      if (elements[i].startTime <= currentTime) {
        activeIdx = i;
      } else {
        break;
      }
    }
    return activeIdx;
  }, [isLLMAlignment, parsedAlignment, currentTime]);

  // Legacy: Extract HTML sections for old aligned read-along (non-LLM)
  // Determine which tabs are available
  // NOTE: 'content' (Original Content) and 'comments' tabs are hidden — the read-along
  // tab now renders content AND comments with per-element timestamps and is the default.
  // The old tabs are kept in the code so they can be re-enabled easily if needed.
  const availableTabs = useMemo(() => {
    const tabs: TabType[] = [];
    // Hidden tabs (uncomment to re-enable):
    // if (content.type === 'article' || content.type === 'text') tabs.push('content');  // Original Content tab
    // if (content.type === 'article' && isEAForumOrLessWrong(content.url || '')) tabs.push('comments');  // Comments tab
    if (content.type === 'podcast_episode') tabs.push('description');
    tabs.push('read-along');
    tabs.push('queue');
    return tabs;
  }, [content.type, content.url, parsedComments.length]);

  // Auto-select first available tab
  useState(() => {
    if (availableTabs.length > 0 && !availableTabs.includes(activeTab)) {
      setActiveTab(availableTabs[0]);
    }
  });

  // Scroll active element into view, with progressive intra-element scrolling for tall elements
  const scrollToActive = useCallback(() => {
    // Legacy word-by-word scroll for podcasts
    if (!isLLMAlignment || activeElementIndex < 0) {
      if (activeWordIndex >= 0) {
        const el = document.getElementById(`word-${activeWordIndex}`);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      return;
    }

    const element = document.getElementById(`ra-el-${activeElementIndex}`);
    if (!element) return;

    // Find the scrollable container
    const container = element.closest('.fullscreen-tab-content') as HTMLElement | null;
    if (!container) return;

    const elementRect = element.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const viewportHeight = container.clientHeight;
    const elementHeight = elementRect.height;

    // For short elements (< 60% of viewport), use simple center scroll
    if (elementHeight < viewportHeight * 0.6) {
      element.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }

    // Progressive scroll for tall elements: smoothly move through them as audio plays
    const elements = (parsedAlignment?.elements || []) as LLMAlignmentElement[];
    const elStartTime = elements[activeElementIndex].startTime;
    const elEndTime = activeElementIndex + 1 < elements.length
      ? elements[activeElementIndex + 1].startTime
      : (duration || elStartTime + 10);

    const elDuration = elEndTime - elStartTime;
    if (elDuration <= 0) {
      element.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }

    // Progress: 0 = start of element's audio, 1 = end
    const progress = Math.max(0, Math.min(1, (currentTime - elStartTime) / elDuration));

    // At progress=0: top of element ~15% from top of viewport
    // At progress=1: bottom of element ~15% from bottom of viewport
    const padding = viewportHeight * 0.15;
    const scrollOffset = progress * Math.max(0, elementHeight - viewportHeight + 2 * padding);
    const targetScroll = container.scrollTop + (elementRect.top - containerRect.top) - padding + scrollOffset;

    container.scrollTo({ top: Math.max(0, targetScroll), behavior: 'smooth' });
  }, [activeWordIndex, activeElementIndex, isLLMAlignment, currentTime, duration, parsedAlignment]);

  // Keep a ref to scrollToActive so the tab-switch effect can use the latest
  // version without re-firing on every currentTime tick
  const scrollToActiveRef = useRef(scrollToActive);
  useEffect(() => {
    scrollToActiveRef.current = scrollToActive;
  }, [scrollToActive]);

  // Trigger scroll once when switching to read-along tab
  useEffect(() => {
    if (activeTab === 'read-along') {
      setTimeout(() => scrollToActiveRef.current(), 100);
    }
  }, [activeTab]);

  // Auto-scroll as audio plays (only when autoScroll is on)
  useEffect(() => {
    if (activeTab === 'read-along' && autoScroll) {
      scrollToActive();
    }
  }, [activeTab, currentTime, autoScroll, scrollToActive]);

  const handleTabClick = (tab: TabType) => {
    if (tab === 'read-along' && activeTab === 'read-along') {
      scrollToActive();
    } else {
      setActiveTab(tab);
    }
  };

  // Recursive component to render comments with replies (for Comments tab)
  const CommentComponent = ({ comment, depth = 0 }: { comment: Comment; depth?: number }) => {
    const metadataParts: string[] = [];
    if (comment.karma !== undefined && comment.karma !== null) {
      metadataParts.push(`${comment.karma} upvote${comment.karma !== 1 ? 's' : ''}`);
    }
    if (comment.extendedScore) {
      const isLW = content.url ? content.url.includes('lesswrong.com') : false;
      if (isLW) {
        if (typeof comment.extendedScore.agreement === 'number') {
          metadataParts.push(`${comment.extendedScore.agreement} agreement`);
        }
      } else {
        Object.entries(comment.extendedScore).forEach(([reactionType, count]) => {
          metadataParts.push(`${count} ${reactionType.toLowerCase()}`);
        });
      }
    }

    return (
      <div className="comment">
        <div className="comment-header">
          <span className="comment-username">{comment.username}</span>
          {comment.date && (
            <span className="comment-date">
              {' \u00B7 '}
              {(() => { try { return new Date(comment.date).toLocaleDateString('en-GB'); } catch { return comment.date; } })()}
            </span>
          )}
        </div>
        {metadataParts.length > 0 && (
          <div className="comment-metadata">
            <span className="comment-votes">{metadataParts.join(' \u00B7 ')}</span>
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

  // --------------------------------------------------------------------------
  // LLM Read-Along Renderer
  // Renders content EXACTLY like content tab + comments tab, with timestamps
  // --------------------------------------------------------------------------
  const renderLLMReadAlong = () => {
    if (!parsedAlignment || !isLLMAlignment) return null;

    const elements = parsedAlignment.elements as LLMAlignmentElement[];
    const isLW = content.url ? content.url.includes('lesswrong.com') : false;

    // Split elements into categories
    const titleEl = elements.find(e => e.type === 'title');
    const metaElements = elements.filter(e => e.type === 'meta');
    const bodyElements = elements.filter(e =>
      ['heading', 'paragraph', 'image', 'blockquote', 'list', 'code-block'].includes(e.type)
    );
    const commentDivider = elements.find(e => e.type === 'comment-divider');
    const commentElements = elements.filter(e => e.type === 'comment');

    return (
      <div className="tab-content-display">
        {/* Header section (mirrors content tab header) */}
        <div className="content-header" style={{ marginBottom: '1rem' }}>
          {/* Title - timestamped */}
          {titleEl && (
            <div
              id={`ra-el-${elements.indexOf(titleEl)}`}
              className={`read-along-element ${elements.indexOf(titleEl) === activeElementIndex ? 'ra-active' : ''}`}
              onClick={() => onSeek(titleEl.startTime)}
            >
              <h2 style={{ margin: '0 0 0.5rem 0', color: '#f1f5f9', fontSize: '1.5rem' }}>{content.title}</h2>
            </div>
          )}

          {/* Author/date meta - timestamped */}
          {metaElements.map((el, i) => (
            <div
              key={`meta-${i}`}
              id={`ra-el-${elements.indexOf(el)}`}
              className={`read-along-element ${elements.indexOf(el) === activeElementIndex ? 'ra-active' : ''}`}
              onClick={() => onSeek(el.startTime)}
            >
              <div dangerouslySetInnerHTML={{ __html: el.html }} />
            </div>
          ))}

          {/* URL removed — already shown in fullscreen player header */}
          {content.type === 'article' && content.content_source && (
            <p className="content-provenance" style={{ fontSize: '0.75rem', color: '#9ca3af', marginTop: '0.25rem', paddingLeft: '3px' }}>
              Fetched by {content.content_source} on {(content.content_fetched_at || content.updated_at) ? new Date(content.content_fetched_at || content.updated_at!).toLocaleDateString('en-GB') : 'unknown date'}
              {content.audio_generated_at && content.audio_url && (
                <> &bull; Narration generated on {new Date(content.audio_generated_at).toLocaleDateString('en-GB')}</>
              )}
              {canShowUnsyncedToggle && (
                <>
                  <br />
                  <button
                    onClick={() => setShowUnsyncedContent(v => !v)}
                    style={{ background: 'none', border: 'none', color: '#60a5fa', cursor: 'pointer', padding: 0, fontSize: 'inherit', textDecoration: 'underline' }}
                  >
                    {showUnsyncedContent ? 'Show synced (older fetch)' : 'Show newest fetch (not synced)'}
                  </button>
                </>
              )}
            </p>
          )}
        </div>

        {/* Article body (same .article-content CSS as content tab) */}
        {showUnsyncedContent ? (
          <div
            className="article-content"
            dangerouslySetInnerHTML={{ __html: content.html_content || content.content || '<p>No content available</p>' }}
          />
        ) : (
          <div className="article-content">
            {bodyElements.map((el, i) => {
              const globalIndex = elements.indexOf(el);
              const isActive = globalIndex === activeElementIndex;
              return (
                <div
                  key={`body-${i}`}
                  id={`ra-el-${globalIndex}`}
                  className={`read-along-element ${isActive ? 'ra-active' : ''}`}
                  onClick={() => onSeek(el.startTime)}
                >
                  <div dangerouslySetInnerHTML={{ __html: el.html }} />
                </div>
              );
            })}
          </div>
        )}

        {/* Comments section (same nesting as comments tab) */}
        {commentElements.length > 0 && (() => {
          // Build tree from flat depth-tracked comments to match comments tab nesting
          interface CommentNode {
            element: LLMAlignmentElement;
            globalIndex: number;
            children: CommentNode[];
          }
          const roots: CommentNode[] = [];
          const stack: CommentNode[] = [];
          for (const el of commentElements) {
            const depth = el.commentMeta?.depth ?? 0;
            const node: CommentNode = { element: el, globalIndex: elements.indexOf(el), children: [] };
            while (stack.length > depth) stack.pop();
            if (stack.length === 0) {
              roots.push(node);
            } else {
              stack[stack.length - 1].children.push(node);
            }
            stack.push(node);
          }

          const renderCommentNode = (node: CommentNode): React.ReactNode => {
            const { element: el, globalIndex, children } = node;
            const isActive = globalIndex === activeElementIndex;
            const meta = el.commentMeta;
            const metaStr = buildCommentMetadata(meta, isLW);
            return (
              <div className="comment" key={`comment-${globalIndex}`}>
                <div
                  id={`ra-el-${globalIndex}`}
                  className={`read-along-element ${isActive ? 'ra-active' : ''}`}
                  onClick={(e) => { e.stopPropagation(); onSeek(el.startTime); }}
                >
                  <div className="comment-header">
                    <span className="comment-username">{meta?.username || 'Anonymous'}</span>
                    {meta?.date && (
                      <span className="comment-date">
                        {' \u00B7 '}
                        {(() => { try { return new Date(meta.date).toLocaleDateString('en-GB'); } catch { return meta.date; } })()}
                      </span>
                    )}
                  </div>
                  {metaStr && (
                    <div className="comment-metadata">
                      <span className="comment-votes">{metaStr}</span>
                    </div>
                  )}
                  <div className="comment-content" dangerouslySetInnerHTML={{ __html: el.html }} />
                </div>
                {children.length > 0 && (
                  <div className="comment-replies">
                    {children.map(child => renderCommentNode(child))}
                  </div>
                )}
              </div>
            );
          };

          return (
            <div className="tab-comments-display" style={{ marginTop: '2rem' }}>
              {/* Orange divider line — matches the orange timeline marker */}
              <div className="read-along-comments-divider" />
              {commentDivider && (
                <div
                  id={`ra-el-${elements.indexOf(commentDivider)}`}
                  className={`comments-header read-along-element ${elements.indexOf(commentDivider) === activeElementIndex ? 'ra-active' : ''}`}
                  onClick={() => onSeek(commentDivider.startTime)}
                >
                  <h3>Comments ({commentElements.length})</h3>
                </div>
              )}
              <div className="comments-list">
                {roots.map(node => renderCommentNode(node))}
              </div>
            </div>
          );
        })()}
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
                {content.author && (
                  <p className="content-author">
                    By {content.author}
                    {content.published_at && (
                      <> {new Date(content.published_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</>
                    )}
                    {isEAForumOrLessWrong(content.url || '') && content.karma !== undefined && content.karma !== null && (
                      <> {content.karma} karma</>
                    )}
                  </p>
                )}
                {/* URL removed — already shown in fullscreen player header */}
                {content.type === 'article' && content.content_source && (
                  <p className="content-provenance" style={{ fontSize: '0.75rem', color: '#9ca3af', marginTop: '0.25rem' }}>
                    Fetched by {content.content_source} on {(content.content_fetched_at || content.updated_at) ? new Date(content.content_fetched_at || content.updated_at!).toLocaleDateString('en-GB') : 'unknown date'}
                    {content.audio_generated_at && content.audio_url && (
                      <> &bull; Narration generated on {new Date(content.audio_generated_at).toLocaleDateString('en-GB')}</>
                    )}
                  </p>
                )}
              </div>
              {content.type === 'article' && content.url && onRefetch && (
                <button className="refetch-button" title="Refetch content and comments from web" onClick={onRefetch}>
                  <RefreshCw size={16} />
                  <span className="refetch-text-full">Refetch from web</span>
                  <span className="refetch-text-short">Refetch</span>
                </button>
              )}
            </div>
            <div
              className="article-content"
              dangerouslySetInnerHTML={{ __html: content.html_content || content.content || '<p>No content available</p>' }}
            />
          </div>
        );
      case 'description':
        return (
          <div className="tab-content-display">
            <h3>Podcast Description</h3>
            {content.description ? (
              <div
                className="article-content"
                style={{ marginTop: '1rem', whiteSpace: 'pre-wrap' }}
                dangerouslySetInnerHTML={{ __html: content.description }}
              />
            ) : (
              <p className="no-content">No description available</p>
            )}
          </div>
        );
      case 'comments':
        return (
          <div className="tab-comments-display">
            <div className="comments-header">
              <h3>Comments ({totalCommentCount})</h3>
              {onRefetch && (
                <button className="refetch-button" title="Refetch content and comments from web" onClick={onRefetch}>
                  <RefreshCw size={16} />
                  <span className="refetch-text-full">Refetch from web</span>
                  <span className="refetch-text-short">Refetch</span>
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
      case 'read-along': {
        const isPodcast = content.type === 'podcast_episode';
        const isGenerating = content.generation_status && !['idle', 'completed', 'failed'].includes(content.generation_status);
        const isTranscribing = content.current_operation === 'transcribing';
        const isAligning = content.current_operation === 'aligning_content';
        const hasAudio = !!content.audio_url;
        const hasTranscript = transcriptWords.length > 0 || !!content.transcript;

        const hasWhisperWords = transcriptWords.length > 0;
        const fallbackTranscript = content.transcript || content.content || '';
        const fallbackText = cleanHtml(fallbackTranscript);
        const displayWords = hasWhisperWords
          ? transcriptWords.map(w => (w.word || '').replace(/^\s+/, ''))
          : fallbackText.split(/\s+/).filter(w => w.length > 0);

        // For articles/texts: if we have LLM alignment, use it (with read-along features).
        // If not, show the raw content + comments (like the old Content tab) without timestamps.
        // For podcasts: show transcript words or status messages.
        if (isPodcast) {
          // Podcast: show word-by-word transcript or status messages
          let podcastMessage: string | null = null;
          if (!hasAudio && isGenerating) {
            podcastMessage = 'Audio is being generated...';
          } else if (isTranscribing) {
            podcastMessage = 'Transcript is being generated... This may take a minute.';
          } else if (!hasTranscript) {
            podcastMessage = 'No transcript available. Transcripts can be generated from the library.';
          }

          return (
            <div className="tab-read-along-display">
              {podcastMessage ? (
                <p className="no-content">{podcastMessage}</p>
              ) : displayWords.length > 0 ? (
                <p className="read-along-text">
                  {displayWords.map((word, index) => {
                    const isRead = index <= activeWordIndex;
                    return (
                      <span
                        key={index}
                        id={`word-${index}`}
                        className={`transcript-word ${isRead ? 'read' : ''}`}
                        style={{ color: isRead ? '#60a5fa' : undefined, cursor: 'pointer' }}
                        onClick={() => onTranscriptWordClick(index)}
                      >
                        {word}{' '}
                      </span>
                    );
                  })}
                </p>
              ) : (
                <p className="no-content">No transcript available</p>
              )}
            </div>
          );
        }

        // Article/text: if LLM alignment exists, use the rich read-along view
        if (isLLMAlignment) {
          // Show generating/transcribing status above the content if applicable
          const statusMsg = isGenerating ? 'Audio is being generated...'
            : isTranscribing ? 'Transcribing...'
            : isAligning ? 'Aligning content with audio...'
            : null;
          return (
            <div className="tab-read-along-display">
              {statusMsg && <p className="no-content" style={{ marginBottom: '1rem' }}>{statusMsg}</p>}
              {renderLLMReadAlong()}
            </div>
          );
        }

        // Article/text WITHOUT alignment: show raw content + comments (no timestamps)
        // This ensures articles are readable even before audio is generated.
        return (
          <div className="tab-read-along-display">
            {isGenerating && (
              <p className="no-content" style={{ marginBottom: '1rem' }}>Audio is being generated... Read-along highlighting will appear once complete.</p>
            )}
            {isTranscribing && (
              <p className="no-content" style={{ marginBottom: '1rem' }}>Transcribing... Read-along highlighting will appear once complete.</p>
            )}
            {isAligning && (
              <p className="no-content" style={{ marginBottom: '1rem' }}>Aligning content with audio... Almost done.</p>
            )}
            <div className="tab-content-display">
              <div className="content-header-with-button">
                <div className="content-header">
                  <h2>{content.title}</h2>
                  {content.author && (
                    <p className="content-author">
                      By {content.author}
                      {content.published_at && (
                        <> {new Date(content.published_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</>
                      )}
                      {isEAForumOrLessWrong(content.url || '') && content.karma !== undefined && content.karma !== null && (
                        <> {content.karma} karma</>
                      )}
                    </p>
                  )}
                  {content.type === 'article' && content.content_source && (
                    <p className="content-provenance" style={{ fontSize: '0.75rem', color: '#9ca3af', marginTop: '0.25rem' }}>
                      Fetched by {content.content_source} on {(content.content_fetched_at || content.updated_at) ? new Date(content.content_fetched_at || content.updated_at!).toLocaleDateString('en-GB') : 'unknown date'}
                      {content.audio_generated_at && content.audio_url && (
                        <> &bull; Narration generated on {new Date(content.audio_generated_at).toLocaleDateString('en-GB')}</>
                      )}
                    </p>
                  )}
                </div>
                {content.type === 'article' && content.url && onRefetch && (
                  <button className="refetch-button" title="Refetch content and comments from web" onClick={onRefetch}>
                    <RefreshCw size={16} />
                    <span className="refetch-text-full">Refetch from web</span>
                    <span className="refetch-text-short">Refetch</span>
                  </button>
                )}
              </div>
              <div
                className="article-content"
                dangerouslySetInnerHTML={{ __html: content.html_content || content.content || '<p>No content available</p>' }}
              />
              {/* Show comments if available */}
              {parsedComments.length > 0 && (
                <div className="tab-comments-display" style={{ marginTop: '2rem' }}>
                  <div className="read-along-comments-divider" />
                  <div className="comments-header">
                    <h3>Comments ({totalCommentCount})</h3>
                  </div>
                  <div className="comments-list">
                    {parsedComments.map((comment, index) => (
                      <CommentComponent key={index} comment={comment} depth={0} />
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        );
      }
      case 'queue':
        return (
          <div className="tab-queue-display">
            <h3>Queue</h3>
            <p className="work-in-progress">Work in progress</p>
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
            {content.type === 'article' && content.url && (
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
                {content.published_at && (
                  <> &bull; {new Date(content.published_at).toLocaleDateString('en-GB')}</>
                )}
                {(content.karma !== undefined && content.karma !== null) && (
                  <> &bull; {content.karma} upvotes</>
                )}
                {totalCommentCount > 0 && (
                  <> &bull; {totalCommentCount} comment{totalCommentCount !== 1 ? 's' : ''}</>
                )}
              </p>
            )}
            {content.type === 'podcast_episode' && content.podcast_show_name && (
              <p className="fullscreen-author">
                {content.podcast_show_name}
                {content.published_at && (
                  <> &bull; {new Date(content.published_at).toLocaleDateString('en-GB')}</>
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

      {/* Tabs with autoscroll toggle */}
      <div className="fullscreen-tabs">
        {availableTabs.map((tab) => (
          <button
            key={tab}
            className={`tab-button ${activeTab === tab ? 'active' : ''}`}
            onClick={() => handleTabClick(tab)}
          >
            {tab === 'content' && 'Original Content'}
            {tab === 'description' && 'Description'}
            {tab === 'comments' && `Comments${totalCommentCount > 0 ? ` (${totalCommentCount})` : ''}`}
            {tab === 'read-along' && 'Content'}
            {tab === 'queue' && 'Queue'}
          </button>
        ))}
        {activeTab === 'read-along' && (
          <button
            className={`autoscroll-toggle ${autoScroll ? 'active' : ''}`}
            onClick={() => setAutoScroll(!autoScroll)}
            title={autoScroll ? 'Disable auto-scroll' : 'Enable auto-scroll'}
          >
            <ArrowDownToLine size={14} />
            Auto-scroll
          </button>
        )}
      </div>

      {/* Tab Content Area */}
      <div className="fullscreen-tab-content">
        {renderTabContent()}
      </div>

      {/* Player Controls */}
      <div className="fullscreen-player-controls">
        <div className="fullscreen-progress-bar">
          <span className="time">{formatTime(currentTime)}</span>
          <div style={{ position: 'relative', flex: 1, display: 'flex' }}>
            <input
              type="range"
              min="0"
              max={duration || 0}
              value={currentTime}
              onChange={(e) => onSeek(parseFloat(e.target.value))}
              className="progress-slider"
            />
            {commentsMarkerPosition !== null && (
              <div
                style={{
                  position: 'absolute',
                  left: `${commentsMarkerPosition}%`,
                  top: '50%',
                  transform: 'translate(-50%, -50%)',
                  width: '3px',
                  height: '14px',
                  backgroundColor: '#f97316',
                  borderRadius: '1px',
                  pointerEvents: 'none',
                  zIndex: 10,
                }}
                title="Comments section starts here"
              />
            )}
          </div>
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

          <button onClick={onSkipForward} title="Seek forward 15 seconds" className="seek-btn">
            <RotateCw className="seek-icon" />
            <span className="seek-label">15</span>
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
