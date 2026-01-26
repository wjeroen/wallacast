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

export function AudioPlayer({ content, onClose, onRefetch }: AudioPlayerProps) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [sleepTimer, setSleepTimer] = useState<number | null>(null);
  const [isExpanded, setIsExpanded] = useState(true);

  const audioRef = useRef<HTMLAudioElement>(null);
  const sleepTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isPlayingRef = useRef(isPlaying);

  // Keep ref in sync with state
  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  // ---------------------------------------------------------------------------
  // DATA PARSING (Robust Fix)
  // ---------------------------------------------------------------------------
  const parsedTranscriptWords = useMemo(() => {
    if (!content?.transcript_words) return [];
    
    let result = content.transcript_words;

    // 1. If it's already an array (PG auto-parsed it), return it
    if (Array.isArray(result)) return result;

    // 2. If it's a string, try to parse it
    if (typeof result === 'string') {
      try {
        const parsed = JSON.parse(result);
        
        // 3. CRITICAL: Check if the RESULT is still a string (Double-JSON case)
        if (typeof parsed === 'string') {
          return JSON.parse(parsed); // Parse again to get the Array
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

      audio.src = content.audio_url || '';
      
      const validSpeeds = [1, 1.25, 1.5, 2];
      const loadedSpeed = content.playback_speed || 1;
      const normalizedSpeed = validSpeeds.includes(loadedSpeed) ? loadedSpeed : 1;
      
      audio.playbackRate = normalizedSpeed;
      setPlaybackSpeed(normalizedSpeed);

      const handleLoadedMetadata = () => {
        if (startPosition > 0) {
          audio.currentTime = startPosition;
          setCurrentTime(startPosition);
        }

        // If duration is missing from database, save it now
        if ((!content.duration || content.duration === 0) && audio.duration && !isNaN(audio.duration) && isFinite(audio.duration)) {
          const durationInSeconds = Math.floor(audio.duration);
          contentAPI.update(content.id, { duration: durationInSeconds } as any).catch((error) => {
            console.error('Failed to save duration:', error);
          });
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

  // Auto-save position every 10 seconds
  useEffect(() => {
    if (!content) return;
    const interval = setInterval(() => {
      if (isPlayingRef.current && audioRef.current) {
        savePlaybackPosition(audioRef.current.currentTime);
      }
    }, 10000);
    return () => clearInterval(interval);
  }, [content]);

  // Save position on unmount
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
    } catch (error) {
      console.error('Failed to save playback position:', error);
    }
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
    if (content) contentAPI.update(content.id, { playback_speed: speed });
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
  // SYNC CALCULATION
  // ---------------------------------------------------------------------------

  const normalizationRatio = useMemo(() => {
    if (parsedTranscriptWords.length === 0 || !duration || duration === 0) return 1;
    const lastWord = parsedTranscriptWords[parsedTranscriptWords.length - 1];
    
    // Ensure lastWord.end is a valid number
    if (lastWord && typeof lastWord.end === 'number' && lastWord.end > 0) {
      return duration / lastWord.end;
    }
    return 1;
  }, [parsedTranscriptWords, duration]);

  const activeWordIndex = useMemo(() => {
    if (!content) return -1;

    // Method 1: Whisper Timestamps (Primary)
    if (parsedTranscriptWords.length > 0) {
      let idx = -1;
      for (let i = 0; i < parsedTranscriptWords.length; i++) {
        // Apply ratio correction
        const wordStart = Number(parsedTranscriptWords[i].start);
        const correctedStart = wordStart * normalizationRatio;
        
        if (correctedStart <= currentTime) {
          idx = i;
        } else {
          break;
        }
      }
      return idx;
    }

    // Method 2: TTS Chunks
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

    // Method 3: Linear Fallback
    const transcript = content.transcript || content.content || '';
    const words = transcript.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().split(/\s+/);
    if (words.length > 0 && duration > 0) {
      return Math.floor((currentTime / duration) * words.length);
    }

    return -1;
  }, [currentTime, content, duration, normalizationRatio, parsedTranscriptWords, parsedTTSChunks]);

  const handleTranscriptClick = (wordIndex: number) => {
    if (!content) return;

    // Method 1 Click
    if (parsedTranscriptWords.length > 0 && wordIndex < parsedTranscriptWords.length) {
      const originalTimestamp = Number(parsedTranscriptWords[wordIndex].start);
      const targetTime = originalTimestamp * normalizationRatio;
      handleSeek(targetTime);
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
