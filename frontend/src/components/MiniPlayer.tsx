import { Play, Pause, X } from 'lucide-react';
import type { ContentItem } from '../types';
import { useMemo } from 'react';

interface MiniPlayerProps {
  content: ContentItem | null;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  onPlayPause: () => void;
  onSeek: (time: number) => void;
  onExpand: () => void;
  onClose: () => void;
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

export function MiniPlayer({
  content,
  isPlaying,
  currentTime,
  duration,
  onPlayPause,
  onSeek,
  onExpand,
  onClose,
}: MiniPlayerProps) {
  if (!content) return null;

  // Parse content alignment to get comments start time
  const commentsStartTime = useMemo(() => {
    if (!content.content_alignment) return null;
    try {
      const alignment = typeof content.content_alignment === 'string'
        ? JSON.parse(content.content_alignment)
        : content.content_alignment;
      return alignment?.commentsStartTime || null;
    } catch {
      return null;
    }
  }, [content.content_alignment]);

  // Calculate marker position as percentage
  const commentsMarkerPosition = useMemo(() => {
    if (!commentsStartTime || !duration || duration === 0) return null;
    return (commentsStartTime / duration) * 100;
  }, [commentsStartTime, duration]);

  return (
    <div className="mini-player">
      <div className="mini-player-header">
        <div className="mini-player-content" onClick={onExpand} style={{ cursor: 'pointer' }}>
          {content.preview_picture && (
            <img
              src={content.preview_picture}
              alt={content.title}
              className="mini-player-thumbnail"
            />
          )}
          <div className="mini-player-info">
            <div className="mini-player-title">{content.title}</div>
            {content.author && (
              <div className="mini-player-author">{content.author}</div>
            )}
          </div>
        </div>
        <button onClick={onClose} className="mini-close-button" title="Close player">
          <X size={18} />
        </button>
      </div>

      <div className="mini-player-controls">
        <button onClick={onPlayPause} className="mini-play-button">
          {isPlaying ? <Pause size={24} /> : <Play size={24} />}
        </button>

        <div className="mini-progress-container" style={{ position: 'relative' }}>
          <span className="mini-time">{formatTime(currentTime)}</span>
          <input
            type="range"
            min="0"
            max={duration || 0}
            value={currentTime}
            onChange={(e) => onSeek(parseFloat(e.target.value))}
            className="mini-progress-slider"
          />
          <span className="mini-time">{formatTime(duration)}</span>
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
      </div>
    </div>
  );
}
