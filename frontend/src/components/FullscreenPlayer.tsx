import { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import {
  Play,
  Pause,
  RotateCcw,
  RotateCw,
  Gauge,
  Check,
  Clock,
  SlidersHorizontal,
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
  Undo2,
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
import { cleanHtml, displayUrl, formatTime, getDomainFromUrl, hasAnyAudio } from '../format';
import { useContentStore } from '../store/contentStore';
import { usePendingArchiveStore } from '../store/pendingArchiveStore';
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
  // Deadline (ms timestamp) of the armed sleep timer, for the live countdown
  sleepTimerEndAt?: number | null;
  // When > 0, the automatic resume-seek permanently failed at this position:
  // show a manual "Resume at MM:SS" chip (clicking it is a normal user seek).
  resumeTargetTime?: number;
  activeWordIndex?: number;
  transcriptWords?: TranscriptWord[];
  onPlayPause: () => void;
  onSeek: (time: number) => void;
  onSkipBackward: () => void;
  onSkipForward: () => void;
  onSpeedChange: (speed: number) => void;
  onToggleSpeed: () => void;
  onSetSleepTimer: (minutes: number | null) => void;
  // Which audio the player is effectively playing ('summary' disables all
  // read-along highlighting/seeking, whose timestamps belong to the original).
  playingVariant?: 'original' | 'summary' | null;
  preferSummaryAudio?: boolean;
  onTogglePreferSummaryAudio?: () => void;
  // Per-item variant pick from the Summary tab banner (does not touch the setting).
  // autoplay true = an explicit Play press; false = switch keeping play/pause state.
  onSelectAudioVariant?: (variant: 'original' | 'summary', autoplay: boolean) => void;
  onMinimize: () => void;
  onClose: () => void;
  onTranscriptWordClick: (wordIndex: number) => void;
  onRefetch?: () => void;
  onGenerateAudio?: (regenerate: boolean) => void;
  onRemoveAudio?: () => void;
  onGenerateSummary?: (regenerate: boolean) => void;
  onRemoveSummary?: () => void;
  onGenerateSummaryAudio?: () => void;
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

// Sleep-timer durations for the playback-options panel (Off is its own chip)
const SLEEP_TIMER_OPTIONS = [5, 10, 15, 30, 45, 60];

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
  sleepTimerEndAt = null,
  resumeTargetTime = 0,
  activeWordIndex = -1,
  transcriptWords = [],
  onPlayPause,
  onSeek,
  onSkipBackward,
  onSkipForward,
  onToggleSpeed,
  onSetSleepTimer,
  playingVariant = null,
  preferSummaryAudio = false,
  onTogglePreferSummaryAudio,
  onSelectAudioVariant,
  onMinimize,
  onClose,
  onTranscriptWordClick,
  onRefetch,
  onGenerateAudio,
  onRemoveAudio,
  onGenerateSummary,
  onRemoveSummary,
  onGenerateSummaryAudio,
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

  // When switching tracks, KEEP the active tab (so e.g. Summary stays open
  // while pressing next to read summary after summary). The auto-select
  // effect below snaps to the new item's first available tab whenever the
  // kept tab doesn't exist for it, so a missing tab can never be forced.
  useEffect(() => {
    tabScrollPositions.current = {};
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
  // Playback-options panel (sleep timer presets + the global Prefer-summary-audio toggle)
  const [showPlaybackPanel, setShowPlaybackPanel] = useState(false);
  const playbackPanelRef = useRef<HTMLDivElement>(null);
  // Content store for star/archive/delete actions
  const { toggleStarred, toggleArchived, deleteItem, updateItem } = useContentStore();
  // Delayed-archive state (player-only): pending + deferred both render as Undo
  // (deferred = timer fired while this item is loaded; archives on player-leave).
  const pendingArchives = usePendingArchiveStore(s => s.pending);
  const deferredArchives = usePendingArchiveStore(s => s.deferred);
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

  // Close playback-options panel when clicking outside (same pattern as above)
  useEffect(() => {
    if (!showPlaybackPanel) return;
    function handleClick(e: MouseEvent) {
      if (playbackPanelRef.current && !playbackPanelRef.current.contains(e.target as Node)) {
        setShowPlaybackPanel(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showPlaybackPanel]);

  // Live countdown for the armed sleep timer on the playback-options button.
  // Playback re-renders keep it fresh while playing; this slow tick covers pause.
  const [, setSleepTick] = useState(0);
  useEffect(() => {
    if (!sleepTimerEndAt) return;
    const iv = setInterval(() => setSleepTick(t => t + 1), 15000);
    return () => clearInterval(iv);
  }, [sleepTimerEndAt]);
  const sleepRemainingLabel = sleepTimerEndAt
    ? `${Math.max(1, Math.ceil((sleepTimerEndAt - Date.now()) / 60000))}m`
    : null;

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

  // Everything read-along describes the ORIGINAL audio. While the summary audio
  // plays, its clock means nothing to those timestamps, so highlighting, the
  // timeline comments marker, and click-to-seek are all disabled.
  const playingSummaryAudio = playingVariant === 'summary';

  // Calculate marker position as percentage
  const commentsMarkerPosition = useMemo(() => {
    if (playingSummaryAudio) return null;
    if (!commentsStartTime || !duration || duration === 0) return null;
    return (commentsStartTime / duration) * 100;
  }, [commentsStartTime, duration, playingSummaryAudio]);

  // Find active element index for LLM alignment
  const activeElementIndex = useMemo(() => {
    if (playingSummaryAudio) return -1;
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
  }, [isLLMAlignment, parsedAlignment, currentTime, playingSummaryAudio]);

  // --- Read-along performance (2026-07-29) ----------------------------------
  // The read-along used to compute the active-highlight class inline in JSX,
  // which made React rebuild EVERY element roughly 4x/second while audio played
  // (visible lag on phones with very long articles, even with autoscroll off).
  // Instead, the element trees below are memoized per alignment WITHOUT any
  // active class, and a tiny effect moves the ra-active class between the two
  // affected DOM nodes as playback advances. Same DOM, same CSS, same behavior.
  // While summary audio plays, element/word clicks must not seek it to original-audio
  // timestamps: the memoized trees call these refs, so swapping in a no-op disables
  // seeking without touching the trees.
  const onSeekRef = useRef(onSeek);
  onSeekRef.current = playingSummaryAudio ? () => {} : onSeek;

  const readAlongParts = useMemo(() => {
    if (!isLLMAlignment || !parsedAlignment?.elements) return null;
    const elements = parsedAlignment.elements as LLMAlignmentElement[];
    // Precomputed index lookup (elements.indexOf per comment was quadratic on
    // heavily-commented articles).
    const indexByEl = new Map<LLMAlignmentElement, number>();
    elements.forEach((el, i) => indexByEl.set(el, i));
    return {
      elements,
      indexByEl,
      titleEl: elements.find(e => e.type === 'title'),
      metaElements: elements.filter(e => e.type === 'meta'),
      bodyElements: elements.filter(e =>
        ['heading', 'paragraph', 'image', 'blockquote', 'tweet', 'list', 'code-block', 'llm-block'].includes(e.type)
      ),
      commentDivider: elements.find(e => e.type === 'comment-divider'),
      commentElements: elements.filter(e => e.type === 'comment'),
    };
  }, [isLLMAlignment, parsedAlignment]);

  const readAlongBodyTree = useMemo(() => {
    if (!readAlongParts) return null;
    const { bodyElements, indexByEl } = readAlongParts;
    return bodyElements.map((el) => {
      const globalIndex = indexByEl.get(el)!;
      return (
        <div
          key={`body-${globalIndex}`}
          id={`ra-el-${globalIndex}`}
          className="read-along-element"
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
            onSeekRef.current(el.startTime);
          }}
        >
          <div dangerouslySetInnerHTML={{ __html: sanitizedElementHtml.get(el) ?? '' }} />
        </div>
      );
    });
  }, [readAlongParts, sanitizedElementHtml]);

  const readAlongCommentsTree = useMemo(() => {
    if (!readAlongParts || readAlongParts.commentElements.length === 0) return null;
    const { commentElements, commentDivider, indexByEl } = readAlongParts;
    const isLW = content.url ? content.url.includes('lesswrong.com') : false;
    const isSub = content.url ? content.url.includes('substack.com') : false;

    interface CommentNode {
      element: LLMAlignmentElement;
      globalIndex: number;
      children: CommentNode[];
    }
    const roots: CommentNode[] = [];
    const stack: CommentNode[] = [];
    for (const el of commentElements) {
      const depth = el.commentMeta?.depth ?? 0;
      const node: CommentNode = { element: el, globalIndex: indexByEl.get(el)!, children: [] };
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
      const meta = el.commentMeta;
      const metaStr = buildCommentMetadata(meta, isLW, isSub);
      return (
        // Odd depths get the alternate shade, same rule as the Comments tab.
        <div className={`comment${nodeDepth % 2 === 1 ? ' comment-alt' : ''}`} key={`comment-${globalIndex}`}>
          <div
            id={`ra-el-${globalIndex}`}
            className="read-along-element"
            onClick={(e) => {
              e.stopPropagation();
              // Same rule as the body: a real link opens (no seek), an image link
              // seeks (no open), everything else seeks.
              const target = e.target as HTMLElement;
              const anchor = target.closest('a');
              const isImage = target.tagName === 'IMG' || (!!anchor && !!anchor.querySelector('img'));
              if (anchor && !isImage) return;
              if (isImage) e.preventDefault();
              if (isNarrated) onSeekRef.current(el.startTime);
            }}
          >
            <div className="comment-header">
              <span className="comment-username">{meta?.username || 'Anonymous'}</span>
              {meta?.date && (
                <span className="comment-date">
                  {' • '}
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
            id={`ra-el-${indexByEl.get(commentDivider)!}`}
            className="comments-header read-along-element"
            onClick={() => { if (commentDivider.startTime >= 0) onSeekRef.current(commentDivider.startTime); }}
          >
            <h3>Comments ({commentElements.length})</h3>
          </div>
        )}
        <div className="comments-list">
          {roots.map(node => renderCommentNode(node))}
        </div>
      </>
    );
  }, [readAlongParts, sanitizedElementHtml, content.url]);

  // Apply the highlight imperatively. Runs after every render (at most two
  // classList operations), which also self-heals after tab switches and after
  // the memoized trees rebuild (fresh nodes render without the class).
  const highlightedElRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const next = isLLMAlignment && activeTab === 'read-along' && activeElementIndex >= 0
      ? document.getElementById(`ra-el-${activeElementIndex}`)
      : null;
    if (highlightedElRef.current && highlightedElRef.current !== next) {
      highlightedElRef.current.classList.remove('ra-active');
    }
    if (next) next.classList.add('ra-active');
    highlightedElRef.current = next;
  });

  // --- Podcast transcript performance (stage 2, 2026-08-18) -----------------
  // Same recipe as the read-along memos above, applied to the word-by-word
  // podcast transcript: the ~18k word spans of a 2h episode used to be rebuilt
  // by React on every playback tick just to color one newly spoken word.
  // The tree below renders once per transcript with no read state and no
  // per-word handlers; an imperative effect paints the .read class on only the
  // words that changed since the previous tick.
  const onTranscriptWordClickRef = useRef(onTranscriptWordClick);
  onTranscriptWordClickRef.current = playingSummaryAudio ? () => {} : onTranscriptWordClick;

  const transcriptDisplayWords = useMemo(() => {
    if (content.type !== 'podcast_episode') return null;
    if (transcriptWords.length > 0) {
      return transcriptWords.map(w => (w.word || '').replace(/^\s+/, ''));
    }
    const fallbackText = cleanHtml(content.transcript || content.content || '');
    return fallbackText.split(/\s+/).filter(w => w.length > 0);
  }, [content.type, transcriptWords, content.transcript, content.content]);

  const transcriptTree = useMemo(() => {
    if (!transcriptDisplayWords || transcriptDisplayWords.length === 0) return null;
    // One delegated click handler instead of 18k closures
    const handleWordClick = (e: React.MouseEvent<HTMLParagraphElement>) => {
      const span = (e.target as HTMLElement).closest('span.transcript-word');
      if (!span) return;
      const index = Number(span.id.slice('word-'.length));
      if (Number.isFinite(index)) onTranscriptWordClickRef.current(index);
    };
    return (
      <p className="read-along-text" onClick={handleWordClick}>
        {transcriptDisplayWords.map((word, index) => (
          <span key={index} id={`word-${index}`} className="transcript-word">
            {word}{' '}
          </span>
        ))}
      </p>
    );
  }, [transcriptDisplayWords]);

  // Paint the read state imperatively. Runs after every render; when the active
  // word hasn't moved it does a single probe and no DOM writes. Fresh spans
  // (tab switch, item change) render unmarked, which the probe detects, and the
  // whole range is then re-applied from scratch.
  const appliedReadUpToRef = useRef(-1);
  useEffect(() => {
    const isWordView = activeTab === 'read-along' && !isLLMAlignment && content.type === 'podcast_episode';
    if (!isWordView) {
      appliedReadUpToRef.current = -1;
      return;
    }
    const target = activeWordIndex;
    let applied = appliedReadUpToRef.current;
    if (applied >= 0) {
      const probe = document.getElementById(`word-${applied}`);
      if (!probe || !probe.classList.contains('read')) applied = -1;
    }
    if (target > applied) {
      for (let i = applied + 1; i <= target; i++) {
        document.getElementById(`word-${i}`)?.classList.add('read');
      }
    } else if (target < applied) {
      for (let i = target + 1; i <= applied; i++) {
        document.getElementById(`word-${i}`)?.classList.remove('read');
      }
    }
    appliedReadUpToRef.current = target;
  });

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
    // Queue is a listening feature: audio-less items hide it (the queue only
    // lists audio items and autoplay skips them, while the prev/next buttons
    // walk everything, so showing it there would just contradict the buttons).
    // Summary audio counts: a summary-audio-only item is a playable audio item.
    if (hasAnyAudio(content)) tabs.push('queue');
    return tabs;
  }, [content.type, content.audio_url, content.summary_audio_url, content.generation_status, content.summary, hasAlignment, versions.length, content.versions_count]);

  // Auto-select first available tab if current one disappeared.
  // NOTE: this condition is mirrored in the scroll-reset effect below (it
  // can't just read activeTab there, see that effect's comment). Keep both in sync.
  useEffect(() => {
    if (availableTabs.length > 0 && !availableTabs.includes(activeTab)) {
      setActiveTab(availableTabs[0]);
    }
  }, [availableTabs, activeTab]);

  // Honor a requested initial tab (e.g. "Read more" in the library → Summary tab).
  // Runs after the auto-select effect so it wins when both fire on a new item.
  // App.tsx only sets initialTab on the click that opens the player, next/prev/
  // autoplay never touch it, so this keeps firing on every later item too as
  // long as it has a summary. NOTE: mirrored in the scroll-reset effect below.
  useEffect(() => {
    if (initialTab === 'summary' && (content.summary || '').trim()) {
      setActiveTab('summary');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content.id, initialTab]);

  // The default tab follows the audio actually PLAYING (user decision 2026-08-18):
  // opening or advancing into an item whose effective audio is the summary snaps to
  // the Summary tab (overriding tab persistence, since the read-along views would
  // show text the playing audio does not narrate). Toggling the mode on an item
  // with both audios flips between Summary and the item's normal default. Items
  // playing their original audio keep the existing persistence behavior.
  // NOTE: the item-change branch below (playingVariant === 'summary') is
  // mirrored in the scroll-reset effect below. Keep both in sync.
  const prevTabFollowRef = useRef<{ id: number | null; variant: 'original' | 'summary' | null }>({ id: null, variant: null });
  useEffect(() => {
    const prev = prevTabFollowRef.current;
    prevTabFollowRef.current = { id: content.id, variant: playingVariant };
    if (playingVariant === 'summary') {
      if (prev.id !== content.id || prev.variant !== 'summary') setActiveTab('summary');
      return;
    }
    // Mode toggled back to the original audio on the SAME item: return to its default.
    if (prev.id === content.id && prev.variant === 'summary' && playingVariant === 'original') {
      setActiveTab(content.type === 'podcast_episode' ? 'description' : 'read-along');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content.id, playingVariant]);

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

  // Summary tab auto-scroll. Summary audio deliberately has no timestamps of its own
  // (no Whisper, no alignment), so the only available signal is how far through the
  // clip we are. That fraction is mapped straight onto the page height and centred in
  // the viewport, which is the same thing the legacy word-index scroll does, minus the
  // per-word lookup that has nothing to look up here.
  //
  // The centring IS the start and end delay: while the reading point is still inside
  // the top half-screen of content the container cannot scroll up, so it stays pinned
  // at the top and the opening words stay put. The same happens at the bottom, so the
  // closing words stay readable. That dead zone lands at roughly 15-20 seconds at each
  // end whatever the summary length, since audio duration and page height both scale
  // with the amount of text. No hand-tuned delay is needed on top.
  //
  // The motion is the legacy fallback's motion, not a new one. scrollIntoView with
  // block 'center' is defined as "scroll the container so the target sits in the middle,
  // clamped to the scroll range", which is exactly the target computed below, so a
  // smooth scrollTo reproduces it without anchoring to any element. Assigning scrollTop
  // directly instead would step 4x/s and read as choppy. The read-along tall-element
  // branch above scrolls the same way.
  const scrollSummaryToProgress = useCallback(() => {
    const container = tabContentRef.current;
    if (!container || !duration) return;
    const maxScroll = container.scrollHeight - container.clientHeight;
    if (maxScroll <= 0) return;
    const readingPoint = (currentTime / duration) * container.scrollHeight;
    const target = readingPoint - container.clientHeight / 2;
    container.scrollTo({ top: Math.max(0, Math.min(maxScroll, target)), behavior: 'smooth' });
  }, [currentTime, duration]);

  const scrollSummaryRef = useRef(scrollSummaryToProgress);
  useEffect(() => {
    scrollSummaryRef.current = scrollSummaryToProgress;
  }, [scrollSummaryToProgress]);

  // Land the tab content at a sensible spot for the new item. This scroll
  // container is never unmounted between items (same DOM node, only props
  // change), so without this its scrollTop just carries over from whatever
  // the previous item was scrolled to (reported 2026-08-21, worst on the
  // Summary tab, where you always want to start reading from the top).
  // Every tab defaults to the top. Two exceptions, both only with auto-scroll
  // on, and both jumping DIRECTLY to where the audio already is (matching what
  // continuous auto-scroll does during playback) instead of flashing at the top
  // first: the Transcript tab jumps to the playing highlight, and the Summary
  // tab jumps to its progress position when the summary audio is what is
  // playing. With auto-scroll off, both behave like every other tab.
  //
  // `activeTab` state can still be showing the PREVIOUS item's tab here: the
  // three effects above that pick the new item's tab (auto-select-first-
  // available, honor-initialTab, follow-playing-summary) call setActiveTab(),
  // but that update hasn't committed yet when this effect runs in the same
  // pass (reported 2026-08-22: advancing from Transcript into an item
  // playing its summary correctly flipped the visible tab to Summary, but
  // this effect still saw the old "read-along" tab, tried to jump to a
  // highlighted word that doesn't exist on the Summary tab, found nothing,
  // and left the old scroll position in place). So the actual landing tab is
  // resolved fresh below, mirroring those three effects' conditions.
  // KEEP THIS IN SYNC with the three NOTE comments above marking them.
  useEffect(() => {
    let landingTab = activeTab;
    if (availableTabs.length > 0 && !availableTabs.includes(landingTab)) landingTab = availableTabs[0];
    if (initialTab === 'summary' && (content.summary || '').trim()) landingTab = 'summary';
    if (playingVariant === 'summary') landingTab = 'summary';

    const jumpToHighlight = landingTab === 'read-along' && autoScroll;
    const jumpToSummaryProgress = landingTab === 'summary' && autoScroll && playingVariant === 'summary';
    if (jumpToHighlight) {
      setTimeout(() => scrollToActiveRef.current(), 100);
    } else if (jumpToSummaryProgress) {
      setTimeout(() => scrollSummaryRef.current(), 100);
    } else {
      requestAnimationFrame(() => {
        if (tabContentRef.current) {
          tabContentRef.current.scrollTop = 0;
        }
      });
    }
    // Deliberately keyed on content.id only: everything else above is read
    // fresh, we don't want this to re-fire just because the user toggles
    // auto-scroll or switches tabs mid-item.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content.id]);

  // Trigger scroll once when switching to read-along tab
  useEffect(() => {
    if (activeTab === 'read-along') {
      setTimeout(() => scrollToActiveRef.current(), 100);
    }
  }, [activeTab]);

  // Auto-scroll as audio plays (only when autoScroll is on). Aligned articles
  // scroll every tick (progressive intra-element scrolling needs currentTime);
  // the podcast word view only scrolls when the active word changes, since
  // restarting the smooth scroll 4x/s against an 18k-span paragraph forces a
  // layout flush per tick and re-launches the animation before it can finish.
  const lastAutoScrolledWordRef = useRef(-1);
  useEffect(() => {
    lastAutoScrolledWordRef.current = -1;
  }, [content.id]);
  useEffect(() => {
    if (activeTab !== 'read-along' || !autoScroll) return;
    if (isLLMAlignment) {
      scrollToActive();
      return;
    }
    if (activeWordIndex >= 0 && activeWordIndex !== lastAutoScrolledWordRef.current) {
      lastAutoScrolledWordRef.current = activeWordIndex;
      scrollToActive();
    }
  }, [activeTab, currentTime, autoScroll, scrollToActive, isLLMAlignment, activeWordIndex]);

  // Summary tab equivalent, sharing the same auto-scroll switch. Gated on the summary
  // audio actually playing: the full audio's clock says nothing about where you are in
  // a 90-second summary of it. Also fires on entering the tab, so switching to Summary
  // mid-playback lands at the right spot.
  useEffect(() => {
    if (activeTab !== 'summary' || !playingSummaryAudio || !autoScroll) return;
    scrollSummaryToProgress();
  }, [activeTab, playingSummaryAudio, autoScroll, scrollSummaryToProgress]);

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
      // The edit just snapshotted the previous state; refresh the History tab's
      // list so the new snapshot shows without closing and reopening the player.
      loadVersions();
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
    if (!readAlongParts) return null;
    // Categorization, body, and comments all live in the memos above; only the
    // small header (provenance + timed title/meta) renders per pass.
    const { titleEl, metaElements, indexByEl } = readAlongParts;

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
                  id={`ra-el-${indexByEl.get(titleEl)!}`}
                  className="read-along-element"
                  onClick={() => onSeekRef.current(titleEl.startTime)}
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
                  id={`ra-el-${indexByEl.get(el)!}`}
                  className="read-along-element"
                  onClick={() => onSeekRef.current(el.startTime)}
                >
                  <div dangerouslySetInnerHTML={{ __html: sanitizedElementHtml.get(el) ?? '' }} />
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Article body (same .article-content CSS as content tab), synced to the audio alignment */}
        <div className="article-content">
          {readAlongBodyTree}
        </div>

        {/* Comments section: timestamped commentElements from the alignment */}
        {readAlongCommentsTree && (
          <div className="tab-comments-display" style={{ marginTop: '2rem' }}>
            <div className="read-along-comments-divider" />
            {readAlongCommentsTree}
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
                buttons never squish it. Hidden while editing: the editor has its
                own Title/Author/Date fields, showing both is redundant. */}
            {!editing && renderTitleBlock()}
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

        // For articles/texts: if we have LLM alignment, use it (with read-along features).
        // If not, show the raw content + comments (like the old Content tab) without timestamps.
        // For podcasts: show transcript words or status messages.
        if (isPodcast) {
          // Podcast: show word-by-word transcript or status messages.
          // The word spans come from the memoized transcriptTree (built once per
          // transcript); read-state and clicks are handled imperatively above.
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
              ) : transcriptTree ? (
                transcriptTree
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
        // Top banner, only when summary audio exists: Play switches to the summary
        // audio for THIS item (a temporary override, the global toggle is untouched);
        // while the summary is playing it flips into a switch-back to the full audio.
        const summaryAudioBanner = content.summary_audio_url && onSelectAudioVariant ? (
          <div className="summary-audio-banner">
            {playingVariant === 'summary' ? (
              content.audio_url ? (
                <>
                  <span className="summary-audio-label"><Volume2 size={15} /> Playing summary audio</span>
                  <button className="summary-audio-btn" onClick={() => onSelectAudioVariant('original', false)}>
                    Switch to full audio
                  </button>
                </>
              ) : isPlaying ? (
                <span className="summary-audio-label"><Volume2 size={15} /> Playing summary audio</span>
              ) : (
                <>
                  <span className="summary-audio-label"><Volume2 size={15} /> Summary audio available</span>
                  <button className="summary-audio-btn" onClick={() => onSelectAudioVariant('summary', true)}>
                    <Play size={13} /> Play
                  </button>
                </>
              )
            ) : (
              <>
                <span className="summary-audio-label"><Volume2 size={15} /> Summary audio available</span>
                <button className="summary-audio-btn" onClick={() => onSelectAudioVariant('summary', true)}>
                  <Play size={13} /> Play
                </button>
              </>
            )}
          </div>
        ) : null;
        return (
          <div className="tab-content-display">
            {summaryAudioBanner}
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
        // Which snapshot holds the text the current audio narrates? Snapshots are
        // taken BEFORE each overwrite, so the audio's source text lives in the
        // OLDEST snapshot created AFTER the audio was generated. No such snapshot
        // means the audio was generated from the current text.
        const audioAt = content.audio_url && content.audio_generated_at
          ? new Date(content.audio_generated_at).getTime()
          : null;
        const audioVersionId = audioAt === null
          ? null
          : versions
              .filter((v) => new Date(v.created_at).getTime() > audioAt)
              .reduce<ContentVersion | null>((oldest, v) =>
                !oldest || new Date(v.created_at).getTime() < new Date(oldest.created_at).getTime() ? v : oldest, null)
              ?.id ?? null;
        return (
          <div className="tab-content-display">
            <div className="content-header">
              <h2>Version history</h2>
            </div>
            <p className="md-editor-hint" style={{ marginTop: 0 }}>
              Snapshots saved automatically before each edit, refetch, or restore. Audio is not versioned.
            </p>
            {audioAt !== null && (
              <p className="version-audio-note">
                <Volume2 size={13} style={{ verticalAlign: '-2px', marginRight: 5 }} />
                {audioVersionId === null
                  ? 'The audio and transcript were generated from the current text.'
                  : 'The audio and transcript were generated from an older version, marked below.'}
              </p>
            )}
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
                      {v.id === audioVersionId && (
                        <span className="version-badge version-audio" title="The current audio and transcript were generated from this version of the text">
                          <Volume2 size={11} style={{ verticalAlign: '-1px', marginRight: 3 }} />
                          audio
                        </span>
                      )}
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
                    // The 10s undo window exists to protect generated audio from an
                    // accidental archive. When archiving deletes nothing (no audio,
                    // podcast source audio, or a starred item), archive instantly.
                    const archiveWipesAudio = !!content.audio_url
                      && (content.type === 'article' || content.type === 'text')
                      && !content.is_starred;
                    if (!content.is_archived && archiveWipesAudio) {
                      // Delayed archive (10s): the timer lives app-level (pendingArchiveStore),
                      // so it fires even after this player moves on or closes, defers while the
                      // item is still loaded here, and a second press within the window undoes
                      // it before the server wipes anything.
                      const store = usePendingArchiveStore.getState();
                      if (store.pending[content.id] || store.deferred[content.id]) store.cancel(content.id);
                      else store.schedule(content.id);
                      return;
                    }
                    // Unarchiving, and archiving that wipes nothing, stay instant.
                    // toggleArchived does the optimistic store update + the server
                    // PATCH; then fetch the fresh item for the player.
                    await toggleArchived(content.id);
                    try {
                      const fresh = await contentAPI.getById(content.id);
                      onContentUpdated?.(fresh.data);
                    } catch (err) {
                      console.error('Failed to refresh player after archive:', err);
                    }
                  }}
                  style={content.is_archived || pendingArchives[content.id] || deferredArchives[content.id] ? { color: '#60a5fa' } : undefined}
                >
                  {content.is_archived
                    ? <ArchiveRestore size={14} style={{ marginRight: 6, verticalAlign: '-2px' }} />
                    : pendingArchives[content.id] || deferredArchives[content.id]
                      ? <Undo2 size={14} style={{ marginRight: 6, verticalAlign: '-2px' }} />
                      : <Archive size={14} style={{ marginRight: 6, verticalAlign: '-2px' }} />
                  }
                  {content.is_archived ? 'Unarchive' : pendingArchives[content.id] || deferredArchives[content.id] ? 'Undo' : 'Archive'}
                  {!content.is_archived && pendingArchives[content.id] && <span className="pending-archive-bar" />}
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
                    {/* Summary audio: TTS of the summary, only offered once a summary exists.
                        Removal rides on Remove summary (the audio narrates the summary). */}
                    {onGenerateSummaryAudio && content.summary && content.summary_audio_status === 'generating' && (
                      <button disabled>
                        <Volume2 size={14} style={{ marginRight: 6, verticalAlign: '-2px' }} />
                        Generating summary audio…
                      </button>
                    )}
                    {onGenerateSummaryAudio && content.summary && content.summary_status !== 'generating' && content.summary_audio_status !== 'generating' && (
                      <button onClick={() => { setShowDropdown(false); onGenerateSummaryAudio(); }}>
                        <Volume2 size={14} style={{ marginRight: 6, verticalAlign: '-2px' }} />
                        {content.summary_audio_url ? 'Regenerate summary audio' : 'Generate summary audio'}
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
          {/* No minimize without audio (original OR summary). The mini player is
              playback chrome, so audio-less items live in fullscreen only (close
              is the way out). Missed the summary-audio case until 2026-08-21:
              a summary-audio-only item's button had vanished since this still
              checked content.audio_url alone. */}
          {hasAnyAudio(content) && (
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
        {/* One shared auto-scroll preference, shown on both tabs that can follow the
            audio. The Summary tab only shows it when there is summary audio to follow. */}
        {(activeTab === 'read-along' || (activeTab === 'summary' && !!content.summary_audio_url)) && (
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
        {playingVariant !== null && (
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

        {playingVariant !== null && (
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

        {content.generation_status === 'failed' && content.generation_error && (
          <div className="player-error-banner">{content.generation_error}</div>
        )}

        {resumeTargetTime > 0 && (
          <button className="resume-chip" onClick={() => onSeek(resumeTargetTime)}>
            Resume at {formatTime(resumeTargetTime)}
          </button>
        )}

        <div className="fullscreen-player-options">
          {playingVariant !== null ? (
            <button onClick={onToggleSpeed} className="option-toggle">
              <Gauge size={20} />
              <span>{playbackSpeed}x</span>
            </button>
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

          {playingVariant !== null ? (
            <div ref={playbackPanelRef} style={{ position: 'relative' }}>
              <button
                onClick={() => setShowPlaybackPanel(p => !p)}
                className={`option-toggle ${sleepTimer || preferSummaryAudio ? 'active' : ''}`}
                title="Playback options"
              >
                {sleepRemainingLabel ? (
                  <>
                    <Clock size={20} />
                    <span>{sleepRemainingLabel}</span>
                  </>
                ) : (
                  <>
                    <SlidersHorizontal size={20} />
                    <Clock size={20} />
                  </>
                )}
              </button>
              {showPlaybackPanel && (
                <div className="display-panel playback-panel">
                  <div className="display-panel-label">
                    <Clock size={12} className="sleep-label-icon" /> Sleep timer
                  </div>
                  <div className="sleep-preset-row">
                    <button
                      className={`sleep-preset ${sleepTimer === null ? 'active' : ''}`}
                      onClick={() => onSetSleepTimer(null)}
                    >Off</button>
                    {SLEEP_TIMER_OPTIONS.map((m) => (
                      <button
                        key={m}
                        className={`sleep-preset ${sleepTimer === m ? 'active' : ''}`}
                        onClick={() => onSetSleepTimer(m)}
                      >{m}m</button>
                    ))}
                  </div>
                  {onTogglePreferSummaryAudio && (
                    <div className="display-panel-section">
                      <button
                        className={`display-panel-toggle prefer-summary-toggle ${preferSummaryAudio ? 'active' : ''}`}
                        onClick={onTogglePreferSummaryAudio}
                      >
                        <span>Prefer summary audio</span>
                        {preferSummaryAudio && <Check size={14} className="prefer-summary-check" />}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : (
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
