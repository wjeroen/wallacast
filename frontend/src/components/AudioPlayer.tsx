import { useState, useEffect, useRef } from 'react';
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Volume2,
  Clock,
  Gauge,
  X,
} from 'lucide-react';
import type { ContentItem, Comment } from '../types';
import { contentAPI, transcriptionAPI } from '../api';

interface AudioPlayerProps {
  content: ContentItem | null;
  onClose: () => void;
}

export function AudioPlayer({ content, onClose }: AudioPlayerProps) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [volume, setVolume] = useState(1);
  const [showSleepTimer, setShowSleepTimer] = useState(false);
  const [sleepTimer, setSleepTimer] = useState<number | null>(null);
  const [transcript, setTranscript] = useState<string>('');
  const [transcriptWords, setTranscriptWords] = useState<Array<{ word: string; start: number; end: number }> | null>(null);
  const [loadingTranscript, setLoadingTranscript] = useState(false);
  const [showTranscript, setShowTranscript] = useState(true);
  const [transcriptError, setTranscriptError] = useState<string>('');
  const [isAudioReady, setIsAudioReady] = useState(false);

  const audioRef = useRef<HTMLAudioElement>(null);
  const sleepTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const positionSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentContentIdRef = useRef<number | null>(null);

  // Save position immediately when leaving
  useEffect(() => {
    return () => {
      if (content && audioRef.current) {
        savePlaybackPositionImmediate(audioRef.current.currentTime);
      }
    };
  }, [content]);

  // Initialize audio when content changes
  useEffect(() => {
    if (!content || !audioRef.current) return;

    const audio = audioRef.current;
    const contentId = content.id;

    // Skip if this is the same content
    if (currentContentIdRef.current === contentId && isAudioReady) {
      return;
    }

    currentContentIdRef.current = contentId;
    setIsAudioReady(false);
    setIsPlaying(false);

    // Clean up old audio
    audio.pause();
    audio.currentTime = 0;

    // Set up new audio
    audio.src = content.audio_url || '';
    audio.playbackRate = content.playback_speed || 1;
    setPlaybackSpeed(content.playback_speed || 1);

    // Wait for metadata to load, then restore position
    const handleLoadedMetadata = () => {
      setDuration(audio.duration);
      const startPosition = content.playback_position || 0;

      if (startPosition > 0 && startPosition < audio.duration) {
        audio.currentTime = startPosition;
        setCurrentTime(startPosition);
        console.log('✓ Restored position:', startPosition);
      }

      setIsAudioReady(true);
    };

    audio.addEventListener('loadedmetadata', handleLoadedMetadata, { once: true });

    // Transcript setup
    if (content.transcript) {
      setTranscript(content.transcript);
      setTranscriptError('');

      if (content.transcript_words) {
        try {
          const words = typeof content.transcript_words === 'string'
            ? JSON.parse(content.transcript_words)
            : content.transcript_words;
          setTranscriptWords(words);
        } catch (e) {
          console.error('Failed to parse transcript words:', e);
        }
      }
    } else {
      setTranscript('');
      setTranscriptError('');
      setTranscriptWords(null);
    }

    return () => {
      audio.removeEventListener('loadedmetadata', handleLoadedMetadata);
    };
  }, [content?.id]);

  // Audio event listeners (independent of content changes)
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const handleTimeUpdate = () => {
      setCurrentTime(audio.currentTime);
      // Debounced position save
      if (positionSaveTimeoutRef.current) {
        clearTimeout(positionSaveTimeoutRef.current);
      }
      positionSaveTimeoutRef.current = setTimeout(() => {
        if (content) {
          savePlaybackPositionImmediate(audio.currentTime);
        }
      }, 2000);
    };

    const handleEnded = () => {
      setIsPlaying(false);
      if (content) {
        savePlaybackPositionImmediate(0);
      }
    };

    const handlePlay = () => setIsPlaying(true);
    const handlePause = () => setIsPlaying(false);

    audio.addEventListener('timeupdate', handleTimeUpdate);
    audio.addEventListener('ended', handleEnded);
    audio.addEventListener('play', handlePlay);
    audio.addEventListener('pause', handlePause);

    return () => {
      audio.removeEventListener('timeupdate', handleTimeUpdate);
      audio.removeEventListener('ended', handleEnded);
      audio.removeEventListener('play', handlePlay);
      audio.removeEventListener('pause', handlePause);

      if (positionSaveTimeoutRef.current) {
        clearTimeout(positionSaveTimeoutRef.current);
      }
    };
  }, [content]);

  const savePlaybackPositionImmediate = async (position: number) => {
    if (!content) return;

    try {
      await contentAPI.update(content.id, {
        playback_position: Math.floor(position),
        last_played_at: new Date().toISOString(),
      });
      console.log('✓ Saved position:', Math.floor(position));
    } catch (error) {
      console.error('Failed to save playback position:', error);
    }
  };

  const loadTranscript = async () => {
    if (!content) return;

    setLoadingTranscript(true);
    setTranscriptError('');
    try {
      const response = await transcriptionAPI.transcribe(content.id);
      setTranscript(response.data.transcript);
      setTranscriptWords(response.data.words || null);
    } catch (error: any) {
      console.error('Failed to load transcript:', error);
      const errorMsg = error?.response?.data?.details || error?.response?.data?.error || 'Failed to generate transcript. Please check your API key.';
      setTranscriptError(errorMsg);
    } finally {
      setLoadingTranscript(false);
    }
  };

  const togglePlay = async () => {
    if (!audioRef.current || !isAudioReady) return;

    try {
      if (isPlaying) {
        audioRef.current.pause();
      } else {
        await audioRef.current.play();
      }
    } catch (error) {
      console.error('Play/pause error:', error);
      setIsPlaying(false);
    }
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

  const handleVolumeChange = (vol: number) => {
    if (!audioRef.current) return;
    audioRef.current.volume = vol;
    setVolume(vol);
  };

  const setSleepTimerMinutes = (minutes: number) => {
    if (sleepTimerRef.current) {
      clearTimeout(sleepTimerRef.current);
    }

    setSleepTimer(minutes);
    setShowSleepTimer(false);

    sleepTimerRef.current = setTimeout(() => {
      if (audioRef.current) {
        audioRef.current.pause();
        setIsPlaying(false);
      }
      setSleepTimer(null);
    }, minutes * 60 * 1000);
  };

  const handleTranscriptClick = (wordIndex: number) => {
    if (!content) return;

    // Method 1: Use word-level timestamps from Whisper (most accurate)
    if (transcriptWords && transcriptWords.length > 0 && wordIndex < transcriptWords.length) {
      const timestamp = transcriptWords[wordIndex].start;
      console.log('Using word timestamp:', { wordIndex, timestamp });
      handleSeek(timestamp);
      return;
    }

    // Method 2: Use TTS chunk metadata for articles (accurate per-chunk)
    if (content.tts_chunks) {
      try {
        const chunks = JSON.parse(content.tts_chunks as any);
        // Find which chunk contains this word
        for (const chunk of chunks) {
          if (wordIndex >= chunk.startWord && wordIndex <= chunk.endWord) {
            // Interpolate within this chunk
            const wordPosInChunk = wordIndex - chunk.startWord;
            const wordsInChunk = chunk.endWord - chunk.startWord + 1;
            const positionInChunk = (wordPosInChunk / wordsInChunk) * chunk.duration;
            const timestamp = chunk.startTime + positionInChunk;
            console.log('Using TTS chunk interpolation:', { wordIndex, chunk: chunks.indexOf(chunk), timestamp });
            handleSeek(timestamp);
            return;
          }
        }
      } catch (error) {
        console.error('Failed to parse TTS chunks:', error);
      }
    }

    // Method 3: Fallback - estimate based on word position (least accurate)
    if (duration > 0 && content.content) {
      const allText = content.content;
      const words = allText.split(/\s+/);
      if (wordIndex < words.length) {
        const estimatedTime = (wordIndex / words.length) * duration;
        console.log('Using word position estimate:', { wordIndex, total: words.length, estimatedTime });
        handleSeek(estimatedTime);
      }
    }
  };

  const formatTime = (seconds: number): string => {
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hours > 0) {
      return `${hours}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const renderComments = (comments: Comment[], depth: number = 0) => {
    return comments.map((comment, index) => (
      <div key={index} style={{ marginLeft: `${depth * 20}px`, marginBottom: '1rem' }}>
        <div style={{ fontWeight: 'bold', marginBottom: '0.25rem' }}>
          {comment.username}
          {comment.date && ` • ${comment.date}`}
          {(comment.karma !== undefined || comment.agree_votes !== undefined || comment.disagree_votes !== undefined) && (
            <span style={{ fontWeight: 'normal', color: '#666', marginLeft: '8px' }}>
              {comment.karma !== undefined && `${comment.karma} karma`}
              {comment.agree_votes !== undefined && ` • ${comment.agree_votes} agree`}
              {comment.disagree_votes !== undefined && ` • ${comment.disagree_votes} disagree`}
            </span>
          )}
        </div>
        <div style={{ marginBottom: '0.5rem' }}>{comment.content}</div>
        {comment.replies && comment.replies.length > 0 && renderComments(comment.replies, depth + 1)}
      </div>
    ));
  };

  const getHighlightedTranscript = () => {
    if (!transcript) return null;

    const words = transcript.split(/\s+/);
    let currentWordIndex = 0;

    // If we have word-level timestamps, find the current word
    if (transcriptWords && transcriptWords.length > 0) {
      currentWordIndex = transcriptWords.findIndex(
        (w) => currentTime >= w.start && currentTime < w.end
      );
      if (currentWordIndex === -1) {
        // Find the closest word
        currentWordIndex = transcriptWords.findIndex((w) => w.start > currentTime) - 1;
      }
    } else {
      // Estimate based on time and total words
      currentWordIndex = Math.floor((currentTime / duration) * words.length);
    }

    return (
      <div style={{ lineHeight: '1.8' }}>
        {words.map((word, index) => (
          <span
            key={index}
            onClick={() => handleTranscriptClick(index)}
            style={{
              backgroundColor: index === currentWordIndex ? '#4CAF50' : 'transparent',
              color: index === currentWordIndex ? 'white' : 'inherit',
              padding: '2px 4px',
              margin: '0 2px',
              borderRadius: '3px',
              cursor: 'pointer',
              transition: 'all 0.2s',
            }}
            onMouseOver={(e) => {
              if (index !== currentWordIndex) {
                e.currentTarget.style.backgroundColor = '#e0e0e0';
              }
            }}
            onMouseOut={(e) => {
              if (index !== currentWordIndex) {
                e.currentTarget.style.backgroundColor = 'transparent';
              }
            }}
          >
            {word}
          </span>
        ))}
      </div>
    );
  };

  if (!content) return null;

  // Parse structured comments if available
  let structuredComments: Comment[] | undefined;
  if (content.comments) {
    try {
      structuredComments = typeof content.comments === 'string'
        ? JSON.parse(content.comments)
        : content.comments;
    } catch (e) {
      console.error('Failed to parse comments:', e);
    }
  }

  return (
    <div className="audio-player">
      <div className="audio-player-header">
        <h2>{content.title}</h2>
        <button onClick={onClose} className="close-button">
          <X size={24} />
        </button>
      </div>

      <audio ref={audioRef} />

      <div className="audio-controls">
        <div className="progress-bar">
          <input
            type="range"
            min="0"
            max={duration || 0}
            value={currentTime}
            onChange={(e) => handleSeek(Number(e.target.value))}
            disabled={!isAudioReady}
          />
          <div className="time-display">
            <span>{formatTime(currentTime)}</span>
            <span>{formatTime(duration)}</span>
          </div>
        </div>

        <div className="playback-controls">
          <button onClick={handleSkipBackward} disabled={!isAudioReady}>
            <SkipBack size={24} />
          </button>
          <button
            onClick={togglePlay}
            className="play-button"
            disabled={!isAudioReady}
          >
            {isPlaying ? <Pause size={32} /> : <Play size={32} />}
          </button>
          <button onClick={handleSkipForward} disabled={!isAudioReady}>
            <SkipForward size={24} />
          </button>
        </div>

        <div className="secondary-controls">
          <div className="volume-control">
            <Volume2 size={20} />
            <input
              type="range"
              min="0"
              max="1"
              step="0.1"
              value={volume}
              onChange={(e) => handleVolumeChange(Number(e.target.value))}
            />
          </div>

          <button onClick={toggleSpeed} className="speed-button">
            <Gauge size={20} />
            <span>{playbackSpeed}x</span>
          </button>

          <div className="sleep-timer">
            <button onClick={() => setShowSleepTimer(!showSleepTimer)}>
              <Clock size={20} />
              {sleepTimer && <span>{sleepTimer}m</span>}
            </button>
            {showSleepTimer && (
              <div className="sleep-timer-options">
                {[5, 15, 30, 60].map((mins) => (
                  <button key={mins} onClick={() => setSleepTimerMinutes(mins)}>
                    {mins}m
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="audio-content">
        <div className="content-tabs">
          <button
            className={showTranscript ? 'active' : ''}
            onClick={() => setShowTranscript(true)}
          >
            {content.type === 'podcast_episode' ? 'Transcript' : 'Content'}
          </button>
          {structuredComments && structuredComments.length > 0 && (
            <button
              className={!showTranscript ? 'active' : ''}
              onClick={() => setShowTranscript(false)}
            >
              Comments ({structuredComments.length})
            </button>
          )}
        </div>

        <div className="content-display">
          {showTranscript ? (
            <div className="transcript">
              {transcript ? (
                getHighlightedTranscript()
              ) : content.content ? (
                <div dangerouslySetInnerHTML={{ __html: content.content }} />
              ) : transcriptError ? (
                <div className="error">{transcriptError}</div>
              ) : (
                <div>
                  <p>No transcript available.</p>
                  {content.type === 'podcast_episode' && (
                    <button onClick={loadTranscript} disabled={loadingTranscript}>
                      {loadingTranscript ? 'Generating transcript...' : 'Generate Transcript'}
                    </button>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="comments">
              {structuredComments && renderComments(structuredComments)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
