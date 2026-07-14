import { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import {
  Play,
  Pause,
  RotateCcw,
  RotateCw,
  Gauge,
  Clock,
  Type,
  Sun,
  Moon,
  SunMoon,
  X,
  Minimize2,
  SquareArrowOutUpRight,
  RefreshCw,
  ArrowDownToLine,
  MoreVertical,
  ArrowUp,
  MessageCircle,
  Star,
  Archive,
  ArchiveRestore,
  Trash2,
  SkipBack,
  SkipForward,
  Repeat,
  Shuffle,
  ChevronUp,
  ChevronDown,
  Pencil,
  Eye,
  AlignLeft,
  Info,
  Captions,
  MessageSquareText,
  MessageSquareOff,
  Volume2,
  VolumeOff,
  Copy,
  FolderDown,
  History,
  ListMusic,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { contentAPI, userSettingsAPI } from '../api';
import { htmlToMarkdown, markdownToHtml, contentToMarkdown } from '../markdown';
import { safeHtml, safeArticleHtml } from '../sanitize';
import { cleanHtml, displayUrl, formatTime, getDomainFromUrl } from '../format';
import { useContentStore } from '../store/contentStore';
import { useQueueStore } from '../store/queueStore';
import type { ContentItem, ContentVersion, Comment } from '../types';

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
  onGenerateAudio?: (regenerate: boolean) => void;
  onRemoveAudio?: () => void;
  onGenerateSummary?: (regenerate: boolean) => void;
  onRemoveSummary?: () => void;
  onRegenerateTranscript?: () => void;
  onContentUpdated?: (updated: ContentItem) => void;
  themeMode: 'dark' | 'light' | 'system';
  onCycleTheme: () => void;
  // Queue integration
  onSkipNextTrack?: () => void;
  onSkipPrevTrack?: () => void;
  hasNextTrack?: boolean;
  hasPrevTrack?: boolean;
  onPlayQueueItem?: (item: ContentItem) => void;
  initialTab?: string;
}

type TabType = 'content' | 'description' | 'comments' | 'read-along' | 'summary' | 'history' | 'queue';

// Tab bar labels and icons. Tab labels stay visible at every width, only the
// autoscroll toggle's text collapses on narrow screens (its .tab-label span).
// The 'read-along' tab id is historical: the user-facing name is "Transcript"
// for every content type (articles read along their aligned TTS transcript,
// podcasts their Whisper transcript, same data family, one name).
const TAB_LABELS: Record<TabType, string> = {
  'content': 'Content',
  'description': 'Description',
  'comments': 'Comments',
  'read-along': 'Transcript',
  'summary': 'Summary',
  'history': 'History',
  'queue': 'Queue',
};

const TAB_ICONS: Record<TabType, LucideIcon> = {
  'content': AlignLeft,
  'description': Info,
  'comments': MessageCircle,
  'read-along': Captions,
  'summary': MessageSquareText,
  'history': History,
  'queue': ListMusic,
};

// Human-readable label for a version snapshot's source (the action that overwrote it).
function versionSourceLabel(source: ContentVersion['source']): string {
  switch (source) {
    case 'edit': return 'Before edit';
    case 'refetch': return 'Before refetch';
    case 'restore': return 'Before restore';
    case 'fetch': return 'Original fetch';
    case 'sync': return 'Before Wallabag sync';
    default: return source;
  }
}

const FONT_SCALES = [0.75, 0.875, 1, 1.125, 1.25, 1.5, 1.75];

function getStoredFontScale(): number {
  const stored = localStorage.getItem('readerFontScale');
  if (stored) {
    const parsed = parseFloat(stored);
    if (FONT_SCALES.includes(parsed)) return parsed;
  }
  return 1;
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

/**
 * Build metadata string for a comment (e.g., "5 upvotes • 3 agreement" or "5 likes" for Substack)
 */
function buildCommentMetadata(
  meta: LLMAlignmentElement['commentMeta'],
  isLessWrong: boolean,
  isSubstack: boolean = false
): string {
  if (!meta) return '';
  const parts: string[] = [];

  if (meta.karma !== undefined && meta.karma !== null) {
    const label = isSubstack ? (meta.karma !== 1 ? 'likes' : 'like') : (meta.karma !== 1 ? 'upvotes' : 'upvote');
    parts.push(`${meta.karma} ${label}`);
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

  return parts.join(' \u2022 ');
}

// Recursively render a parsed comment with its replies. Hoisted to module scope so its
// function identity is stable. Previously it was defined INSIDE FullscreenPlayer's render,
// so its identity changed every render and React unmounted/remounted the whole comment tree
// on every timeupdate (~4x/sec during playback). Platform flags come in as props (derived
// from the URL by the parent) and it uses the shared buildCommentMetadata helper, so the
// "N basescore" leak from the old inline metadata is gone.
interface CommentComponentProps {
  comment: Comment;
  depth?: number;
  isLessWrong: boolean;
  isSubstack: boolean;
}
function CommentComponent({ comment, depth = 0, isLessWrong, isSubstack }: CommentComponentProps) {
  const metaStr = buildCommentMetadata(
    { username: comment.username, date: comment.date, karma: comment.karma, extendedScore: comment.extendedScore, depth },
    isLessWrong,
    isSubstack
  );
  // Sanitize third-party comment HTML before it reaches the DOM (see sanitize.ts).
  const safeContent = useMemo(() => safeHtml(comment.content), [comment.content]);

  return (
    // Odd depths get the alternate shade (comment-alt), LessWrong-style, at every depth.
    <div className={`comment${depth % 2 === 1 ? ' comment-alt' : ''}`}>
      <div className="comment-header">
        <span className="comment-username">{comment.username}</span>
        {comment.date && (
          <span className="comment-date">
            {' \u2022 '}
            {(() => { try { return new Date(comment.date).toLocaleDateString('en-GB'); } catch { return comment.date; } })()}
          </span>
        )}
      </div>
      {metaStr && (
        <div className="comment-metadata">
          <span className="comment-votes">{metaStr}</span>
        </div>
      )}
      <div className="comment-content" dangerouslySetInnerHTML={{ __html: safeContent }} />
      {comment.replies && comment.replies.length > 0 && (
        <div className="comment-replies">
          {comment.replies.map((reply, idx) => (
            <CommentComponent key={idx} comment={reply} depth={depth + 1} isLessWrong={isLessWrong} isSubstack={isSubstack} />
          ))}
        </div>
      )}
    </div>
  );
}

interface QueueRowProps {
  item: ContentItem;
  isCurrent: boolean;
  onPlay: () => void;
  onRemove?: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
}
function QueueRow({ item, isCurrent, onPlay, onRemove, onMoveUp, onMoveDown, canMoveUp, canMoveDown }: QueueRowProps) {
  // Two-tap remove: first tap arms the button with a visible warning state,
  // a second tap within the timeout actually removes. Guards against stray
  // mis-taps next to the move buttons.
  const [confirmRemove, setConfirmRemove] = useState(false);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    };
  }, []);

  const handleRemoveClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!onRemove) return;
    if (confirmRemove) {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
      setConfirmRemove(false);
      onRemove();
      return;
    }
    setConfirmRemove(true);
    confirmTimerRef.current = setTimeout(() => setConfirmRemove(false), 3000);
  };

  return (
    <div className={`queue-row ${isCurrent ? 'current' : ''}`}>
      <div className="queue-row-main" onClick={onPlay}>
        {item.preview_picture && (
          <img src={item.preview_picture} alt={item.title} className="queue-row-thumb" />
        )}
        <div className="queue-row-info">
          <div className="queue-row-title">
            {isCurrent && <span className="queue-now-playing">▶ </span>}
            {item.title}
          </div>
          <div className="queue-row-meta">
            {item.type === 'podcast_episode' && item.podcast_show_name
              ? item.podcast_show_name
              : (item.author || '')}
            {!item.audio_url && <span className="queue-row-noaudio"> • no audio</span>}
          </div>
        </div>
      </div>
      {onMoveUp && (
        <button
          className="queue-row-move"
          onClick={(e) => { e.stopPropagation(); if (canMoveUp) onMoveUp(); }}
          disabled={!canMoveUp}
          title="Move up"
        >
          <ChevronUp size={16} />
        </button>
      )}
      {onMoveDown && (
        <button
          className="queue-row-move"
          onClick={(e) => { e.stopPropagation(); if (canMoveDown) onMoveDown(); }}
          disabled={!canMoveDown}
          title="Move down"
        >
          <ChevronDown size={16} />
        </button>
      )}
      {onRemove && (
        <button
          className={`queue-row-remove ${confirmRemove ? 'confirm' : ''}`}
          onClick={handleRemoveClick}
          title={confirmRemove ? 'Tap again to confirm' : 'Remove from queue'}
        >
          {confirmRemove ? <span className="queue-row-remove-confirm">Remove?</span> : <X size={16} />}
        </button>
      )}
    </div>
  );
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
  onGenerateAudio,
  onRemoveAudio,
  onGenerateSummary,
  onRemoveSummary,
  onRegenerateTranscript,
  onContentUpdated,
  themeMode,
  onCycleTheme,
  onSkipNextTrack,
  onSkipPrevTrack,
  hasNextTrack = false,
  hasPrevTrack = false,
  onPlayQueueItem,
  initialTab,
}: FullscreenPlayerProps) {
  // Queue state for the Queue tab + autoplay toggle
  const manualItems = useQueueStore(s => s.manualItems);
  const libraryContext = useQueueStore(s => s.libraryContext);
  const autoplay = useQueueStore(s => s.autoplay);
  const shuffleNonManual = useQueueStore(s => s.shuffleNonManual);
  const setAutoplay = useQueueStore(s => s.setAutoplay);
  const setShuffleNonManual = useQueueStore(s => s.setShuffleNonManual);
  const removeFromQueue = useQueueStore(s => s.removeFromQueue);
  const moveUp = useQueueStore(s => s.moveUp);
  const moveDown = useQueueStore(s => s.moveDown);
  const clearQueue = useQueueStore(s => s.clearQueue);
  const getNonManualItems = useQueueStore(s => s.getNonManualItems);
  // Re-derive non-manual items when queue/context/shuffle changes OR current item changes
  const nonManualItems = useMemo(
    () => getNonManualItems(content.id),
    [getNonManualItems, content.id, manualItems, libraryContext, shuffleNonManual]
  );
  // Default tab: 'description' for podcasts, 'read-along' (now labeled "Content") for everything else
  const [activeTab, setActiveTab] = useState<TabType>(
    content.type === 'podcast_episode' ? 'description' : 'read-along'
  );
  // Per-tab scroll position memory: save when leaving a tab, restore when entering
  const tabScrollPositions = useRef<Record<string, number>>({});
  const tabContentRef = useRef<HTMLDivElement>(null);

  // When switching tracks, reset to the appropriate default tab.
  // Only the queue tab is preserved across advances; content tabs
  // reset to the default for the new content type (description for
  // podcasts, read-along for articles/texts).
  useEffect(() => {
    tabScrollPositions.current = {};
    setActiveTab(prev => {
      if (prev === 'queue') return prev;
      return content.type === 'podcast_episode' ? 'description' : 'read-along';
    });
  }, [content.id]);

  const [autoScroll, setAutoScroll] = useState(() => {
    return localStorage.getItem('readAlongAutoScroll') !== 'false';
  });
  // Dropdown menu state
  const [showDropdown, setShowDropdown] = useState(false);
  // Display panel state (font size)
  const [fontScale, setFontScale] = useState<number>(getStoredFontScale);
  const [showDisplayPanel, setShowDisplayPanel] = useState(false);
  const displayPanelRef = useRef<HTMLDivElement>(null);
  // Content store for star/archive/delete actions
  const { toggleStarred, toggleArchived, deleteItem, updateItem } = useContentStore();
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Markdown editor (Content tab) state
  const [editing, setEditing] = useState(false);
  const [draftMd, setDraftMd] = useState('');
  const [editTitle, setEditTitle] = useState('');
  const [editAuthor, setEditAuthor] = useState('');
  const [editDate, setEditDate] = useState('');
  const [showEditPreview, setShowEditPreview] = useState(false);
  const [savingEdit, setSavingEdit] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  // Version history (History tab) state
  const [versions, setVersions] = useState<ContentVersion[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [viewingVersion, setViewingVersion] = useState<ContentVersion | null>(null);

  // Reset editor + history view whenever the item changes
  useEffect(() => {
    setEditing(false);
    setShowEditPreview(false);
    setEditError(null);
    setViewingVersion(null);
    setVersions([]);
  }, [content.id]);

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!showDropdown) return;
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showDropdown]);

  // Close display panel when clicking outside
  useEffect(() => {
    if (!showDisplayPanel) return;
    function handleClick(e: MouseEvent) {
      if (displayPanelRef.current && !displayPanelRef.current.contains(e.target as Node)) {
        setShowDisplayPanel(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showDisplayPanel]);

  // Sync font scale from backend on mount (cross-device persistence)
  useEffect(() => {
    userSettingsAPI.get('reader_font_scale').then(res => {
      const val = res.data.value ? parseFloat(res.data.value) : null;
      if (val && FONT_SCALES.includes(val)) {
        localStorage.setItem('readerFontScale', String(val));
        setFontScale(val);
      }
    }).catch(() => {});
  }, []);

  // Persist autoscroll preference
  useEffect(() => {
    localStorage.setItem('readAlongAutoScroll', String(autoScroll));
  }, [autoScroll]);

  // Hide broken images (e.g. from uploaded HTML files with relative paths to local files)
  useEffect(() => {
    const container = document.querySelector('.fullscreen-player');
    if (!container) return;
    const imgs = container.querySelectorAll('.article-content img');
    imgs.forEach(img => {
      (img as HTMLImageElement).onerror = () => {
        (img as HTMLElement).style.display = 'none';
      };
    });
  }, [content.id, content.html_content, activeTab]);

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

  // ---- Sanitize every HTML string that reaches dangerouslySetInnerHTML (XSS defense) ----
  // Article and comment HTML comes from the open web (fetched articles, forum/Substack
  // comments), so it must be cleaned before rendering. Without this, one poisoned comment
  // could run script in our origin and steal the JWT from localStorage. Memoized so DOMPurify
  // runs once per content change, not on every ~4x/sec read-along re-render during playback.
  const safeArticleBodyHtml = useMemo(
    () => safeArticleHtml(content.html_content || content.content || '<p>No content available</p>'),
    [content.html_content, content.content]
  );
  const safeDescriptionHtml = useMemo(() => safeHtml(content.description), [content.description]);
  const safeDraftPreview = useMemo(
    () => safeHtml(markdownToHtml(draftMd) || '<p>Nothing to preview</p>'),
    [draftMd]
  );
  const safeVersionHtml = useMemo(
    () => (viewingVersion ? safeArticleHtml(viewingVersion.html_content || viewingVersion.content || '<p>Empty</p>') : ''),
    [viewingVersion]
  );
  // Read-along elements: sanitize each once (comments strict, body keeps <style> for math),
  // keyed by element identity so the render sink is a cheap map lookup during playback.
  const sanitizedElementHtml = useMemo(() => {
    const map = new Map<LLMAlignmentElement, string>();
    const els = (parsedAlignment?.elements || []) as LLMAlignmentElement[];
    for (const el of els) {
      if (typeof el.html !== 'string') continue;
      map.set(el, el.type === 'comment' ? safeHtml(el.html) : safeArticleHtml(el.html));
    }
    return map;
  }, [parsedAlignment]);

  // Check if this is the new LLM-based alignment
  const isLLMAlignment = parsedAlignment?.version === 'llm-v1';

  // Show content version toggle when alignment data exists (articles and texts)
  const hasAlignment = !!parsedAlignment && isLLMAlignment;

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
      if (elements[i].startTime < 0) continue; // skip unnarrated elements (startTime: -1)
      if (elements[i].startTime <= currentTime) {
        activeIdx = i;
      } else {
        break;
      }
    }
    return activeIdx;
  }, [isLLMAlignment, parsedAlignment, currentTime]);

  // Determine which tabs are available.
  // Articles/texts get an editable "Content" tab (current text) plus a read-only
  // "Read-along" tab (synced to the audio version) once audio/alignment exists, so the
  // editable live text and the frozen synced view are cleanly separated. The Read-along
  // tab is the default when it exists; otherwise Content is the default.
  const availableTabs = useMemo(() => {
    const tabs: TabType[] = [];
    const isArticleOrText = content.type === 'article' || content.type === 'text';
    const isGeneratingNow = !!content.generation_status && !['idle', 'completed', 'failed'].includes(content.generation_status);
    const hasReadAlongData = !!content.audio_url || hasAlignment || isGeneratingNow;

    // Tab order: Description (podcasts) · Read-along · Content · History · Summary · Queue
    if (content.type === 'podcast_episode') {
      tabs.push('description');
      tabs.push('read-along');
    } else if (isArticleOrText) {
      if (hasReadAlongData) tabs.push('read-along');
      tabs.push('content');
      // History only for editable items that actually have at least one prior snapshot.
      // versions_count (from GET /:id) makes the tab appear instantly on open, the
      // separately-fetched versions list keeps it visible after edits create snapshots.
      if (versions.length > 0 || (content.versions_count ?? 0) > 0) tabs.push('history');
    } else {
      tabs.push('read-along');
    }

    if ((content.summary || '').trim()) tabs.push('summary');
    tabs.push('queue');
    return tabs;
  }, [content.type, content.audio_url, content.generation_status, content.summary, hasAlignment, versions.length, content.versions_count]);

  // Auto-select first available tab if current one disappeared
  useEffect(() => {
    if (availableTabs.length > 0 && !availableTabs.includes(activeTab)) {
      setActiveTab(availableTabs[0]);
    }
  }, [availableTabs, activeTab]);

  // Honor a requested initial tab (e.g. "Read more" in the library → Summary tab).
  // Runs after the auto-select effect so it wins when both fire on a new item.
  useEffect(() => {
    if (initialTab === 'summary' && (content.summary || '').trim()) {
      setActiveTab('summary');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content.id, initialTab]);

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
      return;
    }
    // Save current tab's scroll position before switching
    if (tabContentRef.current) {
      tabScrollPositions.current[activeTab] = tabContentRef.current.scrollTop;
    }
    setActiveTab(tab);
    // Restore saved scroll position for the target tab (0 if never visited)
    requestAnimationFrame(() => {
      if (tabContentRef.current) {
        tabContentRef.current.scrollTop = tabScrollPositions.current[tab] || 0;
      }
    });
  };

  const handleFontScaleChange = (newScale: number) => {
    setFontScale(newScale);
    localStorage.setItem('readerFontScale', String(newScale));
    userSettingsAPI.set('reader_font_scale', String(newScale)).catch(() => {});
  };

  // Platform detection for comment metadata labels (upvotes vs likes, agreement handling).
  // Prefer the authoritative comment_source column (GET /:id, migration 017). Older items
  // fetched before that column existed have it null/undefined, so fall back to URL detection.
  // Passed into the module-scope CommentComponent so it can stay render-stable.
  const isLessWrongUrl = content.comment_source === 'lesswrong'
    || (!content.comment_source && !!content.url && content.url.includes('lesswrong.com'));
  const isSubstackUrl = content.comment_source === 'substack'
    || (!content.comment_source && !!content.url && content.url.includes('substack.com'));

  // --------------------------------------------------------------------------
  // Download data as zip (backend generates zip, frontend triggers download)
  // --------------------------------------------------------------------------
  const safeName = (content.title || 'content').replace(/[^a-zA-Z0-9-_ ]/g, '');

  // ---- Markdown editor (Content tab) ----
  const startEdit = () => {
    setEditError(null);
    setDraftMd(htmlToMarkdown(content.html_content || content.content || ''));
    setEditTitle(content.title || '');
    setEditAuthor(content.author || '');
    setEditDate(content.published_at ? content.published_at.slice(0, 10) : '');
    setShowEditPreview(false);
    setEditing(true);
  };

  const cancelEdit = () => {
    setEditing(false);
    setShowEditPreview(false);
    setEditError(null);
  };

  const saveEdit = async () => {
    setSavingEdit(true);
    setEditError(null);
    try {
      const html = markdownToHtml(draftMd);
      const plain = (new DOMParser().parseFromString(html, 'text/html').body.textContent || '').trim();
      // Only send metadata fields that actually changed, so an untouched date
      // keeps its original stored timestamp instead of being rewritten.
      const meta: { title?: string; author?: string | null; published_at?: string | null } = {};
      const newTitle = editTitle.trim();
      if (newTitle && newTitle !== content.title) meta.title = newTitle;
      if (editAuthor.trim() !== (content.author || '')) meta.author = editAuthor.trim() || null;
      const origDate = content.published_at ? content.published_at.slice(0, 10) : '';
      if (editDate !== origDate) meta.published_at = editDate || null;
      await contentAPI.saveEdit(content.id, html, plain, meta);
      // The PATCH response omits html_content; fetch the full fresh item to update the view + store.
      const fresh = await contentAPI.getById(content.id);
      onContentUpdated?.(fresh.data);
      updateItem(content.id, fresh.data);
      setEditing(false);
      setShowEditPreview(false);
    } catch (e) {
      console.error('Failed to save edit:', e);
      setEditError('Failed to save. Please try again.');
    } finally {
      setSavingEdit(false);
    }
  };

  // ---- Version history (History tab) ----
  const loadVersions = useCallback(async () => {
    setVersionsLoading(true);
    try {
      const res = await contentAPI.listVersions(content.id);
      setVersions(res.data);
    } catch (e) {
      console.error('Failed to load versions:', e);
    } finally {
      setVersionsLoading(false);
    }
  }, [content.id]);

  // Load the (lean) version list when an editable item opens, so we know whether to even
  // show the History tab (only items with at least one prior snapshot get it).
  useEffect(() => {
    if (content.type === 'article' || content.type === 'text') loadVersions();
    else setVersions([]);
  }, [loadVersions, content.type]);

  const viewVersion = async (versionId: number) => {
    try {
      const res = await contentAPI.getVersion(content.id, versionId);
      setViewingVersion(res.data);
    } catch (e) {
      console.error('Failed to load version:', e);
    }
  };

  const restoreVersion = async (versionId: number) => {
    if (!confirm('Restore this version? Your current text is saved to history first, so you can undo this. Audio/read-along are not regenerated.')) return;
    try {
      await contentAPI.restoreVersion(content.id, versionId);
      const fresh = await contentAPI.getById(content.id);
      onContentUpdated?.(fresh.data);
      updateItem(content.id, fresh.data);
      setViewingVersion(null);
      loadVersions();
      setActiveTab('content');
    } catch (e) {
      console.error('Failed to restore version:', e);
      alert('Failed to restore version.');
    }
  };

  // Footnote / in-page anchor navigation for the Content tab. Intercepts clicks on `#...`
  // links (footnote markers and their back-links) and smoothly scrolls the target into view
  // inside the player's scroll container, without changing the URL (which would upset the
  // router). Works on native LessWrong/EA/Substack anchors AND our canonical `fn-N` ones.
  const handleAnchorNav = useCallback((e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest('a');
    if (!a) return;
    const href = a.getAttribute('href') || '';
    if (!href.startsWith('#') || href.length < 2) return;
    e.preventDefault();
    const id = decodeURIComponent(href.slice(1));
    const root = tabContentRef.current;
    if (!root) return;
    let target: Element | null = null;
    try {
      target = root.querySelector(`#${CSS.escape(id)}`);
    } catch {
      target = root.querySelector(`[id="${id.replace(/"/g, '\\"')}"]`);
    }
    target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, []);

  // Copy the readable content (title, link, author, date, body, comments) to
  // the clipboard as Markdown, via the shared contentToMarkdown export.
  const handleCopyContent = async () => {
    setShowDropdown(false);
    try {
      await navigator.clipboard.writeText(contentToMarkdown(content, parsedComments));
    } catch (error) {
      console.error('Failed to copy content:', error);
      alert('Failed to copy to clipboard');
    }
  };

  const handleDownloadDataZip = async () => {
    setShowDropdown(false);
    try {
      const response = await contentAPI.exportZip(content.id);
      const blob = new Blob([response.data], { type: 'application/zip' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${safeName}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Failed to export data:', error);
      alert('Failed to download data');
    }
  };

  // Two short provenance lines, identical wording in the Content and Transcript
  // tabs: "Fetched by wallacast/wallabag on [date]" (texts: "Last edited on
  // [date]") and "Audio generated on [date]".
  const renderProvenance = () => (
    <div className="content-provenance" style={{ color: '#9ca3af', marginTop: '0.25rem', lineHeight: '1.6' }}>
      <div>
        {content.type === 'article'
          ? `Fetched by ${content.content_source || 'wallacast'} on ${(content.content_fetched_at || content.updated_at) ? new Date(content.content_fetched_at || content.updated_at!).toLocaleDateString('en-GB') : 'unknown date'}`
          : `Last edited on ${(content.content_fetched_at || content.updated_at || content.created_at) ? new Date(content.content_fetched_at || content.updated_at || content.created_at!).toLocaleDateString('en-GB') : 'unknown date'}`}
      </div>
      {content.audio_generated_at && content.audio_url && (
        <div>Audio generated on {new Date(content.audio_generated_at).toLocaleDateString('en-GB')}</div>
      )}
    </div>
  );

  // Title/author/date/karma block, mirroring exactly what the TTS intro speaks
  // (comments are announced later in the narration, so no comment count here).
  // Sits BELOW the provenance lines + action buttons so it never gets squished.
  const renderTitleBlock = () => {
    const parts: string[] = [];
    if (content.author) parts.push(`By ${content.author}`);
    if (content.published_at) {
      const d = new Date(content.published_at);
      if (!isNaN(d.getTime())) {
        parts.push(d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }));
      }
    }
    if (content.karma !== undefined && content.karma !== null) {
      const isSub = content.url ? content.url.includes('substack.com') : false;
      const label = isSub ? (content.karma === 1 ? 'like' : 'likes') : (content.karma === 1 ? 'upvote' : 'upvotes');
      parts.push(`${content.karma} ${label}`);
    }
    return (
      <div className="content-header content-title-block">
        <h2>{content.title}</h2>
        {parts.length > 0 && <p className="content-author">{parts.join(' • ')}</p>}
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
    const isSub = content.url ? content.url.includes('substack.com') : false;

    // Split elements into categories. Title and author/date meta render as timed
    // elements in the header below (the TTS speaks them, so they highlight too).
    const titleEl = elements.find(e => e.type === 'title');
    const metaElements = elements.filter(e => e.type === 'meta');
    const bodyElements = elements.filter(e =>
      ['heading', 'paragraph', 'image', 'blockquote', 'list', 'code-block', 'llm-block'].includes(e.type)
    );
    const commentDivider = elements.find(e => e.type === 'comment-divider');
    const commentElements = elements.filter(e => e.type === 'comment');

    return (
      <div className="tab-content-display">
        <div className="content-header" style={{ marginBottom: '1rem' }}>
          {/* Provenance first, then the timed title/meta below it (same order as the content tab) */}
          {(content.type === 'article' || content.type === 'text') && renderProvenance()}

          {/* Timed title/meta live inside .content-title-block so they follow the
              reader text-size control like the article body does */}
          {(titleEl || metaElements.length > 0) && (
            <div className="content-title-block">
              {/* Title - timestamped, highlights while the TTS speaks it */}
              {titleEl && (
                <div
                  id={`ra-el-${elements.indexOf(titleEl)}`}
                  className={`read-along-element ${elements.indexOf(titleEl) === activeElementIndex ? 'ra-active' : ''}`}
                  onClick={() => onSeek(titleEl.startTime)}
                >
                  <h2 style={{ margin: '0.75rem 0 0.5rem 0' }}>{content.title}</h2>
                </div>
              )}

              {/* Author/date/karma meta - timestamped. Newly generated alignments
                  bake the whole byline into ONE element (single line, matching the
                  content tab); older alignments have separate author/date and karma
                  elements and simply show them as separate lines. */}
              {metaElements.map((el, i) => (
                <div
                  key={`meta-${i}`}
                  id={`ra-el-${elements.indexOf(el)}`}
                  className={`read-along-element ${elements.indexOf(el) === activeElementIndex ? 'ra-active' : ''}`}
                  onClick={() => onSeek(el.startTime)}
                >
                  <div dangerouslySetInnerHTML={{ __html: sanitizedElementHtml.get(el) ?? '' }} />
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Article body (same .article-content CSS as content tab), synced to the audio alignment */}
        <div className="article-content">
          {bodyElements.map((el, i) => {
            const globalIndex = elements.indexOf(el);
            const isActive = globalIndex === activeElementIndex;
            return (
              <div
                key={`body-${i}`}
                id={`ra-el-${globalIndex}`}
                className={`read-along-element ${isActive ? 'ra-active' : ''}`}
                onClick={(e) => {
                  // Read-along taps seek, with two exceptions so links stay usable:
                  //  - a real hyperlink/footnote (an <a> with no image inside): let it open,
                  //    don't seek.
                  //  - a click-to-enlarge image (an <img>, or an <a> wrapping one): seek only,
                  //    don't open the picture.
                  // Everything else (the plain text of the highlight) seeks.
                  const target = e.target as HTMLElement;
                  const anchor = target.closest('a');
                  const isImage = target.tagName === 'IMG' || (!!anchor && !!anchor.querySelector('img'));
                  if (anchor && !isImage) return; // real link: open it, don't seek
                  if (isImage) e.preventDefault(); // image link: seek, don't open the image
                  onSeek(el.startTime);
                }}
              >
                <div dangerouslySetInnerHTML={{ __html: sanitizedElementHtml.get(el) ?? '' }} />
              </div>
            );
          })}
        </div>

        {/* Comments section: timestamped commentElements from the alignment */}
        {commentElements.length > 0 && (
          <div className="tab-comments-display" style={{ marginTop: '2rem' }}>
            <div className="read-along-comments-divider" />
            {(() => {
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

                const renderCommentNode = (node: CommentNode, nodeDepth: number = 0): React.ReactNode => {
                  const { element: el, globalIndex, children } = node;
                  const isNarrated = el.startTime >= 0;
                  const isActive = isNarrated && globalIndex === activeElementIndex;
                  const meta = el.commentMeta;
                  const metaStr = buildCommentMetadata(meta, isLW, isSub);
                  return (
                    // Odd depths get the alternate shade, same rule as the Comments tab.
                    <div className={`comment${nodeDepth % 2 === 1 ? ' comment-alt' : ''}`} key={`comment-${globalIndex}`}>
                      <div
                        id={`ra-el-${globalIndex}`}
                        className={`read-along-element ${isActive ? 'ra-active' : ''}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          // Same rule as the body: a real link opens (no seek), an image link
                          // seeks (no open), everything else seeks.
                          const target = e.target as HTMLElement;
                          const anchor = target.closest('a');
                          const isImage = target.tagName === 'IMG' || (!!anchor && !!anchor.querySelector('img'));
                          if (anchor && !isImage) return;
                          if (isImage) e.preventDefault();
                          if (isNarrated) onSeek(el.startTime);
                        }}
                      >
                        <div className="comment-header">
                          <span className="comment-username">{meta?.username || 'Anonymous'}</span>
                          {meta?.date && (
                            <span className="comment-date">
                              {' \u2022 '}
                              {(() => { try { return new Date(meta.date).toLocaleDateString('en-GB'); } catch { return meta.date; } })()}
                            </span>
                          )}
                        </div>
                        {metaStr && (
                          <div className="comment-metadata">
                            <span className="comment-votes">{metaStr}</span>
                          </div>
                        )}
                        <div className="comment-content" dangerouslySetInnerHTML={{ __html: sanitizedElementHtml.get(el) ?? '' }} />
                      </div>
                      {children.length > 0 && (
                        <div className="comment-replies">
                          {children.map(child => renderCommentNode(child, nodeDepth + 1))}
                        </div>
                      )}
                    </div>
                  );
                };

                return (
                  <>
                    {commentDivider && (
                      <div
                        id={`ra-el-${elements.indexOf(commentDivider)}`}
                        className={`comments-header read-along-element ${commentDivider.startTime >= 0 && elements.indexOf(commentDivider) === activeElementIndex ? 'ra-active' : ''}`}
                        onClick={() => { if (commentDivider.startTime >= 0) onSeek(commentDivider.startTime); }}
                      >
                        <h3>Comments ({commentElements.length})</h3>
                      </div>
                    )}
                    <div className="comments-list">
                      {roots.map(node => renderCommentNode(node))}
                    </div>
                  </>
                );
              })()}
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
                {renderProvenance()}
              </div>
              {!editing && (content.type === 'article' || content.type === 'text') && (
                <div className="content-header-actions">
                  <button className="refetch-button" title="Edit as Markdown" onClick={startEdit}>
                    <Pencil size={16} />
                    <span className="refetch-text-full">Edit</span>
                    <span className="refetch-text-short">Edit</span>
                  </button>
                  {content.type === 'article' && content.url && onRefetch && (
                    <button className="refetch-button" title="Refetch content and comments from web" onClick={onRefetch}>
                      <RefreshCw size={16} />
                      <span className="refetch-text-full">Refetch from web</span>
                      <span className="refetch-text-short">Refetch</span>
                    </button>
                  )}
                </div>
              )}
            </div>
            {/* Title/author/date/karma below the provenance + buttons row, so the
                buttons never squish it */}
            {renderTitleBlock()}
            {editing ? (
              <div className="markdown-editor">
                <div className="markdown-editor-toolbar">
                  <button
                    type="button"
                    className={`md-toolbar-btn ${showEditPreview ? '' : 'active'}`}
                    onClick={() => setShowEditPreview(false)}
                  >
                    <Pencil size={14} /> Write
                  </button>
                  <button
                    type="button"
                    className={`md-toolbar-btn ${showEditPreview ? 'active' : ''}`}
                    onClick={() => setShowEditPreview(true)}
                  >
                    <Eye size={14} /> Preview
                  </button>
                  <div style={{ flex: 1 }} />
                  <button type="button" className="md-toolbar-btn" onClick={cancelEdit} disabled={savingEdit}>
                    Cancel
                  </button>
                  <button type="button" className="md-toolbar-btn primary" onClick={saveEdit} disabled={savingEdit}>
                    {savingEdit ? 'Saving…' : 'Save'}
                  </button>
                </div>
                <div className="md-editor-meta">
                  <input
                    type="text"
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    placeholder="Title"
                    aria-label="Title"
                  />
                  <input
                    type="text"
                    value={editAuthor}
                    onChange={(e) => setEditAuthor(e.target.value)}
                    placeholder="Author"
                    aria-label="Author"
                  />
                  <input
                    type="date"
                    value={editDate}
                    onChange={(e) => setEditDate(e.target.value)}
                    aria-label="Date"
                  />
                </div>
                {editError && <p className="md-editor-error">{editError}</p>}
                {showEditPreview ? (
                  <div
                    className="article-content"
                    dangerouslySetInnerHTML={{ __html: safeDraftPreview }}
                  />
                ) : (
                  <textarea
                    className="markdown-editor-textarea"
                    value={draftMd}
                    onChange={(e) => setDraftMd(e.target.value)}
                    spellCheck={false}
                  />
                )}
                <p className="md-editor-hint">
                  Markdown editor, works with Obsidian (copy/paste both ways). Saving does not
                  regenerate audio; the read-along stays on the old version until you regenerate it.
                </p>
              </div>
            ) : (
              <>
                <div
                  className="article-content"
                  onClick={handleAnchorNav}
                  dangerouslySetInnerHTML={{ __html: safeArticleBodyHtml }}
                />
                {parsedComments.length > 0 && (
                  <div className="tab-comments-display" style={{ marginTop: '2rem' }}>
                    <div className="read-along-comments-divider" />
                    <div className="comments-header">
                      <h3>Comments ({totalCommentCount})</h3>
                    </div>
                    <div className="comments-list">
                      {parsedComments.map((comment, index) => (
                        <CommentComponent key={index} comment={comment} depth={0} isLessWrong={isLessWrongUrl} isSubstack={isSubstackUrl} />
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
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
                dangerouslySetInnerHTML={{ __html: safeDescriptionHtml }}
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
                  <CommentComponent key={index} comment={comment} depth={0} isLessWrong={isLessWrongUrl} isSubstack={isSubstackUrl} />
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
                  {renderProvenance()}
                </div>
                {content.type === 'article' && content.url && onRefetch && (
                  <button className="refetch-button" title="Refetch content and comments from web" onClick={onRefetch}>
                    <RefreshCw size={16} />
                    <span className="refetch-text-full">Refetch from web</span>
                    <span className="refetch-text-short">Refetch</span>
                  </button>
                )}
              </div>
              {renderTitleBlock()}
              <div
                className="article-content"
                dangerouslySetInnerHTML={{ __html: safeArticleBodyHtml }}
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
                      <CommentComponent key={index} comment={comment} depth={0} isLessWrong={isLessWrongUrl} isSubstack={isSubstackUrl} />
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        );
      }
      case 'summary': {
        // Prefer blank-line separation (what the summarizer is asked for), but fall back to
        // single newlines so we still split into tweets if the model omits the blank line.
        const toParagraphs = (text?: string) => {
          const t = (text || '').trim();
          if (!t) return [];
          let parts = t.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
          if (parts.length <= 1) parts = t.split(/\n+/).map(p => p.trim()).filter(Boolean);
          return parts;
        };
        const articleTweets = toParagraphs(content.summary);
        const commentTweets = toParagraphs(content.comment_summary);
        return (
          <div className="tab-content-display">
            <div className="summary-thread">
              {articleTweets.map((tweet, i) => (
                <p key={`a-${i}`} className="summary-tweet">{tweet}</p>
              ))}
              {commentTweets.length > 0 && (
                <>
                  <div className="summary-divider" role="separator" aria-label="Comment summary" />
                  <p className="summary-section-label">Comments</p>
                  {commentTweets.map((tweet, i) => (
                    <p key={`c-${i}`} className="summary-tweet">{tweet}</p>
                  ))}
                </>
              )}
            </div>
          </div>
        );
      }
      case 'history': {
        return (
          <div className="tab-content-display">
            <div className="content-header">
              <h2>Version history</h2>
            </div>
            <p className="md-editor-hint" style={{ marginTop: 0 }}>
              Snapshots saved automatically before each edit, refetch, or restore. Audio is not versioned.
            </p>
            {versionsLoading ? (
              <p className="no-content">Loading…</p>
            ) : viewingVersion ? (
              <div className="version-viewer">
                <div className="content-header-with-button">
                  <div className="content-header">
                    <h3>
                      {versionSourceLabel(viewingVersion.source)} &bull;{' '}
                      {new Date(viewingVersion.created_at).toLocaleString('en-GB')}
                    </h3>
                  </div>
                  <div className="content-header-actions">
                    <button className="refetch-button" onClick={() => setViewingVersion(null)}>
                      Back
                    </button>
                    <button className="refetch-button" onClick={() => restoreVersion(viewingVersion.id)}>
                      <RotateCcw size={16} />
                      <span className="refetch-text-full">Restore this</span>
                      <span className="refetch-text-short">Restore</span>
                    </button>
                  </div>
                </div>
                <div
                  className="article-content"
                  onClick={handleAnchorNav}
                  dangerouslySetInnerHTML={{ __html: safeVersionHtml }}
                />
              </div>
            ) : versions.length === 0 ? (
              <p className="no-content">
                No earlier versions yet. A snapshot is saved automatically before you edit, refetch, or restore.
              </p>
            ) : (
              <ul className="version-list">
                {versions.map((v) => (
                  <li key={v.id} className="version-row">
                    <div className="version-meta">
                      <span className={`version-badge version-${v.source}`}>{versionSourceLabel(v.source)}</span>
                      <span className="version-date">{new Date(v.created_at).toLocaleString('en-GB')}</span>
                      <span className="version-size">{Math.max(1, Math.round((v.html_bytes || 0) / 1024))} KB</span>
                    </div>
                    <div className="version-actions">
                      <button className="md-toolbar-btn" onClick={() => viewVersion(v.id)}>
                        View
                      </button>
                      <button className="md-toolbar-btn" onClick={() => restoreVersion(v.id)}>
                        Restore
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      }
      case 'queue': {
        const nonManualLabel = libraryContext ? (() => {
          const f = libraryContext.filter;
          const typeLabel = { all: 'Library', articles: 'Articles', texts: 'Texts', podcasts: 'Podcasts' }[f.typeFilter];
          // Short human tags for the captured facet filter (audio is implied for
          // anything playable, so it is skipped to keep the label compact).
          const facetLabels: string[] = [];
          if (f.facets.star === 'starred') facetLabels.push('Starred');
          if (f.facets.star === 'unstarred') facetLabels.push('Unstarred');
          if (f.facets.archive === 'archived') facetLabels.push('Archived');
          if (f.facets.summary === 'summary') facetLabels.push('Summarized');
          if (f.facets.summary === 'no_summary') facetLabels.push('Unsummarized');
          if (f.facets.transcript === 'transcript') facetLabels.push('Transcribed');
          if (f.facets.transcript === 'no_transcript') facetLabels.push('Untranscribed');
          const facetLabel = facetLabels.length > 0 ? `${facetLabels.join(' ')} ` : '';
          const searchLabel = f.searchQuery.trim() ? ` • “${f.searchQuery.trim()}”` : '';
          return `Up next from ${facetLabel}${typeLabel}${searchLabel}`;
        })() : 'Up next';

        const isEmpty = manualItems.length === 0 && nonManualItems.length === 0;

        return (
          <div className="tab-queue-display">
            {isEmpty ? (
              <p className="no-content">
                Your queue is empty. Add items from the library's "Add to queue" menu,
                or play a library item to populate "Up next" automatically.
              </p>
            ) : (
              <>
                {manualItems.length > 0 && (
                  <div className="queue-section">
                    <div className="queue-section-header">
                      <h3>In queue ({manualItems.length})</h3>
                      <button
                        className="queue-clear-btn"
                        onClick={() => {
                          if (confirm('Clear all items from the queue?')) clearQueue();
                        }}
                        title="Clear queue"
                      >
                        Clear
                      </button>
                    </div>
                    <div className="queue-list">
                      {manualItems.map((item, idx) => (
                        <QueueRow
                          key={`m-${item.queue_id}`}
                          item={item}
                          isCurrent={item.id === content.id}
                          onPlay={() => onPlayQueueItem?.(item)}
                          onRemove={() => removeFromQueue(item.queue_id)}
                          onMoveUp={() => moveUp(item.queue_id)}
                          onMoveDown={() => moveDown(item.queue_id)}
                          canMoveUp={idx > 0}
                          canMoveDown={idx < manualItems.length - 1}
                        />
                      ))}
                    </div>
                  </div>
                )}

                {manualItems.length > 0 && nonManualItems.length > 0 && (
                  <div className="queue-divider" />
                )}

                {nonManualItems.length > 0 && (
                  <div className="queue-section">
                    <div className="queue-section-header">
                      <h3>
                        {nonManualLabel} ({nonManualItems.length})
                      </h3>
                      <button
                        className={`queue-shuffle-btn ${autoplay ? 'active' : ''}`}
                        onClick={() => setAutoplay(!autoplay)}
                        title={autoplay ? 'Autoplay on. Will continue into library items after queue ends' : 'Autoplay off. Stops after queue ends'}
                      >
                        <Repeat size={14} />
                      </button>
                      <button
                        className={`queue-shuffle-btn ${shuffleNonManual ? 'active' : ''}`}
                        onClick={() => setShuffleNonManual(!shuffleNonManual, content.id)}
                        title={shuffleNonManual ? 'Shuffle on' : 'Shuffle off'}
                      >
                        <Shuffle size={14} />
                      </button>
                    </div>
                    {!autoplay && (
                      <p className="queue-hint">
                        Autoplay is off. These items won't play automatically when the queue ends.
                        Tap the loop icon above to turn it on.
                      </p>
                    )}
                    <div className="queue-list">
                      {nonManualItems.slice(0, 50).map(item => (
                        <QueueRow
                          key={`n-${item.id}`}
                          item={item}
                          isCurrent={false}
                          onPlay={() => onPlayQueueItem?.(item)}
                        />
                      ))}
                      {nonManualItems.length > 50 && (
                        <p className="queue-hint" style={{ textAlign: 'center' }}>
                          …and {nonManualItems.length - 50} more
                        </p>
                      )}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        );
      }
      default:
        return null;
    }
  };

  return (
    <div className="fullscreen-player" style={{ '--reader-font-scale': fontScale } as React.CSSProperties}>
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
                <a href={displayUrl(content.url)} target="_blank" rel="noopener noreferrer">
                  {getDomainFromUrl(displayUrl(content.url))}
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
                  <> &bull; <ArrowUp size={12} style={{ verticalAlign: '-1px' }} /> {content.karma}</>
                )}
                {totalCommentCount > 0 && (
                  <> &bull; <MessageCircle size={12} style={{ verticalAlign: '-1px' }} /> {totalCommentCount}</>
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
          {/* Dropdown menu (same options as library item) */}
          <div className="dropdown-container" ref={showDropdown ? dropdownRef : null} style={{ position: 'relative' }}>
            <button
              onClick={() => setShowDropdown(!showDropdown)}
              className="header-button"
              title="More options"
            >
              <MoreVertical size={20} />
            </button>
            {showDropdown && (
              <div className="dropdown-menu" style={{ right: 0, top: '100%' }}>
                {/* Star / Archive / Delete at the top */}
                <button
                  onClick={() => {
                    toggleStarred(content.id);
                    onContentUpdated?.({ ...content, is_starred: !content.is_starred });
                  }}
                  style={content.is_starred ? { color: '#fbbf24' } : undefined}
                >
                  <Star size={14} fill={content.is_starred ? 'currentColor' : 'none'} style={{ marginRight: 6, verticalAlign: '-2px' }} />
                  {content.is_starred ? 'Unstar' : 'Star'}
                </button>
                <button
                  onClick={async () => {
                    // toggleArchived does the optimistic store update + the server PATCH.
                    // Archiving an article wipes its audio server-side, so the old optimistic
                    // spread left the player holding a stale audio_url. Await the PATCH, then
                    // fetch the fresh item once and hand THAT to the player.
                    await toggleArchived(content.id);
                    try {
                      const fresh = await contentAPI.getById(content.id);
                      onContentUpdated?.(fresh.data);
                    } catch (err) {
                      console.error('Failed to refresh player after archive:', err);
                    }
                  }}
                  style={content.is_archived ? { color: '#60a5fa' } : undefined}
                >
                  {content.is_archived
                    ? <ArchiveRestore size={14} style={{ marginRight: 6, verticalAlign: '-2px' }} />
                    : <Archive size={14} style={{ marginRight: 6, verticalAlign: '-2px' }} />
                  }
                  {content.is_archived ? 'Unarchive' : 'Archive'}
                </button>
                <button
                  onClick={() => { setShowDropdown(false); deleteItem(content.id); onClose(); }}
                  style={{ color: '#ef4444' }}
                >
                  <Trash2 size={14} style={{ marginRight: 6, verticalAlign: '-2px' }} />
                  Delete
                </button>
                {/* Audio / transcript / refetch options */}
                {(content.type === 'article' || content.type === 'text') && (
                  <>
                    {!content.audio_url && onGenerateAudio && (
                      <button onClick={() => { setShowDropdown(false); onGenerateAudio(false); }}>
                        <Volume2 size={14} style={{ marginRight: 6, verticalAlign: '-2px' }} />
                        Generate audio
                      </button>
                    )}
                    {content.audio_url && onGenerateAudio && (
                      <button onClick={() => { setShowDropdown(false); onGenerateAudio(true); }}>
                        <Volume2 size={14} style={{ marginRight: 6, verticalAlign: '-2px' }} />
                        Regenerate audio
                      </button>
                    )}
                    {content.audio_url && onRemoveAudio && (
                      <button onClick={() => { setShowDropdown(false); onRemoveAudio(); }}>
                        <VolumeOff size={14} style={{ marginRight: 6, verticalAlign: '-2px' }} />
                        Remove audio
                      </button>
                    )}
                  </>
                )}
                {/* Summary options (independent of audio, both can be generated at once).
                    Podcasts summarize their transcript; App.tsx confirms + chains Whisper
                    first when no transcript exists yet. */}
                {(content.type === 'article' || content.type === 'text' || content.type === 'podcast_episode') && (
                  <>
                    {onGenerateSummary && content.summary_status === 'generating' && (
                      <button disabled>
                        <MessageSquareText size={14} style={{ marginRight: 6, verticalAlign: '-2px' }} />
                        Generating summary…
                      </button>
                    )}
                    {onGenerateSummary && content.summary_status !== 'generating' && !content.summary && (
                      <button onClick={() => { setShowDropdown(false); onGenerateSummary(false); }}>
                        <MessageSquareText size={14} style={{ marginRight: 6, verticalAlign: '-2px' }} />
                        Generate summary
                      </button>
                    )}
                    {onGenerateSummary && content.summary_status !== 'generating' && content.summary && (
                      <button onClick={() => { setShowDropdown(false); onGenerateSummary(true); }}>
                        <MessageSquareText size={14} style={{ marginRight: 6, verticalAlign: '-2px' }} />
                        Regenerate summary
                      </button>
                    )}
                    {onRemoveSummary && content.summary_status !== 'generating' && content.summary && (
                      <button onClick={() => { setShowDropdown(false); onRemoveSummary(); }}>
                        <MessageSquareOff size={14} style={{ marginRight: 6, verticalAlign: '-2px' }} />
                        Remove summary
                      </button>
                    )}
                  </>
                )}
                {(content.type === 'article' || content.type === 'text') && content.audio_url && onRegenerateTranscript && (
                  <button onClick={() => { setShowDropdown(false); onRegenerateTranscript(); }}>
                    <Captions size={14} style={{ marginRight: 6, verticalAlign: '-2px' }} />
                    Regenerate transcript
                  </button>
                )}
                {content.type === 'podcast_episode' && onRegenerateTranscript && (
                  <button onClick={() => { setShowDropdown(false); onRegenerateTranscript(); }}>
                    <Captions size={14} style={{ marginRight: 6, verticalAlign: '-2px' }} />
                    {content.transcript ? 'Regenerate' : 'Generate'} transcript
                  </button>
                )}
                {content.type === 'article' && content.url && (
                  <button onClick={() => { setShowDropdown(false); if (onRefetch) onRefetch(); }}>
                    <RefreshCw size={14} style={{ marginRight: 6, verticalAlign: '-2px' }} />
                    Refetch from web
                  </button>
                )}
                <button onClick={handleCopyContent}>
                  <Copy size={14} style={{ marginRight: 6, verticalAlign: '-2px' }} />
                  Copy content
                </button>
                <button onClick={handleDownloadDataZip}>
                  <FolderDown size={14} style={{ marginRight: 6, verticalAlign: '-2px' }} />
                  Download data (zip)
                </button>
              </div>
            )}
          </div>
          {/* No minimize without audio. The mini player is playback chrome, so
              audio-less items live in fullscreen only (close is the way out) */}
          {content.audio_url && (
            <button onClick={onMinimize} className="header-button" title="Minimize">
              <Minimize2 size={20} />
            </button>
          )}
          <button onClick={onClose} className="header-button" title="Close">
            <X size={20} />
          </button>
        </div>
      </div>

      {/* Tabs with autoscroll toggle. Only the tab list scrolls horizontally on
          narrow screens, the autoscroll toggle stays pinned outside the scroll area. */}
      <div className="fullscreen-tabs">
        <div className="fullscreen-tabs-scroll">
          {availableTabs.map((tab) => {
            const Icon = TAB_ICONS[tab];
            return (
              <button
                key={tab}
                className={`tab-button ${activeTab === tab ? 'active' : ''}`}
                onClick={() => handleTabClick(tab)}
                title={TAB_LABELS[tab]}
              >
                <Icon size={16} />
                <span>{TAB_LABELS[tab]}</span>
                {tab === 'comments' && totalCommentCount > 0 && <span>({totalCommentCount})</span>}
              </button>
            );
          })}
        </div>
        {activeTab === 'read-along' && (
          <button
            className={`autoscroll-toggle ${autoScroll ? 'active' : ''}`}
            onClick={() => setAutoScroll(!autoScroll)}
            title={autoScroll ? 'Disable auto-scroll' : 'Enable auto-scroll'}
          >
            <ArrowDownToLine size={14} />
            <span className="tab-label">Auto-scroll</span>
          </button>
        )}
      </div>

      {/* Tab Content Area */}
      <div className="fullscreen-tab-content" ref={tabContentRef}>
        {renderTabContent()}
      </div>

      {/* Player Controls. Without audio there is no timeline, no play/seek, and no
          speed/sleep: the row reduces to previous track, display settings, next track. */}
      <div className="fullscreen-player-controls">
        {content.audio_url && (
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
        )}

        {content.audio_url && (
        <div className="fullscreen-playback-controls">
          <button
            onClick={() => onSkipPrevTrack?.()}
            title="Previous track"
            className="track-skip-btn"
            disabled={!hasPrevTrack}
          >
            <SkipBack size={22} />
          </button>

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

          <button
            onClick={() => onSkipNextTrack?.()}
            title="Next track"
            className="track-skip-btn"
            disabled={!hasNextTrack}
          >
            <SkipForward size={22} />
          </button>
        </div>
        )}

        <div className="fullscreen-player-options">
          {content.audio_url ? (
            <>
              <button onClick={onToggleSpeed} className="option-toggle">
                <Gauge size={20} />
                <span>{playbackSpeed}x</span>
              </button>

              <button onClick={onToggleSleepTimer} className="option-toggle">
                <Clock size={20} />
                <span>{sleepTimer ? `${sleepTimer}m` : 'Off'}</span>
              </button>
            </>
          ) : (
            // No audio: previous and next flank the display button in this single row.
            <button
              onClick={() => onSkipPrevTrack?.()}
              title="Previous track"
              className="track-skip-btn"
              disabled={!hasPrevTrack}
            >
              <SkipBack size={22} />
            </button>
          )}

          <div ref={displayPanelRef} style={{ position: 'relative' }}>
            <button
              onClick={() => setShowDisplayPanel(p => !p)}
              className="option-toggle"
              title="Display settings"
            >
              <Type size={20} />
              <span>{Math.round(fontScale * 100)}%</span>
            </button>
            {showDisplayPanel && (
              <div className="display-panel">
                <div className="display-panel-label">Text size</div>
                <div className="font-scale-control">
                  <button
                    className="font-scale-btn"
                    onClick={() => {
                      const idx = FONT_SCALES.indexOf(fontScale);
                      if (idx > 0) handleFontScaleChange(FONT_SCALES[idx - 1]);
                    }}
                    disabled={FONT_SCALES.indexOf(fontScale) === 0}
                    aria-label="Decrease font size"
                  >−</button>
                  <span className="font-scale-value">{Math.round(fontScale * 100)}%</span>
                  <button
                    className="font-scale-btn"
                    onClick={() => {
                      const idx = FONT_SCALES.indexOf(fontScale);
                      if (idx < FONT_SCALES.length - 1) handleFontScaleChange(FONT_SCALES[idx + 1]);
                    }}
                    disabled={FONT_SCALES.indexOf(fontScale) === FONT_SCALES.length - 1}
                    aria-label="Increase font size"
                  >+</button>
                </div>
                <div className="display-panel-section">
                  <div className="display-panel-label">Appearance</div>
                  <button className="display-panel-toggle" onClick={onCycleTheme}>
                    {themeMode === 'dark' ? <Moon size={16} /> : themeMode === 'light' ? <Sun size={16} /> : <SunMoon size={16} />}
                    <span>{themeMode === 'dark' ? 'Dark' : themeMode === 'light' ? 'Light' : 'System'}</span>
                  </button>
                </div>
              </div>
            )}
          </div>

          {!content.audio_url && (
            <button
              onClick={() => onSkipNextTrack?.()}
              title="Next track"
              className="track-skip-btn"
              disabled={!hasNextTrack}
            >
              <SkipForward size={22} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
