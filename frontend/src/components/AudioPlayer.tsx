import { useState, useEffect, useRef, useMemo } from 'react';
import type { ContentItem } from '../types';
import { contentAPI } from '../api';
import { MiniPlayer } from './MiniPlayer';
import { FullscreenPlayer } from './FullscreenPlayer';

interface AudioPlayerProps {
  content: ContentItem | null;
  onClose: () => void;
  onRefetch?: () => void;
}

// Load global playback speed from localStorage
const loadGlobalSpeed = (): number => {
  const saved = localStorage.getItem('globalPlaybackSpeed');
  if (!saved) return 1;

  const parsed = parseFloat(saved);
  const validSpeeds = [1, 1.25, 1.5, 2];
  return validSpeeds.includes(parsed) ? parsed : 1;
};

// Save global playback speed to localStorage
const saveGlobalSpeed = (speed: number) => {
  localStorage.setItem('globalPlaybackSpeed', speed.toString());
};

export function AudioPlayer({ content, onClose, onRefetch }: AudioPlayerProps) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackSpeed, setPlaybackSpeed] = useState(loadGlobalSpeed());
  const [sleepTimer, setSleepTimer] = useState<number | null>(null);
  const [isExpanded, setIsExpanded] = useState(true);

  const audioRef = useRef<HTMLAudioElement>(null);
  const sleepTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isPlayingRef = useRef(isPlaying);

  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

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

      // Cache busting to ensure we aren't playing an old file
      const cacheBuster = content.updated_at
        ? new Date(content.updated_at).getTime()
        : Date.now();
      const separator = content.audio_url?.includes('?') ? '&' : '?';
      audio.src = content.audio_url ? `${content.audio_url}${separator}t=${cacheBuster}` : '';

      // Use global speed preference (stored in state which loaded from localStorage)
      audio.playbackRate = playbackSpeed;

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
  }, [content, playbackSpeed]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const handleTimeUpdate = () => setCurrentTime(audio.currentTime);
    const handleLoadedMetadata = () => setDuration(audio.duration);
    const handleEnded = () => {
      setIsPlaying(false);
      savePlaybackPosition(0);
    };

    audio.addEventListener('timeupdate', handleTimeUpdate);
    audio.addEventListener('loadedmetadata', handleLoadedMetadata);
    audio.addEventListener('ended', handleEnded);

    return () => {
      audio.removeEventListener('timeupdate', handleTimeUpdate);
      audio.removeEventListener('loadedmetadata', handleLoadedMetadata);
      audio.removeEventListener('ended', handleEnded);
    };
  }, []);

  // Auto-save position
  useEffect(() => {
    if (!content) return;
    const interval = setInterval(() => {
      if (isPlayingRef.current && audioRef.current) {
        savePlaybackPosition(audioRef.current.currentTime);
      }
    }, 10000);
    return () => clearInterval(interval);
  }, [content]);

  useEffect(() => {
    return () => {
      if (audioRef.current && content) {
        savePlaybackPosition(audioRef.current.currentTime);
      }
    };
  }, [content]);

  const savePlaybackPosition = async (position: number) => {
    if (!content) return;
    try {
      await contentAPI.update(content.id, {
        playback_position: Math.floor(position),
        last_played_at: new Date().toISOString(),
      });
    } catch (error) { /* silent */ }
  };

  const togglePlay = () => {
    if (!audioRef.current) return;
    if (isPlaying) {
      savePlaybackPosition(audioRef.current.currentTime);
      audioRef.current.pause();
    } else {
      audioRef.current.play();
    }
    setIsPlaying(!isPlaying);
  };

  const handleSeek = (time: number) => {
    if (!audioRef.current) return;
    audioRef.current.currentTime = time;
    setCurrentTime(time);
  };

  const handleSkipBackward = () => handleSeek(Math.max(0, currentTime - 15));
  const handleSkipForward = () => handleSeek(Math.min(duration, currentTime + 30));

  const handleSpeedChange = (speed: number) => {
    if (!audioRef.current) return;
    audioRef.current.playbackRate = speed;
    setPlaybackSpeed(speed);
    saveGlobalSpeed(speed);
  };

  const toggleSpeed = () => {
    const speeds = [1, 1.25, 1.5, 2];
    const currentIndex = speeds.indexOf(playbackSpeed);
    const nextIndex = (currentIndex + 1) % speeds.length;
    handleSpeedChange(speeds[nextIndex]);
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
