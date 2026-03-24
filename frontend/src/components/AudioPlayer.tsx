import { useState, useEffect, useRef, useMemo } from 'react';
import type { ContentItem } from '../types';
import { contentAPI, userSettingsAPI } from '../api';
import { MiniPlayer } from './MiniPlayer';
import { FullscreenPlayer } from './FullscreenPlayer';

const VALID_SPEEDS = [1, 1.25, 1.5, 1.75, 2];

function getStoredSpeed(): number {
  const stored = localStorage.getItem('playbackSpeed');
  if (stored) {
    const parsed = parseFloat(stored);
    if (VALID_SPEEDS.includes(parsed)) return parsed;
  }
  return 1;
}

interface AudioPlayerProps {
  content: ContentItem | null;
  onClose: () => void;
  onRefetch?: () => void;
  onGenerateAudio?: (regenerate: boolean) => void;
  onRemoveAudio?: () => void;
  onRegenerateTranscript?: () => void;
  onContentUpdated?: (updated: ContentItem) => void;
}

export function AudioPlayer({ content, onClose, onRefetch, onGenerateAudio, onRemoveAudio, onRegenerateTranscript, onContentUpdated }: AudioPlayerProps) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackSpeed, setPlaybackSpeed] = useState(getStoredSpeed);
  const [sleepTimer, setSleepTimer] = useState<number | null>(null);
  const [isExpanded, setIsExpanded] = useState(true);

  const audioRef = useRef<HTMLAudioElement>(null);
  const sleepTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isPlayingRef = useRef(isPlaying);
  const lastSavedPositionRef = useRef<number>(-1);
  // Tracks whether the user explicitly paused via the app UI. Used to block
  // OS-initiated plays (e.g. iOS re-routing audio to speaker on disconnect).
  const userPausedRef = useRef(false);
  // Timestamp of the last pause event — used to debounce rogue play events
  // from Sony headphone wear sensors (PAUSE→PLAY flicker on removal, ~100ms).
  // Intentional hardware play (smartwatch tap, headphone button) takes >1s.
  const lastPauseTimeRef = useRef<number>(0);
  // Set to true right before an app-initiated play() call so handlePlay can
  // distinguish it from hardware/OS-initiated plays (which need debouncing).
  const appPlayRef = useRef(false);
  // Mirrors the current content prop so permanent event handlers (with [] deps)
  // always see the up-to-date item without needing to be re-registered.
  const contentRef = useRef(content);

  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  useEffect(() => {
    contentRef.current = content;
  }, [content]);

  // Reset user-pause intent when switching to a new item
  useEffect(() => {
    userPausedRef.current = false;
  }, [content?.id]);

  // Sync speed from backend on mount (for cross-device persistence)
  useEffect(() => {
    userSettingsAPI.get('playback_speed').then(res => {
      const val = res.data.value ? parseFloat(res.data.value) : null;
      if (val && VALID_SPEEDS.includes(val)) {
        localStorage.setItem('playbackSpeed', String(val));
        setPlaybackSpeed(val);
        if (audioRef.current) {
          audioRef.current.playbackRate = val;
        }
      }
    }).catch(() => {});
  }, []);

  // ---------------------------------------------------------------------------
  // 1. ROBUST DATA PARSING (Fixes the "Fallback to Linear" issue)
  // ---------------------------------------------------------------------------
  const parsedTranscriptWords = useMemo(() => {
    if (!content?.transcript_words) return [];
    
    let result = content.transcript_words;

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
    } catch (e) {
      return [];
    }
  }, [content?.tts_chunks]);

  // ---------------------------------------------------------------------------
  // AUDIO SETUP
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!content) return;

    if (audioRef.current) {
      const audio = audioRef.current;
      const startPosition = content.playback_position || 0;

      // Podcast episodes are proxied through our own backend to avoid CORS issues
      // with external CDNs (e.g. api.substack.com blocks browser range requests).
      // The backend forwards Range headers byte-for-byte so only requested chunks
      // are fetched from upstream — no full-file downloads.
      // Articles/texts use their stored audio_url (already our /api endpoint) with
      // a cache-buster to force the browser to re-fetch when audio is regenerated.
      let audioSrc: string;
      if (content.type === 'podcast_episode') {
        const apiBase = import.meta.env.VITE_API_URL as string || 'http://localhost:3001/api';
        audioSrc = `${apiBase}/content/${content.id}/audio`;
      } else if (content.audio_url) {
        const cacheBuster = `${content.file_size || 0}-${content.duration || 0}`;
        const separator = content.audio_url.includes('?') ? '&' : '?';
        audioSrc = `${content.audio_url}${separator}v=${cacheBuster}`;
      } else {
        audioSrc = '';
      }
      audio.src = audioSrc;
      
      // Use global speed from localStorage (instant, no API call needed)
      const storedSpeed = getStoredSpeed();
      audio.playbackRate = storedSpeed;
      setPlaybackSpeed(storedSpeed);

      const handleLoadedMetadata = () => {
        if (startPosition > 0) {
          audio.currentTime = startPosition;
          setCurrentTime(startPosition);
        }
        // We still save duration for the UI progress bar, but we won't use it for sync
        if ((!content.duration || content.duration === 0) && audio.duration && !isNaN(audio.duration) && isFinite(audio.duration)) {
          const durationInSeconds = Math.floor(audio.duration);
          contentAPI.update(content.id, { duration: durationInSeconds } as any).catch(() => {});
        }
        audio.removeEventListener('loadedmetadata', handleLoadedMetadata);
      };

      audio.addEventListener('loadedmetadata', handleLoadedMetadata);
    }
  }, [content]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const handleTimeUpdate = () => setCurrentTime(audio.currentTime);
    const handleLoadedMetadata = () => setDuration(audio.duration);
    const handleEnded = () => {
      setIsPlaying(false);
      userPausedRef.current = false; // natural end — reset intent
      savePlaybackPosition(0);
    };
    // Sync React state with actual DOM audio state.
    // Three guards run in order to decide whether to accept an incoming play:
    //  1. appPlayRef — app-initiated plays (togglePlay) always pass immediately.
    //  2. userPausedRef — explicit UI pause blocks OS-initiated resumes.
    //  3. Debounce — blocks rogue play events that arrive within 800ms of a
    //     pause (Sony headphone wear-sensor flicker on removal: PAUSE→PLAY
    //     in ~100ms). Intentional hardware plays (smartwatch, headphone
    //     button) take >1s and pass through.
    const handlePlay = () => {
      // App-initiated play (from togglePlay) — always allow immediately
      if (appPlayRef.current) {
        appPlayRef.current = false;
        setIsPlaying(true);
        return;
      }
      // Explicit user pause via app UI — block OS-initiated resumes
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
    };
    const handlePause = () => {
      lastPauseTimeRef.current = Date.now();
      setIsPlaying(false);
    };
    // Audio load/playback error — reset icon and report to backend for Railway logging.
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

    audio.addEventListener('timeupdate', handleTimeUpdate);
    audio.addEventListener('loadedmetadata', handleLoadedMetadata);
    audio.addEventListener('ended', handleEnded);
    audio.addEventListener('play', handlePlay);
    audio.addEventListener('pause', handlePause);
    audio.addEventListener('error', handleError);

    return () => {
      audio.removeEventListener('timeupdate', handleTimeUpdate);
      audio.removeEventListener('loadedmetadata', handleLoadedMetadata);
      audio.removeEventListener('ended', handleEnded);
      audio.removeEventListener('play', handlePlay);
      audio.removeEventListener('pause', handlePause);
      audio.removeEventListener('error', handleError);
    };
  }, []);

  const savePlaybackPosition = async (position: number) => {
    if (!content) return;
    const floored = Math.floor(position);
    // Skip save if position hasn't changed by at least 3 seconds (debounce)
    if (lastSavedPositionRef.current >= 0 && Math.abs(floored - lastSavedPositionRef.current) < 3) {
      return;
    }
    lastSavedPositionRef.current = floored;
    try {
      await contentAPI.update(content.id, {
        playback_position: floored,
        last_played_at: new Date().toISOString(),
      });
    } catch (error) { /* silent */ }
  };

  // Auto-save position every 10s during playback
  // Depends on content?.id (not content) to prevent duplicate save/teardown
  // when the content object reference changes but the item is the same
  useEffect(() => {
    if (!content?.id) return;
    lastSavedPositionRef.current = -1; // Reset debounce on content change
    const interval = setInterval(() => {
      if (isPlayingRef.current && audioRef.current) {
        savePlaybackPosition(audioRef.current.currentTime);
      }
    }, 10000);
    return () => clearInterval(interval);
  }, [content?.id]);

  // Save position on unmount or content change
  useEffect(() => {
    return () => {
      if (audioRef.current && content) {
        // Force save on unmount regardless of debounce
        const floored = Math.floor(audioRef.current.currentTime);
        contentAPI.update(content.id, {
          playback_position: floored,
          last_played_at: new Date().toISOString(),
        }).catch(() => {});
      }
    };
  }, [content?.id]);

  const togglePlay = () => {
    if (!audioRef.current) return;
    if (isPlaying) {
      userPausedRef.current = true; // explicit user pause — block OS-initiated resumes
      savePlaybackPosition(audioRef.current.currentTime);
      audioRef.current.pause();
      // State update handled by the 'pause' DOM event listener
    } else {
      userPausedRef.current = false; // explicit user play — allow plays again
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
    if (!audioRef.current) return;
    audioRef.current.currentTime = time;
    setCurrentTime(time);
  };

  const handleSkipBackward = () => handleSeek(Math.max(0, currentTime - 15));
  const handleSkipForward = () => handleSeek(Math.min(duration, currentTime + 15));

  const handleSpeedChange = (speed: number) => {
    if (!audioRef.current) return;
    audioRef.current.playbackRate = speed;
    setPlaybackSpeed(speed);
    // Save globally: localStorage for instant recall, backend for cross-device sync
    localStorage.setItem('playbackSpeed', String(speed));
    userSettingsAPI.set('playback_speed', String(speed)).catch(() => {});
  };

  const toggleSpeed = () => {
    const currentIndex = VALID_SPEEDS.indexOf(playbackSpeed);
    const nextIndex = (currentIndex + 1) % VALID_SPEEDS.length;
    handleSpeedChange(VALID_SPEEDS[nextIndex]);
  };

  const toggleSleepTimer = () => {
    if (sleepTimerRef.current) {
      clearTimeout(sleepTimerRef.current);
      sleepTimerRef.current = null;
    }

    const timerOptions = [5, 10, 15, 30, 45, 60];
    if (sleepTimer === null) {
      setSleepTimer(5);
      sleepTimerRef.current = setTimeout(() => {
        if (audioRef.current) {
          audioRef.current.pause();
          setIsPlaying(false);
        }
        setSleepTimer(null);
      }, 5 * 60 * 1000);
    } else {
      const currentIndex = timerOptions.indexOf(sleepTimer);
      if (currentIndex === timerOptions.length - 1) {
        setSleepTimer(null);
      } else {
        const nextTimer = timerOptions[currentIndex + 1];
        setSleepTimer(nextTimer);
        sleepTimerRef.current = setTimeout(() => {
          if (audioRef.current) {
            audioRef.current.pause();
            setIsPlaying(false);
          }
          setSleepTimer(null);
        }, nextTimer * 60 * 1000);
      }
    }
  };

  // ---------------------------------------------------------------------------
  // SYNC LOGIC (The Fix: NO Normalization)
  // ---------------------------------------------------------------------------

  const activeWordIndex = useMemo(() => {
    if (!content) return -1;

    // Method 1: Whisper Timestamps (TRUSTED)
    // We ignore the browser's duration estimate completely for sync.
    if (parsedTranscriptWords.length > 0) {
      let idx = -1;
      
      // Optimization: Start search from the last known index if available (omitted for simplicity)
      // Binary search could be better, but linear is fine for <10k words
      for (let i = 0; i < parsedTranscriptWords.length; i++) {
        const wordStart = Number(parsedTranscriptWords[i].start);
        
        // Strict comparison against RAW timestamps
        if (wordStart <= currentTime) {
          idx = i;
        } else {
          // As soon as we find a word in the future, we stop.
          // The current 'idx' is the last word that passed the check.
          break;
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
      } catch (e) { /* ignore */ }
    }

    // Method 3: Linear Fallback (Last Resort)
    const transcript = content.transcript || content.content || '';
    const words = transcript.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().split(/\s+/);
    if (words.length > 0 && duration > 0) {
      return Math.floor((currentTime / duration) * words.length);
    }

    return -1;
  }, [currentTime, content, duration, parsedTranscriptWords, parsedTTSChunks]);

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
      } catch (e) { /* ignore */ }
    }

    // Method 3 Click
    const transcript = content.transcript || content.content || '';
    const words = transcript.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().split(/\s+/);
    const estimatedPosition = (wordIndex / words.length) * duration;
    handleSeek(estimatedPosition);
  };

  const handleExpand = () => setIsExpanded(true);
  const handleMinimize = () => setIsExpanded(false);

  if (!content) return null;

  return (
    <>
      <audio ref={audioRef} />
      {isExpanded ? (
        <FullscreenPlayer
          content={content}
          isPlaying={isPlaying}
          currentTime={currentTime}
          duration={duration}
          playbackSpeed={playbackSpeed}
          sleepTimer={sleepTimer}
          activeWordIndex={activeWordIndex}
          transcriptWords={parsedTranscriptWords}
          onPlayPause={togglePlay}
          onSeek={handleSeek}
          onSkipBackward={handleSkipBackward}
          onSkipForward={handleSkipForward}
          onSpeedChange={handleSpeedChange}
          onToggleSpeed={toggleSpeed}
          onToggleSleepTimer={toggleSleepTimer}
          onMinimize={handleMinimize}
          onClose={onClose}
          onTranscriptWordClick={handleTranscriptClick}
          onRefetch={onRefetch}
          onGenerateAudio={onGenerateAudio}
          onRemoveAudio={onRemoveAudio}
          onRegenerateTranscript={onRegenerateTranscript}
          onContentUpdated={onContentUpdated}
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
        />
      )}
    </>
  );
}
