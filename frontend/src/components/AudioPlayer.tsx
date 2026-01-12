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
  console.log('AudioPlayer render:', {
    hasContent: !!content,
    contentId: content?.id,
    hasAudioUrl: !!content?.audio_url,
    title: content?.title
  });

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

    // Check if audio URL exists
    if (!content.audio_url) {
      console.warn('No audio URL available for content:', content.id);
      setDuration(0);
      setIsAudioReady(false);
      return; // Don't set up audio if no URL
    }

    // Set up new audio
    audio.src = content.audio_url;
    audio.playbackRate = content.playback_speed || 1;
    setPlaybackSpeed(content.playback_speed || 1);

    // Wait for metadata to load, then restore position
    const handleLoadedMetadata = () => {
      setDuration(audio.duration);
      const startPosition = content.playback_position || 0;

      // Fix corrupted duration in database if detected
      if (content.duration && Math.abs(content.duration - audio.duration) > 1) {
        console.warn(`⚠️ Fixing corrupted duration for "${content.title}": DB has ${content.duration}s, actual is ${audio.duration}s`);
        contentAPI.update(content.id, { duration: Math.floor(audio.duration) }).catch(console.error);
      }

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
      // Only clamp if we have a valid duration from the loaded audio
      // If duration is 0 or invalid, save the raw position (don't corrupt data)
      const clampedPosition = duration > 0
        ? Math.max(0, Math.min(Math.floor(position), duration))
        : Math.floor(position);

      await contentAPI.update(content.id, {
        playback_position: clampedPosition,
        last_played_at: new Date().toISOString(),
      });
      console.log('✓ Saved position:', clampedPosition, '/ duration:', duration);
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
    // Normalize playbackSpeed to handle floating point comparison
    const normalizedSpeed = Math.round(playbackSpeed * 100) / 100;
    let currentIndex = speeds.findIndex(s => Math.abs(s - normalizedSpeed) < 0.01);

    // If current speed not in list, start from beginning
    if (currentIndex === -1) currentIndex = -1;

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
      <div key={index} className="comment" style={{ marginLeft: `${depth * 20}px` }}>
        <div className="comment-header">
          <span className="comment-username">{comment.username}</span>
          {comment.date && <span className="comment-date">{comment.date}</span>}
        </div>
        {(comment.karma !== undefined || comment.agree_votes !== undefined || comment.disagree_votes !== undefined) && (
          <div className="comment-metadata">
            {comment.karma !== undefined && <span className="comment-karma">{comment.karma} karma</span>}
            {comment.agree_votes !== undefined && <span className="comment-votes">{comment.agree_votes} agree</span>}
            {comment.disagree_votes !== undefined && <span className="comment-votes">{comment.disagree_votes} disagree</span>}
          </div>
        )}
        <div className="comment-content">{comment.content}</div>
        {comment.replies && comment.replies.length > 0 && (
          <div className="comment-replies">
            {renderComments(comment.replies, depth + 1)}
          </div>
        )}
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

  if (!content) {
    console.error('AudioPlayer: content is null or undefined');
    return (
      <div className="audio-player">
        <div className="player-header">
          <h2>Error</h2>
          <button onClick={onClose} className="close-btn">
            <X size={24} />
          </button>
        </div>
        <p style={{ padding: '1rem', color: '#ef4444' }}>Failed to load content</p>
      </div>
    );
  }

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
      <div className="player-header">
        <h2>{content.title}</h2>
        <button onClick={onClose} className="close-btn">
          <X size={24} />
        </button>
      </div>

      <audio ref={audioRef} />

      <div className="player-controls">
        <div className="progress-bar">
          <span className="time">{formatTime(currentTime)}</span>
          <input
            type="range"
            className="progress-slider"
            min="0"
            max={duration || 0}
            value={currentTime}
            onChange={(e) => handleSeek(Number(e.target.value))}
            disabled={!isAudioReady}
          />
          <span className="time">{formatTime(duration)}</span>
        </div>

        <div className="playback-controls">
          <button onClick={handleSkipBackward} disabled={!isAudioReady}>
            <SkipBack size={24} />
          </button>
          <button
            onClick={togglePlay}
            className="play-pause-btn"
            disabled={!isAudioReady}
          >
            {isPlaying ? <Pause size={32} /> : <Play size={32} />}
          </button>
          <button onClick={handleSkipForward} disabled={!isAudioReady}>
            <SkipForward size={24} />
          </button>
        </div>

        <div className="player-options">
          <div className="option-group">
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
          </div>

          <div className="option-group">
            <button onClick={toggleSpeed}>
              <Gauge size={20} />
              <span>{playbackSpeed === 1 ? '1' : playbackSpeed.toFixed(2).replace(/\.?0+$/, '')}x</span>
            </button>
          </div>

          <div className="option-group">
            <button onClick={() => setShowSleepTimer(!showSleepTimer)}>
              <Clock size={20} />
              {sleepTimer && <span>{sleepTimer}m</span>}
            </button>
            {showSleepTimer && (
              <div className="sleep-timer-menu">
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

      <div className="content-tabs" style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem', marginBottom: '0.5rem' }}>
        <button
          style={{
            padding: '0.5rem 1rem',
            background: showTranscript ? '#3b82f6' : '#334155',
            border: 'none',
            borderRadius: '0.375rem',
            color: '#e2e8f0',
            cursor: 'pointer'
          }}
          onClick={() => setShowTranscript(true)}
        >
          {content.type === 'podcast_episode' ? 'Transcript' : 'Content'}
        </button>
        {structuredComments && structuredComments.length > 0 && (
          <button
            style={{
              padding: '0.5rem 1rem',
              background: !showTranscript ? '#3b82f6' : '#334155',
              border: 'none',
              borderRadius: '0.375rem',
              color: '#e2e8f0',
              cursor: 'pointer'
            }}
            onClick={() => setShowTranscript(false)}
          >
            Comments ({structuredComments.length})
          </button>
        )}
      </div>

      {!content.audio_url && (
        <div style={{ padding: '1rem', background: '#1e3a5f', borderRadius: '0.375rem', marginBottom: '1rem' }}>
          <p style={{ color: '#e2e8f0', marginBottom: '0.5rem' }}>⚠️ Audio not available yet</p>
          <p style={{ color: '#94a3b8', fontSize: '0.875rem' }}>
            {content.generation_status === 'generating_audio' || content.generation_status === 'content_ready'
              ? 'Audio is currently being generated...'
              : 'Audio needs to be generated for this article.'}
          </p>
        </div>
      )}

      {showTranscript ? (
        <div className="transcript-section">
          {(() => {
            try {
              if (transcript) {
                return <div className="transcript-content">{getHighlightedTranscript()}</div>;
              } else if (content.content) {
                return (
                  <div className="transcript-content" style={{ whiteSpace: 'pre-wrap' }}>
                    {content.content}
                  </div>
                );
              } else if (transcriptError) {
                return <div className="error">{transcriptError}</div>;
              } else {
                return (
                  <div>
                    <p>No content available.</p>
                    {content.type === 'podcast_episode' && (
                      <button onClick={loadTranscript} disabled={loadingTranscript}>
                        {loadingTranscript ? 'Generating transcript...' : 'Generate Transcript'}
                      </button>
                    )}
                  </div>
                );
              }
            } catch (error) {
              console.error('Error rendering transcript:', error);
              return <p style={{ color: '#ef4444', padding: '1rem' }}>Error displaying content</p>;
            }
          })()}
        </div>
      ) : (
        <div className="comments-section">
          <div className="comments-list">
            {(() => {
              try {
                if (structuredComments && structuredComments.length > 0) {
                  return renderComments(structuredComments);
                } else {
                  return <p style={{ color: '#94a3b8', padding: '1rem' }}>No comments available.</p>;
                }
              } catch (error) {
                console.error('Error rendering comments:', error);
                return <p style={{ color: '#ef4444', padding: '1rem' }}>Error displaying comments</p>;
              }
            })()}
          </div>
        </div>
      )}
    </div>
  );
}
