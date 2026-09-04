import { Play, Pause, X } from 'lucide-react';
import type { ContentItem } from '../types';
import { useMemo } from 'react';
import { formatTime } from '../format';

interface MiniPlayerProps {
  content: ContentItem | null;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  onPlayPause: () => void;
  onSeek: (time: number) => void;
  onExpand: () => void;
  onClose: () => void;
  // Summary audio has no comments-timeline data of its own (those timestamps
  // belong to the original audio), so the marker is meaningless while it plays.
  playingVariant?: 'original' | 'summary' | null;
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
  playingVariant = null,
}: MiniPlayerProps) {
  // Parse content alignment to get comments start time.
  // NOTE: hooks must run on every render in the same order (rules-of-hooks),
  // so the `!content` bail-out lives BELOW them, hence the null-safe access.
  const commentsStartTime = useMemo(() => {
    if (!content?.content_alignment) return null;
    try {
      const alignment = typeof content.content_alignment === 'string'
        ? JSON.parse(content.content_alignment)
        : content.content_alignment;
      return alignment?.commentsStartTime || null;
    } catch {
      return null;
    }
  }, [content?.content_alignment]);

  // Calculate marker position as percentage. Suppressed during summary playback,
  // see FullscreenPlayer's identical guard on its own timeline marker.
  const commentsMarkerPosition = useMemo(() => {
    if (playingVariant === 'summary') return null;
    if (!commentsStartTime || !duration || duration === 0) return null;
    return (commentsStartTime / duration) * 100;
  }, [commentsStartTime, duration, playingVariant]);

  if (!content) return null;

  return (
    <div className="mini-player">
      <div className="mini-player-header">
        <button onClick={onClose} className="mini-close-button" title="Close player">
          <X size={18} />
        </button>
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
      </div>

      <div className="mini-player-controls">
        <div className="mini-progress-container">
          <span className="mini-time">{formatTime(currentTime)}</span>
          <div style={{ position: 'relative', flex: 1, display: 'flex' }}>
            <input
              type="range"
              min="0"
              max={duration || 0}
              value={currentTime}
              onChange={(e) => onSeek(parseFloat(e.target.value))}
              className="mini-progress-slider"
            />
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
          <span className="mini-time">{formatTime(duration)}</span>
        </div>

        <button onClick={onPlayPause} className="mini-play-button">
          {isPlaying ? <Pause size={24} /> : <Play size={24} />}
        </button>
      </div>
    </div>
  );
}
