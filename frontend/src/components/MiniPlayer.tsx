import { Play, Pause, X } from 'lucide-react';
import type { ContentItem } from '../types';

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

        <div className="mini-progress-container">
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
        </div>
      </div>
    </div>
  );
}
