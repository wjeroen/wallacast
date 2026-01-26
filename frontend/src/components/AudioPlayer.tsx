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
  const [isExpanded, setIsExpanded] = useState(true); // Open fullscreen by default

  const audioRef = useRef<HTMLAudioElement>(null);
  const sleepTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isPlayingRef = useRef(isPlaying);

  // Keep ref in sync with state
  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  // ---------------------------------------------------------------------------
  // DATA PREPARATION & PARSING
  // ---------------------------------------------------------------------------

  // Parse transcript_words safely (handles both Array and JSON string from DB)
  const parsedTranscriptWords = useMemo(() => {
    if (!content?.transcript_words) return [];
    if (Array.isArray(content.transcript_words)) return content.transcript_words;
    try {
      return typeof content.transcript_words === 'string'
        ? JSON.parse(content.transcript_words)
        : [];
    } catch (e) {
      console.error('[AudioPlayer] Failed to parse transcript_words:', e);
      return [];
    }
  }, [content?.transcript_words]);

  // Parse tts_chunks safely
  const parsedTTSChunks = useMemo(() => {
    if (!content?.tts_chunks) return [];
    if (Array.isArray(content.tts_chunks)) return content.tts_chunks;
    try {
      return typeof content.tts_chunks === 'string'
        ? JSON.parse(content.tts_chunks)
        : [];
    } catch (e) {
      console.error('[AudioPlayer] Failed to parse tts_chunks:', e);
      return [];
    }
  }, [content?.tts_chunks]);

  // Debug Logging for Hypothesis Verification
  useEffect(() => {
    if (content) {
      console.groupCollapsed(`[AudioPlayer] Loaded Content: ${content.id}`);
      console.log('Raw transcript_words type:', typeof content.transcript_words);
      console.log('Parsed transcript_words length:', parsedTranscriptWords.length);
      console.log('Raw tts_chunks type:', typeof content.tts_chunks);
      console.log('Parsed tts_chunks length:', parsedTTSChunks.length);
      
      if (parsedTranscriptWords.length > 0) {
        console.log('✅ Method 1 (Whisper) Available');
        const lastWord = parsedTranscriptWords[parsedTranscriptWords.length - 1];
        console.log('   Whisper Duration:', lastWord.end);
      } else {
        console.warn('❌ Method 1 (Whisper) Unavailable (parsed array is empty)');
      }

      if (parsedTTSChunks.length > 0) {
        console.log('✅ Method 2 (TTS Chunks) Available');
      } else {
        console.warn('❌ Method 2 (TTS Chunks) Unavailable');
      }
      
      console.groupEnd();
    }
  }, [content, parsedTranscriptWords, parsedTTSChunks]);

  // ---------------------------------------------------------------------------
  // AUDIO SETUP
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (!content) return;

    if (audioRef.current) {
      const audio = audioRef.current;
      const startPosition = content.playback_position || 0;

      audio.src = content.audio_url || '';
      // Ensure playback speed is one of the valid values
      const validSpeeds = [1, 1.25, 1.5, 2];
      const loadedSpeed = content.playback_speed || 1;
      const normalizedSpeed = validSpeeds.includes(loadedSpeed) ? loadedSpeed : 1;
      
      audio.playbackRate = normalizedSpeed;
      setPlaybackSpeed(normalizedSpeed);

      // Wait for metadata to load before setting position
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

  // Auto-save position every 10 seconds during playback
  useEffect(() => {
    if (!content) return;

    const interval = setInterval(() => {
      if (isPlayingRef.current && audioRef.current) {
        savePlaybackPosition(audioRef.current.currentTime);
      }
    }, 10000);

    return () => clearInterval(interval);
  }, [content]);

  // Save position on component unmount (user closes player or switches content)
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
      // Save position before pausing
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

  const handleSkipBackward = () => {
    handleSeek(Math.max(0, currentTime - 15));
  };

  const handleSkipForward = () => {
    handleSeek(Math.min(duration, currentTime + 30));
  };

  const handleSpeedChange = (speed: number) => {
    if (!audioRef.current) return;
    audioRef.current.playbackRate = speed;
    setPlaybackSpeed(speed);
    if (content) {
      contentAPI.update(content.id, { playback_speed: speed });
    }
  };

  const toggleSpeed = () => {
    const speeds = [1, 1.25, 1.5, 2];
    const currentIndex = speeds.indexOf(playbackSpeed);
    const nextIndex = (currentIndex + 1) % speeds.length;
    handleSpeedChange(speeds[nextIndex]);
  };

  const toggleSleepTimer = () => {
    // Clear existing timer if any
    if (sleepTimerRef.current) {
      clearTimeout(sleepTimerRef.current);
      sleepTimerRef.current = null;
    }

    // Cycle through: null → 5 → 10 → 15 → 30 → 45 → 60 → null
    const timerOptions = [5, 10, 15, 30, 45, 60];
    
    if (sleepTimer === null) {
      // Start with 5 minutes
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
        // Last option, turn off
        setSleepTimer(null);
      } else {
        // Go to next option
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
  // SYNC LOGIC
  // ---------------------------------------------------------------------------

  // CALCULATE DRIFT CORRECTION RATIO
  // If the transcript end time !== audio duration, we stretch/shrink the transcript to fit.
  const normalizationRatio = useMemo(() => {
    if (parsedTranscriptWords.length === 0 || !duration || duration === 0) return 1;
    
    // Check Whisper Method
    const lastWord = parsedTranscriptWords[parsedTranscriptWords.length - 1];
    if (lastWord.end > 0) {
      // e.g. Audio is 300s, Transcript is 290s. Ratio = 1.034.
      // We multiply transcript timestamps by 1.034 to sync them.
      return duration / lastWord.end;
    }
    return 1;
  }, [parsedTranscriptWords, duration]);

  const activeWordIndex = useMemo(() => {
    if (!content) return -1;

    // Method 1: Whisper timestamps with Rubber Band Normalization
    if (parsedTranscriptWords.length > 0) {
      let idx = -1;
      for (let i = 0; i < parsedTranscriptWords.length; i++) {
        // Normalize the word's start time to match actual audio duration
        const correctedStart = parsedTranscriptWords[i].start * normalizationRatio;
        
        if (correctedStart <= currentTime) {
          idx = i;
        } else {
          break;
        }
      }
      return idx;
    }

    // Method 2: TTS Chunk interpolation (Usually reliable, no normalization needed)
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
      } catch (e) {
        console.error('Method 2 Error:', e);
      }
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

    // Method 1: Whisper timestamps with Normalization
    if (parsedTranscriptWords.length > 0 && wordIndex < parsedTranscriptWords.length) {
      const originalTimestamp = parsedTranscriptWords[wordIndex].start;
      // Apply the same ratio in reverse (stretch the timestamp to find the point in the actual audio)
      const targetTime = originalTimestamp * normalizationRatio;
      
      console.log('Using normalized timestamp (Method 1):', { 
        wordIndex, 
        originalTimestamp, 
        normalizationRatio, 
        targetTime 
      });
      
      handleSeek(targetTime);
      return;
    }

    // Method 2: TTS Chunk interpolation
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
      } catch (error) {
        console.error('Failed to parse TTS chunks (Method 2 click):', error);
      }
    }

    // Method 3: Linear Fallback
    const transcript = content.transcript || content.content || '';
    const words = transcript.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().split(/\s+/);
    const estimatedPosition = (wordIndex / words.length) * duration;
    handleSeek(estimatedPosition);
  };

  const handleExpand = () => {
    setIsExpanded(true);
  };

  const handleMinimize = () => {
    setIsExpanded(false);
  };

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
