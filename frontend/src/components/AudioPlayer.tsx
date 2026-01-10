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
import type { ContentItem } from '../types';
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
  const [showSpeed, setShowSpeed] = useState(false);
  const [transcript, setTranscript] = useState<string>('');
  const [loadingTranscript, setLoadingTranscript] = useState(false);
  const [showTranscript, setShowTranscript] = useState(true);

  const audioRef = useRef<HTMLAudioElement>(null);
  const sleepTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!content) return;

    if (audioRef.current) {
      audioRef.current.src = content.audio_url || '';
      audioRef.current.currentTime = content.playback_position || 0;
      audioRef.current.playbackRate = content.playback_speed || 1;
      setPlaybackSpeed(content.playback_speed || 1);
    }

    if (content.transcript) {
      setTranscript(content.transcript);
    } else if (content.type === 'podcast_episode' && content.audio_url) {
      loadTranscript();
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

  useEffect(() => {
    const interval = setInterval(() => {
      if (isPlaying && content) {
        savePlaybackPosition(currentTime);
      }
    }, 10000);

    return () => clearInterval(interval);
  }, [isPlaying, currentTime, content]);

  const loadTranscript = async () => {
    if (!content) return;

    setLoadingTranscript(true);
    try {
      const response = await transcriptionAPI.transcribe(content.id);
      setTranscript(response.data.transcript);
    } catch (error) {
      console.error('Failed to load transcript:', error);
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
    setShowSpeed(false);

    if (content) {
      contentAPI.update(content.id, { playback_speed: speed });
    }
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
    const words = transcript.split(/\s+/);
    const estimatedPosition = (wordIndex / words.length) * duration;
    handleSeek(estimatedPosition);
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
            <div className="option-group">
              <button onClick={() => setShowSpeed(!showSpeed)}>
                <Gauge size={20} />
                <span>{playbackSpeed}x</span>
              </button>
              {showSpeed && (
                <div className="speed-menu">
                  {[0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map((speed) => (
                    <button
                      key={speed}
                      onClick={() => handleSpeedChange(speed)}
                      className={playbackSpeed === speed ? 'active' : ''}
                    >
                      {speed}x
                    </button>
                  ))}
                </div>
              )}
            </div>

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
          <p>{content.description}</p>
        </div>
      )}

      {(transcript || content.content) && (
        <div className="transcript-section">
          <div className="transcript-header">
            <h4>
              {content.type === 'podcast_episode' ? 'Transcript' : 'Content'}
            </h4>
            <button onClick={() => setShowTranscript(!showTranscript)}>
              {showTranscript ? 'Hide' : 'Show'}
            </button>
          </div>
          {showTranscript && (
            <div className="transcript-content">
              {loadingTranscript ? (
                <p>Loading transcript...</p>
              ) : (
                <p>
                  {(transcript || content.content || '').split(/\s+/).map((word, index) => (
                    <span
                      key={index}
                      className="transcript-word"
                      onClick={() => handleTranscriptClick(index)}
                    >
                      {word}{' '}
                    </span>
                  ))}
                </p>
              )}
            </div>
          )}
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
