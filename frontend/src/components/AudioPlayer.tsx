import { useState, useEffect, useRef, useMemo } from 'react';
import type { ContentItem } from '../types';
import { contentAPI, userSettingsAPI } from '../api';
import { MiniPlayer } from './MiniPlayer';
import { FullscreenPlayer } from './FullscreenPlayer';
import { YouTubeVideo, VIDEO_STATE, type YouTubePlayer } from './YouTubeVideo';
import { SPEED_CATALOG, DEFAULT_SPEEDS, parseSpeedOptions, getEffectiveAudio, hasPlayableMedia, videoPlaysHere, youtubeVideoId, type AudioVariant } from '../format';
import { logPlayback, playbackChainOpen } from '../playback-log';
import { useAuthStore } from '../store/authStore';

function getStoredSpeed(): number {
  try {
    const stored = localStorage.getItem('playbackSpeed');
    if (stored) {
      const parsed = parseFloat(stored);
      // Validate against the full catalog, not the user's cycle: a speed that was
      // since removed from the cycle should still restore, the toggle just leaves it
      // on the next press.
      if (SPEED_CATALOG.includes(parsed)) return parsed;
    }
  } catch { /* private-mode Safari throws on localStorage access */ }
  return 1;
}

interface AudioPlayerProps {
  content: ContentItem | null;
  onClose: () => void;
  onRefetch?: () => void;
  onGenerateAudio?: (regenerate: boolean) => void;
  onRemoveAudio?: () => void;
  onGenerateSummary?: (regenerate: boolean) => void;
  onRemoveSummary?: () => void;
  onGenerateSummaryAudio?: () => void;
  onRegenerateTranscript?: () => void;
  onCancelGeneration?: () => void;
  onDismissError?: (kind: 'generation' | 'summary' | 'summary_audio') => void;
  onContentUpdated?: (updated: ContentItem) => void;
  isDark: boolean;
  themeMode?: 'dark' | 'light' | 'system';
  onCycleTheme?: () => void;
  // Queue integration, parent owns the queue store, player just calls up
  onTrackEnded?: () => void;
  // Called with whether the audio was playing, which the next item then follows
  onSkipNextTrack?: (wasPlaying: boolean) => void;
  onSkipPrevTrack?: (wasPlaying: boolean) => void;
  hasNextTrack?: boolean;
  hasPrevTrack?: boolean;
  /**
   * Parent increments this whenever it swaps `content` because of an auto-
   * advance or explicit next/prev. AudioPlayer watches it and auto-plays
   * the new track once metadata loads. Manual content clicks from the
   * library leave the counter alone, so the first track doesn't auto-play.
   */
  autoPlayToken?: number;
  /**
   * Parent increments this on every library click. A minimized player expands
   * back to fullscreen for the newly opened item. Auto-advance does not bump
   * it, so background listening stays in the mini player.
   */
  openToken?: number;
  onPlayQueueItem?: (item: ContentItem) => void;
  initialTab?: string;
  // Global "Prefer summary audio" mode (persisted user setting owned by App).
  // Decides which audio plays when an item has both; see getEffectiveAudio.
  preferSummaryAudio?: boolean;
  onSetPreferSummaryAudio?: (value: boolean) => void;
}

export function AudioPlayer({
  content, onClose, onRefetch, onGenerateAudio, onRemoveAudio, onGenerateSummary, onRemoveSummary,
  onGenerateSummaryAudio, onRegenerateTranscript, onCancelGeneration, onDismissError, initialTab,
  onContentUpdated, isDark, themeMode, onCycleTheme,
  onTrackEnded, onSkipNextTrack, onSkipPrevTrack, hasNextTrack = false, hasPrevTrack = false,
  autoPlayToken = 0, openToken = 0, onPlayQueueItem,
  preferSummaryAudio = false, onSetPreferSummaryAudio,
}: AudioPlayerProps) {
  // Per-item variant override (the Summary tab's Play / Switch-back banner): wins
  // over the global mode for THIS item only, without touching the persisted setting.
  const [overrideForId, setOverrideForId] = useState<{ id: number; variant: AudioVariant } | null>(null);

  // Which audio this item effectively plays under the current mode. 'summary' means
  // the whisper timestamps and read-along data (which belong to the ORIGINAL audio)
  // must not drive any highlighting. The override only applies while its target
  // audio actually exists (it could have been removed since).
  const requestedOverride = overrideForId && content && overrideForId.id === content.id ? overrideForId.variant : null;
  // A video is its own original media: it gets the full controls, and its position saves
  // to playback_position like an original audio.
  // A video that plays only on YouTube (embed_blocked) is treated like an item without audio.
  const isVideoItem = !!content && videoPlaysHere(content);
  const effectiveVariant: AudioVariant | null =
    requestedOverride === 'summary' && content?.summary_audio_url ? 'summary'
    : requestedOverride === 'original' && (content?.audio_url || isVideoItem) ? 'original'
    : content ? getEffectiveAudio(isVideoItem ? { ...content, audio_url: content.url } : content, preferSummaryAudio) : null;
  // A video item plays its video, unless its summary audio is the one playing
  const playsVideo = isVideoItem && effectiveVariant !== 'summary';
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackSpeed, setPlaybackSpeed] = useState(getStoredSpeed);
  const [speedOptions, setSpeedOptions] = useState<number[]>(DEFAULT_SPEEDS);
  // Resume-seek bookkeeping: bounded attempts, and the target we gave up on (shows
  // the manual "Resume at MM:SS" chip; saves stay suppressed until the user acts).
  const resumeAttemptsRef = useRef(0);
  const [resumeFailedAt, setResumeFailedAt] = useState(0);
  const [sleepTimer, setSleepTimer] = useState<number | null>(null);
  // Deadline timestamp of the armed sleep timer, drives the live countdown on
  // the playback-options button (sleepTimer alone is the static chosen duration)
  const [sleepTimerEndAt, setSleepTimerEndAt] = useState<number | null>(null);
  const [isExpanded, setIsExpanded] = useState(true);

  const audioRef = useRef<HTMLAudioElement>(null);
  const sleepTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isPlayingRef = useRef(isPlaying);
  const lastSavedPositionRef = useRef<number>(-1);
  // Tracks whether the user explicitly paused via the app UI. Used to block
  // OS-initiated plays (e.g. iOS re-routing audio to speaker on disconnect).
  const userPausedRef = useRef(false);
  // Timestamp of the last pause event, used to debounce rogue play events
  // from Sony headphone wear sensors (PAUSE→PLAY flicker on removal, ~100ms).
  // Intentional hardware play (smartwatch tap, headphone button) takes >1s.
  const lastPauseTimeRef = useRef<number>(0);
  // Set to true right before an app-initiated play() call so handlePlay can
  // distinguish it from hardware/OS-initiated plays (which need debouncing).
  const appPlayRef = useRef(false);
  // Mirrors the current content prop so permanent event handlers (with [] deps)
  // always see the up-to-date item without needing to be re-registered.
  const contentRef = useRef(content);
  // Latest onTrackEnded callback, read by the audio 'ended' handler which is
  // registered once with empty deps. Kept in a ref so prop changes are picked up.
  const onTrackEndedRef = useRef(onTrackEnded);
  const lastAutoPlayTokenRef = useRef(0);
  // An autoplay waiting for the new audio's metadata. A ref, not the effect's own variable,
  // because the item's details can be replaced before the audio loads (a running job's
  // status refresh every 2 s), which re-runs the setup effect, and the autoplay must survive.
  const autoPlayWaitingRef = useRef(false);
  // The autoplay called play() (or the video's playVideo), so the next 'play' is its own.
  // Only feeds the [Playback] log (playback-log.ts).
  const autoPlayStartingRef = useRef(false);
  // Tracks the last audio URL we actually set on the <audio> element. Content
  // objects get replaced (new reference, same item) every time the parent
  // refreshes metadata, expands comments, regenerates audio, etc. Without this
  // guard every refresh resets audio.src, interrupts playback, and leaves the
  // user unable to resume without closing and re-opening the player.
  const lastAudioSrcRef = useRef<string>('');
  // The saved position we still owe the audio element. Proxied podcast streams are
  // often not seek-ready at loadedmetadata, so the browser silently ignores the
  // initial currentTime assignment and the track sits at 0:00; the auto-save then
  // WIPED the real saved position ("podcast reopens at 0" bug). While this is > 0,
  // every save is suppressed and the seek keeps retrying (canplay/progress/play)
  // until it sticks or the user seeks manually.
  const pendingResumeSeekRef = useRef<number>(0);
  // Which position column the LOADED audio saves to. Set alongside audio.src, so a
  // variant swap can never write the summary position into playback_position or
  // vice versa (card progress must stay original-audio-only).
  const positionFieldRef = useRef<'playback_position' | 'summary_playback_position'>('playback_position');
  const lastContentIdRef = useRef<number | null>(null);
  // Keep playing across a "Prefer summary audio" toggle on the same item: the swap
  // replaces audio.src (which pauses), so the loadedmetadata handler resumes.
  const resumePlayAfterVariantSwapRef = useRef(false);

  // ---- YouTube videos ----
  // A video plays in YouTube's embedded player (YouTubeVideo), which only exists while the
  // fullscreen view shows it. Minimizing destroys it, and expanding builds a new one that
  // starts at videoTimeRef, so the position lives here and not in the player.
  const videoId = isVideoItem ? youtubeVideoId(content?.url) : null;
  const ytPlayerRef = useRef<YouTubePlayer | null>(null);
  const videoTimeRef = useRef(0);
  // Play as soon as the player is ready (autoplay, or Play pressed while it was loading)
  const videoPlayPendingRef = useRef(false);
  const videoClockRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastVideoItemRef = useRef<number | null>(null);
  // The item whose video (not its summary audio) drives the controls right now
  const videoVariantForRef = useRef<number | null>(null);
  const videoDurationSavedForRef = useRef<number | null>(null);
  const [videoRate, setVideoRate] = useState(1);
  const [videoError, setVideoError] = useState<string | null>(null);
  // The video box can be hidden to give the tabs room. Hiding pauses the video, Play shows
  // it again. The ref mirrors the state for handlers that run before a re-render.
  const [videoHidden, setVideoHidden] = useState(false);
  const videoHiddenRef = useRef(false);
  // The video box, which the timeline's full-screen button puts in full screen
  const videoBoxRef = useRef<HTMLDivElement | null>(null);
  // Mirrors isExpanded synchronously: the autoplay check in the setup effect runs in the
  // same commit as the openToken effect that expands the player.
  const isExpandedRef = useRef(true);
  // Latest duration, for the save-on-leave cleanup, which runs with an old closure
  const durationRef = useRef(0);
  // YouTube's player has no time event, so while it plays the position is read four
  // times a second (readVideoTime). That drives the timeline exactly as audio's
  // timeupdate does.
  const stopVideoClock = () => {
    if (videoClockRef.current) {
      clearInterval(videoClockRef.current);
      videoClockRef.current = null;
    }
  };

  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  useEffect(() => {
    contentRef.current = content;
  }, [content]);

  useEffect(() => {
    onTrackEndedRef.current = onTrackEnded;
  }, [onTrackEnded]);


  // Reset user-pause intent when switching to a new item
  useEffect(() => {
    userPausedRef.current = false;
  }, [content?.id]);

  // A library click reopens fullscreen even when the player sat minimized
  // (see the openToken prop docs). Runs once on mount too, harmlessly, since
  // isExpanded already starts true.
  useEffect(() => {
    if (openToken > 0) {
      isExpandedRef.current = true;
      setIsExpanded(true);
    }
  }, [openToken]);

  useEffect(() => {
    durationRef.current = duration;
  }, [duration]);

  // Clear the per-item override on every genuine track change. Its own render-time
  // check (overrideForId.id === content.id) already ignores it while on any OTHER
  // item, so this doesn't change what plays right now, it only stops the override
  // from silently reviving if you navigate back to that exact item later in the
  // same session, which used to make the prev button's "restart if nearly
  // finished" check (App.tsx) read the wrong audio's position again (found
  // 2026-08-22, same bug class that 64f3363 already fixed once for the global
  // setting). Deliberately its own tiny effect, not folded into the src-loading
  // effect below, so clearing it can never itself trigger a second src swap.
  useEffect(() => {
    setOverrideForId(null);
  }, [content?.id]);

  // Hook up the OS MediaSession API so headset / lock-screen / bluetooth
  // controls can drive the player. Deliberately map *next/previous* to
  // seek ±15s (podcast-style) rather than true track-nav, the user
  // preferred that for long-form audio. The dedicated seekbackward /
  // seekforward actions do the same thing so both UIs are covered.
  useEffect(() => {
    if (!content) return;
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    // A video plays inside YouTube's frame, which owns its own media session, and the
    // handlers below drive the <audio> element. So none are set, and no stale title stays.
    if (isVideoItem) {
      ms.metadata = null;
      return;
    }

    ms.metadata = new window.MediaMetadata({
      title: content.title || 'wallacast',
      artist: content.podcast_show_name || content.author || 'wallacast',
      album: content.type === 'podcast_episode' ? (content.podcast_show_name || 'Podcast') : 'Library',
      artwork: content.preview_picture
        ? [{ src: content.preview_picture, sizes: '512x512', type: 'image/png' }]
        : [],
    });

    const seekBy = (delta: number) => {
      const audio = audioRef.current;
      if (!audio) return;
      const next = Math.min(
        Math.max(0, audio.currentTime + delta),
        audio.duration && isFinite(audio.duration) ? audio.duration : audio.currentTime + delta,
      );
      audio.currentTime = next;
      setCurrentTime(next);
    };

    // Do NOT register custom play/pause handlers. The browser's <audio>
    // element already handles play/pause from lock screen / headphones
    // natively via DOM events, which flow through our handlePlay/handlePause
    // with all the wear-sensor debounce and userPausedRef guards. A custom
    // MediaSession play handler bypasses those guards and causes headphone
    // disconnect to resume paused audio (the bug we fixed before).
    try { ms.setActionHandler('previoustrack', () => seekBy(-15)); } catch { /* unsupported */ }
    try { ms.setActionHandler('nexttrack', () => seekBy(15)); } catch { /* unsupported */ }
    try { ms.setActionHandler('seekbackward', (d: any) => seekBy(-(d?.seekOffset || 15))); } catch { /* unsupported */ }
    try { ms.setActionHandler('seekforward', (d: any) => seekBy(d?.seekOffset || 15)); } catch { /* unsupported */ }
    try {
      ms.setActionHandler('seekto', (d: any) => {
        if (typeof d?.seekTime !== 'number') return;
        const audio = audioRef.current;
        if (!audio) return;
        audio.currentTime = d.seekTime;
        setCurrentTime(d.seekTime);
      });
    } catch { /* unsupported */ }

    return () => {
      try { ms.setActionHandler('previoustrack', null); } catch { /* unsupported */ }
      try { ms.setActionHandler('nexttrack', null); } catch { /* unsupported */ }
      try { ms.setActionHandler('seekbackward', null); } catch { /* unsupported */ }
      try { ms.setActionHandler('seekforward', null); } catch { /* unsupported */ }
      try { ms.setActionHandler('seekto', null); } catch { /* unsupported */ }
    };
  }, [content?.id, content?.title, content?.podcast_show_name, content?.preview_picture, content?.author, content?.type]);

  // Reflect playback state so OS UIs show the right play/pause state
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
  }, [isPlaying]);

  // Sync speed + the toggle's speed cycle from backend on mount (cross-device persistence)
  useEffect(() => {
    userSettingsAPI.get('playback_speed').then(res => {
      const val = res.data.value ? parseFloat(res.data.value) : null;
      if (val && SPEED_CATALOG.includes(val)) {
        localStorage.setItem('playbackSpeed', String(val));
        setPlaybackSpeed(val);
        if (audioRef.current) {
          audioRef.current.playbackRate = val;
        }
      }
    }).catch(() => {});
    userSettingsAPI.get('playback_speed_options').then(res => {
      setSpeedOptions(parseSpeedOptions(res.data.value));
    }).catch(() => {});
  }, []);

  // ---------------------------------------------------------------------------
  // 1. ROBUST DATA PARSING (Fixes the "Fallback to Linear" issue)
  // ---------------------------------------------------------------------------
  const parsedTranscriptWords = useMemo(() => {
    if (!content?.transcript_words) return [];
    
    const result = content.transcript_words;

    // Handle already parsed array
    if (Array.isArray(result)) return result;

    // Handle stringified JSON (and potential double-stringification)
    if (typeof result === 'string') {
      try {
        const parsed = JSON.parse(result);
        if (typeof parsed === 'string') {
          return JSON.parse(parsed); // Parse again
        }
        return Array.isArray(parsed) ? parsed : [];
      } catch (e) {
        console.error('JSON Parse failed:', e);
        return [];
      }
    }
    
    return [];
  }, [content?.transcript_words]);

  const parsedTTSChunks = useMemo(() => {
    if (!content?.tts_chunks) return [];
    if (Array.isArray(content.tts_chunks)) return content.tts_chunks;
    try {
      return typeof content.tts_chunks === 'string'
        ? JSON.parse(content.tts_chunks)
        : [];
    } catch {
      return [];
    }
  }, [content?.tts_chunks]);

  // [Playback] log lines (playback-log.ts). Something started while a chain is open: by the
  // autoplay, or by the user pressing Play on an item that did not start by itself.
  const logChainPlaying = (variant: 'audio' | 'video') => {
    const by = autoPlayStartingRef.current ? 'autoplay' : 'user';
    autoPlayStartingRef.current = false;
    if (playbackChainOpen()) logPlayback('playing', { id: contentRef.current?.id, variant, by }, true);
  };
  const refusedAutoplay = (id: number | undefined, err: unknown) => {
    autoPlayStartingRef.current = false;
    logPlayback('play-refused', { id, error: err instanceof Error ? err.name : String(err) }, true);
  };

  // ---------------------------------------------------------------------------
  // AUDIO SETUP
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!content) return;
    if (!audioRef.current) return;

    const audio = audioRef.current;

    // A variant-swap resume (keep playing across a Prefer-summary-audio toggle) is
    // only valid within the same item; a genuine track change clears it.
    if (content.id !== lastContentIdRef.current) {
      lastContentIdRef.current = content.id;
      resumePlayAfterVariantSwapRef.current = false;
      autoPlayStartingRef.current = false;
    }

    const playingSummary = effectiveVariant === 'summary';
    const startPosition = (playingSummary ? content.summary_playback_position : content.playback_position) || 0;

    let audioSrc: string;
    if (playingSummary && content.summary_audio_url) {
      // Summary audio wins over the podcast proxy branch: the proxy serves the
      // EPISODE, the summary variant URL serves our generated TTS file.
      const cacheBuster = `${content.summary_audio_generated_at ? new Date(content.summary_audio_generated_at).getTime() : 0}`;
      const separator = content.summary_audio_url.includes('?') ? '&' : '?';
      audioSrc = `${content.summary_audio_url}${separator}v=${cacheBuster}`;
    } else if (content.type === 'podcast_episode') {
      const apiBase = import.meta.env.VITE_API_URL as string || 'http://localhost:3001/api';
      audioSrc = `${apiBase}/content/${content.id}/audio`;
    } else if (content.audio_url) {
      const cacheBuster = `${content.file_size || 0}`;
      const separator = content.audio_url.includes('?') ? '&' : '?';
      audioSrc = `${content.audio_url}${separator}v=${cacheBuster}`;
    } else {
      audioSrc = '';
    }

    // Auto-play only when this content change was paired with a token bump
    // (queue advance/skip). Checking directly here instead of via a separate
    // ref prevents stale pending flags from leaking across unrelated content
    // changes (e.g. library clicks).
    const shouldAutoPlay = autoPlayToken > 0 && autoPlayToken !== lastAutoPlayTokenRef.current;
    if (shouldAutoPlay) {
      lastAutoPlayTokenRef.current = autoPlayToken;
    }

    // A newly opened video: its own position, whichever audio plays first. (Its YouTube
    // player is built by YouTubeVideo, which reports itself through handleVideoReady and
    // handleVideoGone, so ytPlayerRef is never reset here.)
    if (isVideoItem && content.id !== lastVideoItemRef.current) {
      lastVideoItemRef.current = content.id;
      videoPlayPendingRef.current = false;
      stopVideoClock();
      videoTimeRef.current = content.playback_position || 0;
      setVideoError(null);
      videoHiddenRef.current = false;
      setVideoHidden(false);
      setIsPlaying(false);
    } else if (!isVideoItem && lastVideoItemRef.current !== null) {
      // Leaving a video: its player went away with its YouTubeVideo, and no pause event came
      lastVideoItemRef.current = null;
      videoPlayPendingRef.current = false;
      stopVideoClock();
      setIsPlaying(false);
    }

    // A video plays in YouTube's player (see YouTubeVideo), never in the <audio> element,
    // except for its summary audio.
    if (isVideoItem && !playingSummary) {
      autoPlayWaitingRef.current = false;
      if (lastAudioSrcRef.current) {
        // Back from the summary audio: loading no source pauses it without a pause event
        lastAudioSrcRef.current = '';
        audio.removeAttribute('src');
        audio.load();
        setIsPlaying(false);
      }
      if (videoVariantForRef.current !== content.id) {
        // The video starts driving the controls: a new item, or a switch back from the
        // summary audio
        videoVariantForRef.current = content.id;
        positionFieldRef.current = 'playback_position';
        lastSavedPositionRef.current = -1;
        pendingResumeSeekRef.current = 0;
        resumeAttemptsRef.current = 0;
        setResumeFailedAt(0);
        setCurrentTime(videoTimeRef.current);
        setDuration(content.duration || 0);
      }
      // Only a visible video may start by itself (YouTube's embed rules). An item reached
      // by autoplay while the player is minimized waits for Play. A switch back from the
      // summary audio that was playing goes on playing.
      const resumeAfterSwap = resumePlayAfterVariantSwapRef.current;
      resumePlayAfterVariantSwapRef.current = false;
      if ((shouldAutoPlay || resumeAfterSwap) && isExpandedRef.current) {
        // An explicit play (a tap in the Queue tab) shows a hidden video again
        if (videoHiddenRef.current) {
          videoHiddenRef.current = false;
          setVideoHidden(false);
        }
        if (shouldAutoPlay) autoPlayStartingRef.current = true;
        const player = ytPlayerRef.current;
        if (player) {
          try { player.playVideo(); } catch { /* player gone */ }
        } else {
          videoPlayPendingRef.current = true;
        }
      } else if (shouldAutoPlay) {
        logPlayback('video-waits', { id: content.id, view: 'mini' }, true);
      }
      return;
    }
    videoVariantForRef.current = null;
    if (isVideoItem) {
      // The video's summary audio plays in the <audio> element below. The video pauses
      // and stays where it is on screen.
      try { ytPlayerRef.current?.pauseVideo(); } catch { /* player gone */ }
      videoPlayPendingRef.current = false;
      stopVideoClock();
    }

    // Runs once the new audio's metadata is in: the resume seek, the duration check, and the
    // autoplay or variant-swap resume.
    const handleLoadedMetadata = () => {
      if (startPosition > 0) {
        audio.currentTime = startPosition;
        setCurrentTime(startPosition);
        // Success is confirmed ONLY in the 'seeked' event handler: assigning
        // currentTime echoes the target synchronously even when the browser later
        // aborts the seek and snaps back to ~0, so reading it back here proves
        // nothing (that false success re-enabled saves and wiped real positions).
      }
      // The write-back below describes the ORIGINAL audio; a loaded summary audio is
      // always shorter and would clobber the item's real duration. The read-only demo may
      // not save it (the server refuses that with a message on screen).
      if (!playingSummary && !useAuthStore.getState().user?.demo && audio.duration && !isNaN(audio.duration) && isFinite(audio.duration)) {
        const realDuration = Math.floor(audio.duration);
        // Only auto-correct upwards if the DB has no duration. Don't override
        // an existing duration based on the browser reading, the backend now
        // trims trailing silence post-Whisper, and the browser would happily
        // report the bogus pre-trim value, undoing that fix.
        if (!content.duration || content.duration === 0) {
          contentAPI.update(content.id, { duration: realDuration }).catch(() => {});
        } else if (realDuration < content.duration - 2) {
          // Browser says the file is SHORTER than DB, trust the browser
          // (file probably truncated). Update DB so the timeline isn't too long.
          contentAPI.update(content.id, { duration: realDuration }).catch(() => {});
        }
      }
      if (autoPlayWaitingRef.current || resumePlayAfterVariantSwapRef.current) {
        const autoplay = autoPlayWaitingRef.current;
        autoPlayWaitingRef.current = false;
        resumePlayAfterVariantSwapRef.current = false;
        userPausedRef.current = false;
        appPlayRef.current = true;
        if (autoplay) autoPlayStartingRef.current = true;
        audio.play().catch((err) => {
          appPlayRef.current = false;
          if (autoplay) refusedAutoplay(content.id, err);
        });
      }
      audio.removeEventListener('loadedmetadata', handleLoadedMetadata);
    };

    // Guard against redundant src resets. The parent replaces `content` with
    // a new object reference on many non-audio events (comment fetches,
    // metadata refreshes, star/archive toggles, etc.). Without this, every
    // one of those resets audio.src and interrupts playback.
    if (audioSrc === lastAudioSrcRef.current) {
      // Same track already loaded. Tapping the currently-loaded item in the Queue
      // tab bumps autoPlayToken but leaves the src unchanged, so honor the explicit
      // autoplay request here before bailing, otherwise the tap does nothing.
      if (shouldAutoPlay) {
        autoPlayWaitingRef.current = false;
        userPausedRef.current = false;
        appPlayRef.current = true;
        autoPlayStartingRef.current = true;
        audio.play().catch((err) => {
          appPlayRef.current = false;
          refusedAutoplay(content.id, err);
        });
        return;
      }
      // The item's details were replaced before its audio loaded, and the cleanup of the
      // effect's previous run removed the listener that was to start it, so it listens
      // again here. Before 2026-10-23 that autoplay was lost: after a track ended, an item
      // with a running job (its status refreshes every 2 s) opened and did not start.
      if (autoPlayWaitingRef.current) {
        if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) {
          handleLoadedMetadata();
          return;
        }
        audio.addEventListener('loadedmetadata', handleLoadedMetadata);
        return () => audio.removeEventListener('loadedmetadata', handleLoadedMetadata);
      }
      return;
    }
    lastAudioSrcRef.current = audioSrc;
    autoPlayWaitingRef.current = shouldAutoPlay && !!audioSrc;
    // Route position saves to the loaded variant's column from here on, and reset
    // the save debounce so the new variant's first save is never suppressed.
    positionFieldRef.current = playingSummary ? 'summary_playback_position' : 'playback_position';
    lastSavedPositionRef.current = -1;
    pendingResumeSeekRef.current = startPosition > 0 ? startPosition : 0;
    resumeAttemptsRef.current = 0;
    setResumeFailedAt(0);
    if (audioSrc) {
      audio.src = audioSrc;
    } else {
      // No audio: drop the source. Assigning '' makes the browser load the page itself
      // as audio and fail with "MEDIA_ELEMENT_ERROR: Empty src attribute", which
      // handleError then reported to the backend as an [AudioError] for no reason.
      audio.removeAttribute('src');
      audio.load();
    }
    // Loading a new source pauses the element WITHOUT firing 'pause' (HTML spec, the
    // media element load algorithm only sets paused to true), so isPlaying stayed true:
    // the button kept showing Pause, and pressing it called pause() on an element that
    // was already paused, which does nothing, so nothing could ever play again
    // (reported 2026-10-06: summary audio playing in the mini player, then opening
    // another article). The autoplay and variant-swap resumes below play() again, and
    // their 'play' event sets it back to true.
    setIsPlaying(false);
    // The timeline shows the new source's starting point right away, not the old source's
    // time (a video's summary audio showed the video's 1:38 against its own 0:12)
    setCurrentTime(startPosition);

    const storedSpeed = getStoredSpeed();
    audio.playbackRate = storedSpeed;
    setPlaybackSpeed(storedSpeed);

    audio.addEventListener('loadedmetadata', handleLoadedMetadata);
    return () => {
      audio.removeEventListener('loadedmetadata', handleLoadedMetadata);
    };
  }, [content, autoPlayToken, effectiveVariant]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const handleTimeUpdate = () => setCurrentTime(audio.currentTime);
    const handleLoadedMetadata = () => setDuration(audio.duration);
    // Keep retrying the resume-seek until the stream becomes seekable (see
    // pendingResumeSeekRef). Attached once here (refs only), because the setup
    // effect's listeners get torn down on every content-object refresh.
    const RESUME_MAX_ATTEMPTS = 6;
    const retryResumeSeek = () => {
      const target = pendingResumeSeekRef.current;
      if (!target) return;
      if (audio.seeking) return; // a seek is in flight, let 'seeked' judge it
      // Steady state near the target (no seek in flight) = genuinely resumed.
      // currentTime only lies while a seek is pending, so this read is trustworthy.
      if (Math.abs(audio.currentTime - target) < 2) {
        pendingResumeSeekRef.current = 0;
        resumeAttemptsRef.current = 0;
        return;
      }
      if (resumeAttemptsRef.current >= RESUME_MAX_ATTEMPTS) {
        setResumeFailedAt(target); // surface the manual resume chip
        return;
      }
      resumeAttemptsRef.current++;
      try { audio.currentTime = target; } catch { /* not seekable yet, retry on next event */ }
    };
    // The ONLY trustworthy resume confirmation: the browser fired 'seeked' AND the
    // position is near the target at that moment. An aborted seek also fires
    // 'seeked' but lands elsewhere (usually ~0), which counts as a failed attempt.
    const handleResumeSeeked = () => {
      const target = pendingResumeSeekRef.current;
      if (!target) return;
      if (Math.abs(audio.currentTime - target) < 2) {
        pendingResumeSeekRef.current = 0;
        resumeAttemptsRef.current = 0;
        setResumeFailedAt(0);
        setCurrentTime(audio.currentTime);
        console.log(`[AudioPlayer] Resume-seek confirmed at ${audio.currentTime.toFixed(1)}s`);
        return;
      }
      if (resumeAttemptsRef.current >= RESUME_MAX_ATTEMPTS) {
        console.warn(`[AudioPlayer] Resume-seek gave up after ${RESUME_MAX_ATTEMPTS} attempts (target ${target}s)`);
        setResumeFailedAt(target);
        return;
      }
      resumeAttemptsRef.current++;
      try { audio.currentTime = target; } catch { /* retry on next event */ }
    };
    const handleEnded = () => {
      setIsPlaying(false);
      userPausedRef.current = false; // natural end, reset intent
      // Reset-to-start is only valid for a GENUINE finish. A truncated or aborted
      // stream can fire 'ended' mid-file, and unconditionally saving 0 here wiped
      // real positions. Near the end = within 30s of duration or past 99%.
      const dur = audio.duration;
      const nearEnd = isFinite(dur) && dur > 0 &&
        (dur - audio.currentTime <= 30 || audio.currentTime / dur >= 0.99);
      if (nearEnd) savePlaybackPosition(0);
      logPlayback('ended', {
        id: contentRef.current?.id,
        variant: positionFieldRef.current === 'summary_playback_position' ? 'summary' : 'audio',
        t: Math.round(audio.currentTime),
        dur: Math.round(dur),
        view: isExpandedRef.current ? 'full' : 'mini',
      });
      // Defer the queue check so the state update lands before parent reloads content
      setTimeout(() => onTrackEndedRef.current?.(), 0);
    };
    // Sync React state with actual DOM audio state.
    // Three guards run in order to decide whether to accept an incoming play:
    //  1. appPlayRef, app-initiated plays (togglePlay) always pass immediately.
    //  2. userPausedRef, explicit UI pause blocks OS-initiated resumes.
    //  3. Debounce, blocks rogue play events that arrive within 800ms of a
    //     pause (Sony headphone wear-sensor flicker on removal: PAUSE→PLAY
    //     in ~100ms). Intentional hardware plays (smartwatch, headphone
    //     button) take >1s and pass through.
    const handlePlay = () => {
      // App-initiated play (from togglePlay), always allow immediately
      if (appPlayRef.current) {
        appPlayRef.current = false;
        setIsPlaying(true);
        logChainPlaying('audio');
        return;
      }
      // Explicit user pause via app UI, block OS-initiated resumes
      if (userPausedRef.current) {
        audio.pause();
        return;
      }
      // Debounce: block rogue play events that arrive shortly after a pause.
      const timeSincePause = Date.now() - lastPauseTimeRef.current;
      if (lastPauseTimeRef.current > 0 && timeSincePause < 800) {
        console.log(`[AudioPlayer] Blocked rogue play ${timeSincePause}ms after pause`);
        audio.pause();
        return;
      }
      setIsPlaying(true);
      logChainPlaying('audio');
    };
    const handlePause = () => {
      lastPauseTimeRef.current = Date.now();
      setIsPlaying(false);
    };
    // Audio load/playback error, reset icon and report to backend for Railway logging.
    // We listen for 'error' because when a podcast stream fails (e.g. range request
    // rejected by CDN), the browser fires 'error', NOT 'pause'. Without this handler
    // the icon gets stuck showing "pause" even though nothing is playing.
    const handleError = () => {
      setIsPlaying(false);
      userPausedRef.current = true; // treat as paused so nothing auto-resumes
      const c = contentRef.current;
      // Fire-and-forget: log to backend so the error appears in Railway logs
      contentAPI.logAudioError({
        contentId: c?.id,
        contentType: c?.type,
        audioUrl: audio.src,
        errorCode: audio.error?.code,
        errorMessage: audio.error?.message,
        networkState: audio.networkState,
        readyState: audio.readyState,
        showName: c?.podcast_show_name,
      }).catch(() => {});
    };

    // Audio that stops for lack of data near its end may never fire 'ended', so that is
    // logged, once per source (playback-log.ts)
    let stalledLoggedFor = '';
    const handleStalled = (e: Event) => {
      const dur = audio.duration;
      if (!isFinite(dur) || dur - audio.currentTime > 60 || stalledLoggedFor === audio.src) return;
      stalledLoggedFor = audio.src;
      logPlayback('stalled', {
        id: contentRef.current?.id, how: e.type, t: Math.round(audio.currentTime), dur: Math.round(dur),
        net: audio.networkState, ready: audio.readyState,
      });
    };

    audio.addEventListener('timeupdate', handleTimeUpdate);
    audio.addEventListener('loadedmetadata', handleLoadedMetadata);
    audio.addEventListener('ended', handleEnded);
    audio.addEventListener('waiting', handleStalled);
    audio.addEventListener('stalled', handleStalled);
    audio.addEventListener('play', handlePlay);
    audio.addEventListener('pause', handlePause);
    audio.addEventListener('error', handleError);
    audio.addEventListener('canplay', retryResumeSeek);
    audio.addEventListener('progress', retryResumeSeek);
    audio.addEventListener('play', retryResumeSeek);
    audio.addEventListener('seeked', handleResumeSeeked);

    return () => {
      audio.removeEventListener('timeupdate', handleTimeUpdate);
      audio.removeEventListener('loadedmetadata', handleLoadedMetadata);
      audio.removeEventListener('ended', handleEnded);
      audio.removeEventListener('waiting', handleStalled);
      audio.removeEventListener('stalled', handleStalled);
      audio.removeEventListener('play', handlePlay);
      audio.removeEventListener('pause', handlePause);
      audio.removeEventListener('error', handleError);
      audio.removeEventListener('canplay', retryResumeSeek);
      audio.removeEventListener('progress', retryResumeSeek);
      audio.removeEventListener('play', retryResumeSeek);
      audio.removeEventListener('seeked', handleResumeSeeked);
    };
  }, []);

  // Reads contentRef, not the closed-over content prop: handleEnded (registered
  // once with [] deps, see the big effect above) holds whichever savePlaybackPosition
  // existed at mount forever, so a plain `content` reference here would make every
  // later track's "ended near the finish" reset write to whatever item was on
  // screen when the player first mounted, not the one that actually just ended
  // (found 2026-08-22). Reading the ref instead makes every caller, old closure
  // or new, always target the CURRENT item.
  const savePlaybackPosition = async (position: number) => {
    const c = contentRef.current;
    if (!c) return;
    // Never persist anything while the resume-seek hasn't been applied: the
    // element is sitting at the wrong spot (usually 0:00) through no fault of
    // the user, and saving would wipe the real stored position.
    if (pendingResumeSeekRef.current > 0) return;
    const floored = Math.floor(position);
    // Skip save if position hasn't changed by at least 3 seconds (debounce)
    if (lastSavedPositionRef.current >= 0 && Math.abs(floored - lastSavedPositionRef.current) < 3) {
      return;
    }
    lastSavedPositionRef.current = floored;
    try {
      await contentAPI.update(c.id, {
        [positionFieldRef.current]: floored,
        last_played_at: new Date().toISOString(),
      });
    } catch { /* silent */ }
  };

  // Auto-save position every 10s during playback
  // Depends on content?.id (not content) to prevent duplicate save/teardown
  // when the content object reference changes but the item is the same
  useEffect(() => {
    if (!content?.id) return;
    lastSavedPositionRef.current = -1; // Reset debounce on content change
    const interval = setInterval(() => {
      if (!isPlayingRef.current) return;
      if (videoVariantForRef.current !== null && videoVariantForRef.current === contentRef.current?.id) savePlaybackPosition(videoTimeRef.current);
      else if (audioRef.current) savePlaybackPosition(audioRef.current.currentTime);
    }, 10000);
    return () => clearInterval(interval);
  }, [content?.id]);

  // Save position on unmount or content change
  useEffect(() => {
    return () => {
      // A video's position is videoTimeRef (its player may already be gone). Within 10
      // seconds of the end it counts as finished, as below. Its summary audio saves like
      // any audio, further down.
      if (isVideoItem && positionFieldRef.current === 'playback_position') {
        const dur = content.duration || durationRef.current;
        const nearEnd = dur > 0 && dur - videoTimeRef.current < 10;
        contentAPI.update(content.id, {
          playback_position: nearEnd ? 0 : Math.floor(videoTimeRef.current),
          last_played_at: new Date().toISOString(),
        }).catch(() => {});
        return;
      }
      // Same guard as savePlaybackPosition: if the resume-seek never stuck, the
      // element still sits at the wrong spot, and saving here is what turned
      // "open a podcast, close it" into wiping its saved position to 0.
      if (audioRef.current && content && pendingResumeSeekRef.current === 0) {
        const audio = audioRef.current;
        // A track at (or within seconds of) its end counts as finished and keeps
        // the 0 that handleEnded saved. Without this check, this force-save ran
        // AFTER that reset on every auto-advance or close and wrote the final
        // second back, so finished items reopened at their last moment (the
        // "summary opens at its final seconds" bug, found 2026-08-31). The
        // thresholds match resetIfNearlyFinished in App.tsx, and the write stays
        // scoped to the loaded variant's own column via positionFieldRef.
        const dur = audio.duration;
        const threshold = positionFieldRef.current === 'summary_playback_position' ? 5 : 10;
        const nearEnd = isFinite(dur) && dur > 0 && dur - audio.currentTime < threshold;
        // Force save on unmount regardless of debounce
        const floored = nearEnd ? 0 : Math.floor(audio.currentTime);
        contentAPI.update(content.id, {
          [positionFieldRef.current]: floored,
          last_played_at: new Date().toISOString(),
        }).catch(() => {});
      }
    };
  }, [content?.id]);

  const togglePlay = () => {
    // A press of Play or Pause is the user's, even when an autoplay never started
    autoPlayStartingRef.current = false;
    if (playsVideo) {
      const player = ytPlayerRef.current;
      if (isPlaying) {
        savePlaybackPosition(videoTimeRef.current);
        try { player?.pauseVideo(); } catch { /* player gone */ }
        return;
      }
      if (!isExpandedRef.current || videoHiddenRef.current) {
        // Play from the mini player, or with the video hidden: the video may only play
        // visibly, so the player opens, the video shows, and the new YouTube player
        // starts once it is ready
        isExpandedRef.current = true;
        setIsExpanded(true);
        videoHiddenRef.current = false;
        setVideoHidden(false);
        videoPlayPendingRef.current = true;
        return;
      }
      if (player) {
        try { player.playVideo(); } catch { /* player gone */ }
      } else {
        videoPlayPendingRef.current = true;
      }
      return;
    }
    if (!audioRef.current) return;
    // The user decides now, so an autoplay still waiting for the audio to load is off
    autoPlayWaitingRef.current = false;
    if (isPlaying) {
      userPausedRef.current = true; // explicit user pause, block OS-initiated resumes
      savePlaybackPosition(audioRef.current.currentTime);
      audioRef.current.pause();
      // State update handled by the 'pause' DOM event listener
    } else {
      userPausedRef.current = false; // explicit user play, allow plays again
      appPlayRef.current = true;     // mark as app-initiated so handlePlay skips debounce
      const playPromise = audioRef.current.play();
      if (playPromise !== undefined) {
        playPromise.catch((err) => {
          console.error('[AudioPlayer] play() rejected:', err);
          appPlayRef.current = false;
          userPausedRef.current = true; // play failed, treat as paused
        });
      }
      // State update handled by the 'play' DOM event listener
    }
  };

  const handleSeek = (time: number) => {
    if (playsVideo) {
      videoTimeRef.current = time;
      setCurrentTime(time);
      savePlaybackPosition(time);
      const player = ytPlayerRef.current;
      if (!player || !videoId) return;
      try {
        // seekTo starts a video that has not played yet or has ended, and a seek must never
        // start or pause playback, so such a video is cued at the new spot instead
        const state = player.getPlayerState();
        if (state === VIDEO_STATE.UNSTARTED || state === VIDEO_STATE.CUED || state === VIDEO_STATE.ENDED) {
          player.cueVideoById({ videoId, startSeconds: time });
        } else {
          player.seekTo(time, true);
        }
      } catch { /* player gone */ }
      return;
    }
    if (!audioRef.current) return;
    const audio = audioRef.current;
    // An explicit user seek takes over from any still-pending resume-seek.
    pendingResumeSeekRef.current = 0;
    resumeAttemptsRef.current = 0;
    setResumeFailedAt(0);
    audio.currentTime = time;
    setCurrentTime(time);
    savePlaybackPosition(time);
    // Some MP3 files lack proper seeking headers, causing the browser to
    // silently ignore the currentTime assignment. Detect this and snap the
    // displayed time back to where the audio actually is.
    const checkSeek = () => {
      if (Math.abs(audio.currentTime - time) > 2) {
        setCurrentTime(audio.currentTime);
      }
    };
    audio.addEventListener('seeked', checkSeek, { once: true });
    setTimeout(() => audio.removeEventListener('seeked', checkSeek), 1000);
  };

  const handleSkipBackward = () => handleSeek(Math.max(0, currentTime - 15));
  const handleSkipForward = () => handleSeek(Math.min(duration, currentTime + 15));

  const handleSpeedChange = (speed: number) => {
    // Both, since a video item can swap between its video and its summary audio
    if (ytPlayerRef.current) applyVideoSpeed(ytPlayerRef.current, speed);
    if (audioRef.current) audioRef.current.playbackRate = speed;
    setPlaybackSpeed(speed);
    // Save globally: localStorage for instant recall, backend for cross-device sync
    localStorage.setItem('playbackSpeed', String(speed));
    userSettingsAPI.set('playback_speed', String(speed)).catch(() => {});
  };

  const toggleSpeed = () => {
    const currentIndex = speedOptions.indexOf(playbackSpeed);
    // Current speed can sit outside the configured cycle (options just changed, or a
    // removed speed restored from storage): jump to the next faster one, wrapping around.
    const next = currentIndex >= 0
      ? speedOptions[(currentIndex + 1) % speedOptions.length]
      : (speedOptions.find(s => s > playbackSpeed) ?? speedOptions[0]);
    handleSpeedChange(next);
  };

  // Direct sleep-timer setter for the playback-options panel (which shows all the
  // presets at once, so no cycling is needed anymore). null = off, which also
  // cancels a running timer.
  const setSleepTimerTo = (minutes: number | null) => {
    if (sleepTimerRef.current) {
      clearTimeout(sleepTimerRef.current);
      sleepTimerRef.current = null;
    }
    setSleepTimer(minutes);
    setSleepTimerEndAt(minutes !== null ? Date.now() + minutes * 60 * 1000 : null);
    if (minutes !== null) {
      sleepTimerRef.current = setTimeout(() => {
        if (audioRef.current) {
          audioRef.current.pause();
          setIsPlaying(false);
        }
        try { ytPlayerRef.current?.pauseVideo(); } catch { /* player gone */ }
        setSleepTimer(null);
        setSleepTimerEndAt(null);
      }, minutes * 60 * 1000);
    }
  };

  // Flip the global "Prefer summary audio" mode. When the current item actually has
  // both audios, the swap happens live: save the outgoing variant's position first
  // (the src change would otherwise lose it) and remember to resume playback.
  // Any per-item override is dropped so the toggle always visibly takes effect.
  // The outgoing side of a swap between a video and its summary audio, or between full and
  // summary audio: save its position and remember whether it was playing.
  const saveOutgoingVariant = (): boolean => {
    if (!content) return false;
    if (playsVideo) {
      savePlaybackPosition(videoTimeRef.current);
      return isPlaying;
    }
    const audio = audioRef.current;
    if (!audio) return false;
    if (pendingResumeSeekRef.current === 0) {
      contentAPI.update(content.id, {
        [positionFieldRef.current]: Math.floor(audio.currentTime),
        last_played_at: new Date().toISOString(),
      }).catch(() => {});
    }
    return !audio.paused;
  };

  const handleTogglePreferSummaryAudio = () => {
    if (!onSetPreferSummaryAudio) return;
    // A video counts as the full audio here
    const bothAudios = !!((content?.audio_url || isVideoItem) && content?.summary_audio_url);
    if (bothAudios) resumePlayAfterVariantSwapRef.current = saveOutgoingVariant();
    setOverrideForId(null);
    onSetPreferSummaryAudio(!preferSummaryAudio);
  };

  // Per-item variant selection from the Summary tab banner. `autoplay` true = an
  // explicit Play press (start playback even if paused); false = a switch that
  // keeps the current playing/paused state. Does NOT touch the global setting.
  const handleSelectAudioVariant = (variant: AudioVariant, autoplay: boolean) => {
    if (!content) return;
    const targetExists = variant === 'summary' ? !!content.summary_audio_url : !!(content.audio_url || isVideoItem);
    if (!targetExists) return;
    if (variant === effectiveVariant) {
      // Nothing to swap; an explicit Play press just plays.
      if (autoplay && !isPlaying) togglePlay();
      return;
    }
    const wasPlaying = saveOutgoingVariant();
    resumePlayAfterVariantSwapRef.current = autoplay || wasPlaying;
    setOverrideForId({ id: content.id, variant });
  };

  // ---------------------------------------------------------------------------
  // SYNC LOGIC (The Fix: NO Normalization)
  // ---------------------------------------------------------------------------

  // Numeric start times, converted once per transcript instead of once per word
  // per playback tick (a 2h podcast has ~18k words and this memo re-runs ~4x/s).
  const transcriptWordStarts = useMemo(
    () => parsedTranscriptWords.map((w: { start: number | string }) => Number(w.start)),
    [parsedTranscriptWords]
  );

  const activeWordIndex = useMemo(() => {
    if (!content) return -1;
    // Whisper timestamps describe the ORIGINAL audio. While the summary audio is
    // playing, its clock means nothing to them, so no word is "active".
    if (effectiveVariant === 'summary') return -1;

    // Method 1: Whisper Timestamps (TRUSTED)
    // We ignore the browser's duration estimate completely for sync.
    // Binary search for the last word whose start <= currentTime, same answer as
    // a linear scan since Whisper timestamps are non-decreasing.
    if (transcriptWordStarts.length > 0) {
      let lo = 0;
      let hi = transcriptWordStarts.length - 1;
      let idx = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (transcriptWordStarts[mid] <= currentTime) {
          idx = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      return idx;
    }

    // Method 2: TTS Chunks (Fallback)
    if (parsedTTSChunks.length > 0) {
      try {
        const currentChunk = parsedTTSChunks.find((c: any) => 
          currentTime >= c.startTime && currentTime < (c.startTime + c.duration)
        );
        if (currentChunk) {
          const timeIntoChunk = currentTime - currentChunk.startTime;
          const progress = timeIntoChunk / currentChunk.duration;
          const totalWordsInChunk = currentChunk.endWord - currentChunk.startWord + 1;
          const offset = Math.floor(progress * totalWordsInChunk);
          return currentChunk.startWord + offset;
        }
      } catch { /* ignore */ }
    }

    // Method 3: Linear Fallback (Last Resort)
    const transcript = content.transcript || content.content || '';
    const words = transcript.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().split(/\s+/);
    if (words.length > 0 && duration > 0) {
      return Math.floor((currentTime / duration) * words.length);
    }

    return -1;
  }, [currentTime, content, duration, transcriptWordStarts, parsedTTSChunks, effectiveVariant]);

  const handleTranscriptClick = (wordIndex: number) => {
    if (!content) return;

    // Method 1 Click
    if (parsedTranscriptWords.length > 0 && wordIndex < parsedTranscriptWords.length) {
      const timestamp = Number(parsedTranscriptWords[wordIndex].start);
      console.log(`[Sync Debug] Clicking Word ${wordIndex}: Timestamp ${timestamp}s`);
      handleSeek(timestamp);
      return;
    }

    // Method 2 Click
    if (parsedTTSChunks.length > 0) {
      try {
        for (const chunk of parsedTTSChunks) {
          if (wordIndex >= chunk.startWord && wordIndex <= chunk.endWord) {
            const wordPosInChunk = wordIndex - chunk.startWord;
            const wordsInChunk = chunk.endWord - chunk.startWord + 1;
            const positionInChunk = (wordPosInChunk / wordsInChunk) * chunk.duration;
            const timestamp = chunk.startTime + positionInChunk;
            handleSeek(timestamp);
            return;
          }
        }
      } catch { /* ignore */ }
    }

    // Method 3 Click
    const transcript = content.transcript || content.content || '';
    const words = transcript.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().split(/\s+/);
    const estimatedPosition = (wordIndex / words.length) * duration;
    handleSeek(estimatedPosition);
  };

  // ---------------------------------------------------------------------------
  // YOUTUBE VIDEO PLAYER
  // ---------------------------------------------------------------------------
  const readVideoTime = () => {
    const player = ytPlayerRef.current;
    if (!player) return;
    try {
      const t = player.getCurrentTime();
      if (Number.isFinite(t)) {
        videoTimeRef.current = t;
        setCurrentTime(t);
      }
    } catch { /* player gone */ }
    readVideoDuration();
  };

  const readVideoDuration = () => {
    const player = ytPlayerRef.current;
    if (!player) return;
    try {
      const d = player.getDuration();
      if (Number.isFinite(d) && d > 0) {
        setDuration(d);
        // The stored length fills the card before the first play. Saved once per item,
        // when it is missing or longer than the real video.
        const c = contentRef.current;
        if (c && videoDurationSavedForRef.current !== c.id) {
          videoDurationSavedForRef.current = c.id;
          const real = Math.floor(d);
          if ((!c.duration || real < c.duration - 2) && !useAuthStore.getState().user?.demo) {
            contentAPI.update(c.id, { duration: real }).catch(() => {});
          }
        }
      }
    } catch { /* player gone */ }
  };

  // The fastest speed YouTube offers that is not above the chosen one (YouTube offers
  // 0.25x to 2x), so a 2.5x choice plays videos at 2x. The button shows the real speed.
  const applyVideoSpeed = (player: YouTubePlayer, wanted: number) => {
    try {
      const rates = player.getAvailablePlaybackRates() || [1];
      const rate = rates.filter(r => r <= wanted).sort((a, b) => b - a)[0] ?? 1;
      player.setPlaybackRate(rate);
      setVideoRate(rate);
    } catch { /* player gone */ }
  };

  // Hold the speed button: 2x while it is held, then the chosen speed again, like YouTube's
  // press and hold. Nothing is saved, and a speed of 2x or more stays as it is.
  const [heldSpeed, setHeldSpeed] = useState<number | null>(null);
  const heldSpeedRef = useRef(false);
  const handleHoldSpeedStart = () => {
    const current = playsVideo ? videoRate : playbackSpeed;
    if (current >= 2) return;
    heldSpeedRef.current = true;
    setHeldSpeed(2);
    if (playsVideo) {
      try { ytPlayerRef.current?.setPlaybackRate(2); } catch { /* player gone */ }
    } else if (audioRef.current) {
      audioRef.current.playbackRate = 2;
    }
  };
  const handleHoldSpeedEnd = () => {
    if (!heldSpeedRef.current) return;
    heldSpeedRef.current = false;
    setHeldSpeed(null);
    if (playsVideo) {
      if (ytPlayerRef.current) applyVideoSpeed(ytPlayerRef.current, getStoredSpeed());
    } else if (audioRef.current) {
      audioRef.current.playbackRate = playbackSpeed;
    }
  };

  const handleVideoReady = (player: YouTubePlayer) => {
    ytPlayerRef.current = player;
    applyVideoSpeed(player, getStoredSpeed());
    // Only the length: the player's clock says 0 until the video plays, and the position
    // to show is videoTimeRef, where the new player starts
    readVideoDuration();
    if (videoPlayPendingRef.current) {
      videoPlayPendingRef.current = false;
      try { player.playVideo(); } catch { /* player gone */ }
    }
  };

  const handleVideoStateChange = (state: number) => {
    if (state === VIDEO_STATE.PLAYING) {
      setIsPlaying(true);
      logChainPlaying('video');
      readVideoTime();
      if (!videoClockRef.current) videoClockRef.current = setInterval(readVideoTime, 250);
    } else if (state === VIDEO_STATE.PAUSED) {
      stopVideoClock();
      readVideoTime();
      setIsPlaying(false);
      savePlaybackPosition(videoTimeRef.current);
    } else if (state === VIDEO_STATE.ENDED) {
      stopVideoClock();
      setIsPlaying(false);
      logPlayback('ended', {
        id: contentRef.current?.id, variant: 'video', t: Math.round(videoTimeRef.current),
        dur: Math.round(durationRef.current), view: isExpandedRef.current ? 'full' : 'mini',
      });
      videoTimeRef.current = 0;
      savePlaybackPosition(0);
      setTimeout(() => onTrackEndedRef.current?.(), 0);
    }
  };

  const handleVideoError = (code: number) => {
    stopVideoClock();
    setIsPlaying(false);
    videoPlayPendingRef.current = false;
    console.warn(`[AudioPlayer] YouTube player error ${code} for item ${contentRef.current?.id}`);
    if (playbackChainOpen()) refusedAutoplay(contentRef.current?.id, `youtube ${code}`);
    setVideoError(
      code === -1 ? 'The YouTube player did not load. Check the connection, or an ad or tracker blocker.'
      : code === 100 ? 'YouTube says this video is private or was removed.'
      : code === 101 || code === 150 ? 'The owner does not allow this video to play outside YouTube.'
      : `YouTube could not play this video here (error ${code}).`
    );
  };

  const handleExpand = () => {
    isExpandedRef.current = true;
    setIsExpanded(true);
  };
  // The video leaves the screen (the player minimizes, or the video is hidden). YouTube
  // allows playback only while the video is visible, so it pauses, and its player is
  // destroyed with its box.
  const pauseVideoLeavingScreen = () => {
    try { ytPlayerRef.current?.pauseVideo(); } catch { /* player gone */ }
    videoPlayPendingRef.current = false;
    // While the summary audio plays, that goes on (the video was paused already)
    if (!playsVideo) return;
    stopVideoClock();
    setIsPlaying(false);
    savePlaybackPosition(videoTimeRef.current);
  };

  // YouTubeVideo destroyed its player (minimized, hidden, or another item opened)
  const handleVideoGone = (player: YouTubePlayer) => {
    if (ytPlayerRef.current === player) ytPlayerRef.current = null;
  };

  const handleMinimize = () => {
    if (isVideoItem) pauseVideoLeavingScreen();
    isExpandedRef.current = false;
    setIsExpanded(false);
  };

  // The whole video box goes full screen, not YouTube's own full-screen mode (its button is
  // off, see YouTubeVideo). YouTube's player just sees a bigger box. A narrow upright
  // screen (a phone, or a folded Fold) turns sideways, as in YouTube's own full screen,
  // where the browser allows it. The phone's back gesture leaves full screen.
  const handleVideoFullscreen = async () => {
    const box = videoBoxRef.current;
    if (!box || document.fullscreenElement) return;
    try {
      await box.requestFullscreen({ navigationUI: 'hide' });
    } catch (err) {
      console.warn('[AudioPlayer] Full screen refused:', err);
      return;
    }
    if (window.innerWidth / window.innerHeight < 0.75) {
      // lock() is missing from TypeScript's DOM types, and some browsers refuse it
      const orientation = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
      orientation.lock?.('landscape').catch(() => { /* the user turns the phone */ });
    }
  };
  useEffect(() => {
    const onChange = () => {
      if (!document.fullscreenElement) {
        try { screen.orientation?.unlock(); } catch { /* nothing was locked */ }
      }
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  // Hide or show the video box. Showing never starts playback, Play does.
  const handleToggleVideo = () => {
    if (videoHiddenRef.current) {
      videoHiddenRef.current = false;
      setVideoHidden(false);
      return;
    }
    pauseVideoLeavingScreen();
    videoHiddenRef.current = true;
    setVideoHidden(true);
  };

  if (!content) return null;

  // Entering an audio-less item must set fullscreen STATE, not just override the
  // render below, otherwise a stale minimized state (from a previously played
  // audio item) kicks in the moment generated audio arrives, collapsing the view
  // to the mini player mid-read. Guarded setState during render converges in one
  // pass (React's sanctioned "adjusting state when props change" pattern).
  // "Audio" here includes summary audio: a summary-audio-only item is playable
  // and gets the mini player like any other audio item. So does a video, which pauses
  // when minimized.
  if (!hasPlayableMedia(content) && !isExpanded) {
    isExpandedRef.current = true;
    setIsExpanded(true);
  }

  return (
    <>
      <audio ref={audioRef} />
      {/* Items without audio only exist in fullscreen, the mini player is pure
          playback chrome (timeline, play button) and would be dead UI for them */}
      {isExpanded || !hasPlayableMedia(content) ? (
        <FullscreenPlayer
          content={content}
          videoHidden={videoHidden}
          onToggleVideo={videoId ? handleToggleVideo : undefined}
          onVideoFullscreen={videoId && !videoHidden && playsVideo ? handleVideoFullscreen : undefined}
          video={videoId && !videoHidden ? (
            <YouTubeVideo
              key={videoId}
              videoId={videoId}
              // On the first render of a newly opened video, the setup effect has not yet
              // moved videoTimeRef to this item, so its saved position counts instead
              startSeconds={lastVideoItemRef.current === content.id ? videoTimeRef.current : (content.playback_position || 0)}
              onReady={handleVideoReady}
              onStateChange={handleVideoStateChange}
              onRateChange={setVideoRate}
              onError={handleVideoError}
              onGone={handleVideoGone}
              boxRef={videoBoxRef}
            />
          ) : null}
          videoError={videoError}
          isPlaying={isPlaying}
          currentTime={currentTime}
          duration={duration}
          playbackSpeed={heldSpeed ?? (playsVideo ? videoRate : playbackSpeed)}
          resumeTargetTime={resumeFailedAt}
          sleepTimer={sleepTimer}
          sleepTimerEndAt={sleepTimerEndAt}
          activeWordIndex={activeWordIndex}
          transcriptWords={parsedTranscriptWords}
          onPlayPause={togglePlay}
          onSeek={handleSeek}
          onSkipBackward={handleSkipBackward}
          onSkipForward={handleSkipForward}
          onSpeedChange={handleSpeedChange}
          onToggleSpeed={toggleSpeed}
          onHoldSpeedStart={handleHoldSpeedStart}
          onHoldSpeedEnd={handleHoldSpeedEnd}
          onSetSleepTimer={setSleepTimerTo}
          playingVariant={effectiveVariant}
          preferSummaryAudio={preferSummaryAudio}
          onTogglePreferSummaryAudio={handleTogglePreferSummaryAudio}
          onSelectAudioVariant={handleSelectAudioVariant}
          onMinimize={handleMinimize}
          onClose={onClose}
          onTranscriptWordClick={handleTranscriptClick}
          onRefetch={onRefetch}
          onGenerateAudio={onGenerateAudio}
          onRemoveAudio={onRemoveAudio}
          onGenerateSummary={onGenerateSummary}
          onRemoveSummary={onRemoveSummary}
          onGenerateSummaryAudio={onGenerateSummaryAudio}
          onRegenerateTranscript={onRegenerateTranscript}
          onCancelGeneration={onCancelGeneration}
          onDismissError={onDismissError}
          onContentUpdated={onContentUpdated}
          themeMode={themeMode || (isDark ? 'dark' : 'light')}
          onCycleTheme={onCycleTheme || (() => {})}
          onSkipNextTrack={onSkipNextTrack}
          onSkipPrevTrack={onSkipPrevTrack}
          hasNextTrack={hasNextTrack}
          hasPrevTrack={hasPrevTrack}
          onPlayQueueItem={onPlayQueueItem}
          initialTab={initialTab}
        />
      ) : (
        <MiniPlayer
          content={content}
          isPlaying={isPlaying}
          currentTime={currentTime}
          duration={duration}
          onPlayPause={togglePlay}
          onSeek={handleSeek}
          onExpand={handleExpand}
          onClose={onClose}
          playingVariant={effectiveVariant}
        />
      )}
    </>
  );
}
