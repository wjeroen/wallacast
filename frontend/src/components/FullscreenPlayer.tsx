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
  const [activeTab, setActiveTab] = useState<TabType>('content');
  const [autoScroll, setAutoScroll] = useState(() => {
    return localStorage.getItem('readAlongAutoScroll') !== 'false';
  });

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
  const extractedSections = useMemo(() => {
    // Only compute for old-style alignment
    if (isLLMAlignment || !parsedAlignment || !content.html_content) return [];

    let augmentedHtml = '';
    if (content.title) augmentedHtml += `<p>Title: ${content.title}.</p>\n`;
    if (content.author) {
      const cleanAuthor = content.author.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '').trim();
      augmentedHtml += `<p>Written by ${cleanAuthor}.</p>\n`;
    }
    if (content.published_at) {
      const date = new Date(content.published_at);
      const formatted = date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
      augmentedHtml += `<p>Published on ${formatted}.</p>\n`;
    }
    const isEAForumOrLW = content.url && (content.url.includes('forum.effectivealtruism.org') || content.url.includes('lesswrong.com'));
    if (isEAForumOrLW && content.karma !== undefined && content.karma !== null) {
      augmentedHtml += `<p>It has ${content.karma} karma.</p>\n`;
    }
    augmentedHtml += content.html_content;

    if (content.comments) {
      try {
        const comments = typeof content.comments === 'string' ? JSON.parse(content.comments) : content.comments;
        if (comments && Array.isArray(comments) && comments.length > 0) {
          augmentedHtml += `\n<h2>Comments section:</h2>\n`;
          function commentsToHTML(commentsList: any[], depth: number = 0): string {
            let html = '';
            for (const comment of commentsList) {
              const indent = depth > 0 ? `<p style="margin-left: ${depth * 20}px">` : '<p>';
              html += `${indent}<strong>${comment.username || 'Anonymous'}</strong>: ${comment.content || ''}</p>\n`;
              if (comment.replies && comment.replies.length > 0) html += commentsToHTML(comment.replies, depth + 1);
            }
            return html;
          }
          augmentedHtml += commentsToHTML(comments);
        }
      } catch (e) { /* ignore */ }
    }

    const parser = new DOMParser();
    const doc = parser.parseFromString(augmentedHtml, 'text/html');
    const sections: string[] = [];
    const elements = doc.querySelectorAll('h1, h2, h3, h4, h5, h6, p, li, img');
    elements.forEach((el) => {
      if (el.tagName === 'IMG') el.setAttribute('style', 'max-width: 100%; height: auto;');
      sections.push(el.outerHTML);
    });
    return sections;
  }, [isLLMAlignment, parsedAlignment, content.html_content, content.title, content.author, content.published_at, content.karma, content.comments]);

  // Determine which tabs are available
  const availableTabs = useMemo(() => {
    const tabs: TabType[] = [];
    if (content.type === 'article' || content.type === 'text') tabs.push('content');
    if (content.type === 'podcast_episode') tabs.push('description');
    if (content.type === 'article' && isEAForumOrLessWrong(content.url || '')) tabs.push('comments');
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

  // Scroll active element to center
  const scrollToActive = useCallback(() => {
    if (isLLMAlignment && activeElementIndex >= 0) {
      const element = document.getElementById(`ra-el-${activeElementIndex}`);
      if (element) {
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    } else if (parsedAlignment && !isLLMAlignment && extractedSections.length > 0) {
      // Legacy alignment
      const alignmentSections = parsedAlignment.sections;
      let activeSectionIndex = -1;
      for (let i = 0; i < alignmentSections.length; i++) {
        if (currentTime >= alignmentSections[i].startTime && currentTime < alignmentSections[i].endTime) {
          activeSectionIndex = i;
          break;
        }
      }
      if (activeSectionIndex >= 0) {
        const element = document.getElementById(`section-${activeSectionIndex}`);
        if (element) element.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    } else if (activeWordIndex >= 0) {
      const element = document.getElementById(`word-${activeWordIndex}`);
      if (element) element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [activeWordIndex, activeElementIndex, isLLMAlignment, parsedAlignment, extractedSections, currentTime]);

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
              Fetched by {content.content_source} on {content.updated_at ? new Date(content.updated_at).toLocaleDateString('en-GB') : 'unknown date'}
            </p>
          )}
        </div>

        {/* Article body (same .article-content CSS as content tab) */}
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

  // Legacy aligned read-along (Needleman-Wunsch, for old data)
  const renderLegacyAlignedReadAlong = () => {
    if (!parsedAlignment || !parsedAlignment.sections || extractedSections.length === 0) return null;
    const alignmentSections = parsedAlignment.sections;

    let activeSectionIndex = -1;
    for (let i = 0; i < alignmentSections.length; i++) {
      if (currentTime >= alignmentSections[i].startTime && currentTime < alignmentSections[i].endTime) {
        activeSectionIndex = i;
        break;
      }
    }

    return (
      <div className="aligned-read-along">
        {alignmentSections.map((alignSection: any, index: number) => {
          const isActive = index === activeSectionIndex;
          const htmlContent = extractedSections[index] || `<p>${alignSection.text}</p>`;
          return (
            <div
              key={index}
              id={`section-${index}`}
              className={`read-along-section ${isActive ? 'active' : ''}`}
              style={{
                backgroundColor: isActive ? 'rgba(96, 165, 250, 0.1)' : 'transparent',
                borderLeft: isActive ? '3px solid #60a5fa' : '3px solid transparent',
                paddingLeft: '1rem',
                marginBottom: '1rem',
                transition: 'all 0.3s ease',
                cursor: 'pointer',
              }}
              onClick={() => onSeek(alignSection.startTime)}
            >
              <div dangerouslySetInnerHTML={{ __html: htmlContent }} style={{ color: isActive ? '#60a5fa' : undefined }} />
            </div>
          );
        })}
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
                    Fetched by {content.content_source} on {content.updated_at ? new Date(content.updated_at).toLocaleDateString('en-GB') : 'unknown date'}
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
              <h3>Comments ({parsedComments.length})</h3>
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

        let readAlongMessage: string | null = null;
        if (!hasAudio && isGenerating) {
          readAlongMessage = 'Audio is being generated... The read-along will appear once audio generation and transcription are complete.';
        } else if (!hasAudio) {
          readAlongMessage = 'No audio has been generated yet. Generate audio first to use the read-along feature.';
        } else if (isTranscribing) {
          readAlongMessage = 'Transcript is being generated... This may take a minute.';
        } else if (isAligning) {
          readAlongMessage = 'Aligning content with audio... Almost done.';
        } else if (!hasTranscript) {
          readAlongMessage = 'No transcript available yet. The transcript is generated automatically after audio creation.';
        }

        return (
          <div className="tab-read-along-display">
            {readAlongMessage ? (
              <p className="no-content">{readAlongMessage}</p>
            ) : isLLMAlignment ? (
              renderLLMReadAlong()
            ) : parsedAlignment && extractedSections.length > 0 ? (
              renderLegacyAlignedReadAlong()
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
            {tab === 'content' && 'Content'}
            {tab === 'description' && 'Description'}
            {tab === 'comments' && `Comments${parsedComments.length > 0 ? ` (${parsedComments.length})` : ''}`}
            {tab === 'read-along' && 'Read-along'}
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
            <span className="autoscroll-label">Auto-scroll</span>
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
