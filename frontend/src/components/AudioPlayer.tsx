import { useState, useEffect, useRef, useMemo } from 'react';
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

function cleanHtml(text: string): string {
  if (!text) return '';
  // Remove CDATA wrapper
  let cleaned = text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  // Remove HTML tags
  cleaned = cleaned.replace(/<[^>]+>/g, ' ');
  // Decode HTML entities
  cleaned = cleaned
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
  // Clean up whitespace
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  return cleaned;
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

  const audioRef = useRef<HTMLAudioElement>(null);
  const sleepTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isPlayingRef = useRef(isPlaying);

  // Keep ref in sync with state
  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  useEffect(() => {
    if (!content) return;

    if (audioRef.current) {
      const audio = audioRef.current;
      const startPosition = content.playback_position || 0;

      audio.src = content.audio_url || '';
      audio.playbackRate = content.playback_speed || 1;
      setPlaybackSpeed(content.playback_speed || 1);

      // Wait for metadata to load before setting position
      const handleLoadedMetadata = () => {
        if (startPosition > 0) {
          audio.currentTime = startPosition;
          setCurrentTime(startPosition);
        }
        audio.removeEventListener('loadedmetadata', handleLoadedMetadata);
      };

      audio.addEventListener('loadedmetadata', handleLoadedMetadata);
    }

    if (content.transcript) {
      setTranscript(content.transcript);
      setTranscriptError('');
    } else {
      setTranscript('');
      setTranscriptError('');
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
  }, [content]); // Only recreate when content changes

  // Save position on component unmount (user closes player or switches content)
  useEffect(() => {
    return () => {
      if (audioRef.current && content) {
        savePlaybackPosition(audioRef.current.currentTime);
      }
    };
  }, [content]);

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

    // Method 3: Fall back to linear interpolation (least accurate)
    const displayedText = cleanHtml(transcript || content.content || '');
    const words = displayedText.split(/\s+/);
    const estimatedPosition = (wordIndex / words.length) * duration;
    console.log('Using linear interpolation:', { wordIndex, totalWords: words.length, duration, estimatedPosition });
    handleSeek(estimatedPosition);
  };

  // Parse comments from JSON string if available
  const parsedComments: Comment[] = useMemo(() => {
    if (!content?.comments) return [];
    try {
      const comments = typeof content.comments === 'string'
        ? JSON.parse(content.comments)
        : content.comments;
      console.log('Parsed comments:', comments?.length || 0, 'comments');
      return comments || [];
    } catch (error) {
      console.error('Failed to parse comments:', error);
      return [];
    }
  }, [content?.comments]);

  // Recursive component to render comments with replies
  const CommentComponent = ({ comment, depth = 0 }: { comment: Comment; depth?: number }) => {
    const hasMetadata = comment.karma !== undefined || comment.agree_votes !== undefined || comment.disagree_votes !== undefined;

    return (
      <div className="comment" style={{ marginLeft: `${depth * 20}px` }}>
        <div className="comment-header">
          <span className="comment-username">{comment.username}</span>
          {comment.date && (
            <span className="comment-date">
              {' • '}
              {(() => {
                try {
                  return new Date(comment.date).toLocaleDateString();
                } catch {
                  return comment.date;
                }
              })()}
            </span>
          )}
        </div>
        {hasMetadata && (
          <div className="comment-metadata">
            {comment.karma !== undefined && comment.karma !== null && (
              <span className="comment-karma">Karma: {comment.karma}</span>
            )}
            {comment.agree_votes !== undefined && comment.agree_votes !== null && (
              <span className="comment-votes">Agree: {comment.agree_votes}</span>
            )}
            {comment.disagree_votes !== undefined && comment.disagree_votes !== null && (
              <span className="comment-votes">Disagree: {comment.disagree_votes}</span>
            )}
          </div>
        )}
        <p className="comment-content">{comment.content}</p>
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

  if (!content) return null;

  return (
    <div className="audio-player">
      <audio ref={audioRef} />

      <div className="player-main">
        <div className="player-header">
          <div className="content-info">
            {content.thumbnail_url && (
              <img src={content.thumbnail_url} alt={content.title} className="thumbnail" />
            )}
            <div>
              <h3>{content.title}</h3>
              {content.author && <p className="author">{content.author}</p>}
              {content.published_at && (
                <p className="published-date">
                  Published: {new Date(content.published_at).toLocaleDateString('en-US', {
                    month: 'long',
                    day: 'numeric',
                    year: 'numeric'
                  })}
                </p>
              )}
              {(content.karma !== undefined || content.agree_votes !== undefined || content.disagree_votes !== undefined) && (
                <div className="article-metadata">
                  {content.karma !== undefined && content.karma !== null && (
                    <span className="metadata-item">
                      <strong>Karma:</strong> {content.karma}
                    </span>
                  )}
                  {content.agree_votes !== undefined && content.agree_votes !== null && (
                    <span className="metadata-item">
                      <strong>Agree votes:</strong> {content.agree_votes}
                    </span>
                  )}
                  {content.disagree_votes !== undefined && content.disagree_votes !== null && (
                    <span className="metadata-item">
                      <strong>Disagree votes:</strong> {content.disagree_votes}
                    </span>
                  )}
                </div>
              )}
              {content.url && (
                <p className="source-link">
                  <a href={content.url} target="_blank" rel="noopener noreferrer">
                    View original source →
                  </a>
                </p>
              )}
            </div>
          </div>
          <button onClick={onClose} className="close-btn">
            <X size={24} />
          </button>
        </div>

        <div className="player-controls">
          <div className="progress-bar">
            <span className="time">{formatTime(currentTime)}</span>
            <input
              type="range"
              min="0"
              max={duration || 0}
              value={currentTime}
              onChange={(e) => handleSeek(parseFloat(e.target.value))}
              className="progress-slider"
            />
            <span className="time">{formatTime(duration)}</span>
          </div>

          <div className="playback-controls">
            <button onClick={handleSkipBackward} title="Skip back 15s">
              <SkipBack size={24} />
            </button>
            <button onClick={togglePlay} className="play-pause-btn">
              {isPlaying ? <Pause size={32} /> : <Play size={32} />}
            </button>
            <button onClick={handleSkipForward} title="Skip forward 30s">
              <SkipForward size={24} />
            </button>
          </div>

          <div className="player-options">
            <button onClick={toggleSpeed} className="speed-toggle">
              <Gauge size={20} />
              <span>{playbackSpeed}x</span>
            </button>

            <div className="option-group">
              <button onClick={() => setShowSleepTimer(!showSleepTimer)}>
                <Clock size={20} />
                {sleepTimer && <span>{sleepTimer}m</span>}
              </button>
              {showSleepTimer && (
                <div className="sleep-timer-menu">
                  {[5, 10, 15, 30, 45, 60].map((minutes) => (
                    <button key={minutes} onClick={() => setSleepTimerMinutes(minutes)}>
                      {minutes} min
                    </button>
                  ))}
                  {sleepTimer && (
                    <button
                      onClick={() => {
                        if (sleepTimerRef.current) clearTimeout(sleepTimerRef.current);
                        setSleepTimer(null);
                        setShowSleepTimer(false);
                      }}
                    >
                      Cancel
                    </button>
                  )}
                </div>
              )}
            </div>

            <div className="volume-control">
              <Volume2 size={20} />
              <input
                type="range"
                min="0"
                max="1"
                step="0.1"
                value={volume}
                onChange={(e) => handleVolumeChange(parseFloat(e.target.value))}
              />
            </div>
          </div>
        </div>
      </div>

      {content.description && (
        <div className="description">
          <h4>Description</h4>
          <p>{cleanHtml(content.description)}</p>
        </div>
      )}

      {(content.type === 'podcast_episode' || content.content) && (
        <div className="transcript-section">
          <div className="transcript-header">
            <h4>
              {content.type === 'podcast_episode' ? 'Transcript' : 'Content'}
            </h4>
            {(transcript || content.content) && (
              <button onClick={() => setShowTranscript(!showTranscript)}>
                {showTranscript ? 'Hide' : 'Show'}
              </button>
            )}
          </div>
          {showTranscript && (
            <div className="transcript-content">
              {loadingTranscript ? (
                <p>Generating transcript...</p>
              ) : transcriptError ? (
                <div>
                  <p className="error-message">{transcriptError}</p>
                  <button onClick={loadTranscript} className="retry-btn">Retry</button>
                </div>
              ) : content.generation_status === 'starting' || content.generation_status === 'extracting_content' ? (
                <p className="status-message">⏳ Content is being extracted and formatted for reading...</p>
              ) : (transcript || content.content) ? (
                <p>
                  {cleanHtml(transcript || content.content || '').split(/\s+/).map((word, index) => (
                    <span
                      key={index}
                      className="transcript-word"
                      onClick={() => handleTranscriptClick(index)}
                    >
                      {word}{' '}
                    </span>
                  ))}
                </p>
              ) : (
                <div>
                  <p>No transcript available.</p>
                  <button onClick={loadTranscript} className="generate-transcript-btn">
                    Generate Transcript
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {parsedComments.length > 0 && (
        <div className="comments-section">
          <div className="comments-header">
            <h4>Comments ({parsedComments.length})</h4>
          </div>
          <div className="comments-list">
            {parsedComments.map((comment, index) => (
              <CommentComponent key={index} comment={comment} depth={0} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
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
