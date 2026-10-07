import { X } from 'lucide-react';
import type { ContentItem } from '../types';

// The status lines of an item's running or failed jobs: audio/transcript/refetch progress
// with its bar and stop button, "Summarizing…", "Generating summary audio…", and a red
// box with Retry and dismiss for each failure. Shown on a library card (ContentCard) and
// under the author line of the fullscreen player. Clicks stop here, because a card opens
// the item on any other click.
interface GenerationStatusProps {
  item: ContentItem;
  // Show "✓ Completed" (the library shows it for a few seconds after a generation)
  justCompleted?: boolean;
  onCancelGeneration: () => void;
  onGenerateAudio: (regenerate: boolean) => void;
  onRegenerateTranscript: () => void;
  onRefetch: () => void;
  onGenerateSummary: (regenerate: boolean) => void;
  onGenerateSummaryAudio: () => void;
  onDismissError: (kind: 'generation' | 'summary' | 'summary_audio') => void;
}

export function GenerationStatus({
  item,
  justCompleted = false,
  onCancelGeneration,
  onGenerateAudio,
  onRegenerateTranscript,
  onRefetch,
  onGenerateSummary,
  onGenerateSummaryAudio,
  onDismissError,
}: GenerationStatusProps) {
  const generationStatusDisplay = () => {
    if (!item.generation_status || item.generation_status === 'idle') {
      return null;
    }

    if (item.generation_status === 'completed') {
      if (justCompleted) {
        return (
          <div className="generation-status completed">
            <span>✓ Completed</span>
          </div>
        );
      }
      return null;
    }

    if (item.generation_status === 'failed') {
      // Retry the step that actually failed. The backend tags refetch/transcript failures
      // via current_operation ('failed_refetch' / 'failed_transcript'); podcasts only ever
      // fail on transcription; everything else is audio generation.
      const retryGeneration = () => {
        if (item.type === 'podcast_episode') return onRegenerateTranscript();
        if (item.current_operation === 'failed_refetch') return onRefetch();
        if (item.current_operation === 'failed_transcript') return onRegenerateTranscript();
        return onGenerateAudio(true);
      };
      return (
        <div className="generation-status error">
          <span className="error-message">
            Generation failed
            {item.generation_error && <span className="error-detail">: {item.generation_error}</span>}
          </span>
          <span className="error-actions">
            <button
              className="error-retry-btn"
              onClick={(e) => { e.stopPropagation(); retryGeneration(); }}
              title="Retry"
            >
              Retry
            </button>
            <button
              className="error-dismiss-btn"
              onClick={(e) => { e.stopPropagation(); onDismissError('generation'); }}
              title="Dismiss"
            >
              <X size={14} />
            </button>
          </span>
        </div>
      );
    }

    let statusMessage = '';
    const progressPercent = item.generation_progress || 0;

    // Check current_operation first (more specific than generation_status)
    if (item.current_operation) {
      switch (item.current_operation) {
        case 'processing_images':
          statusMessage = `Processing image descriptions... ${progressPercent}%`;
          break;
        case 'scripting_content':
          statusMessage = `Preparing narration script... ${progressPercent}%`;
          break;
        case 'synthesizing_audio':
          statusMessage = `Generating audio... ${progressPercent}%`;
          break;
        case 'concatenating_audio':
          statusMessage = `Combining audio files... ${progressPercent}%`;
          break;
        case 'finalizing_audio':
          statusMessage = `Finalizing audio... ${progressPercent}%`;
          break;
        case 'transcribing':
          statusMessage = `Creating transcript... ${progressPercent}%`;
          break;
        case 'aligning_content':
          statusMessage = `Aligning content... ${progressPercent}%`;
          break;
        default:
          // Check for audio chunk pattern (e.g., "audio_chunk_3_of_10")
          if (item.current_operation.startsWith('audio_chunk_')) {
            const match = item.current_operation.match(/audio_chunk_(\d+)_of_(\d+)/);
            if (match) {
              const [, current, total] = match;
              statusMessage = `Generating audio: chunk ${current}/${total} (${progressPercent}%)`;
            } else {
              statusMessage = `Generating audio... ${progressPercent}%`;
            }
          }
          // Check for image processing pattern (e.g., "processing_image_3_of_10")
          else if (item.current_operation.startsWith('processing_image_')) {
            const match = item.current_operation.match(/processing_image_(\d+)_of_(\d+)/);
            if (match) {
              const [, current, total] = match;
              statusMessage = `Processing image ${current}/${total}... ${progressPercent}%`;
            } else {
              statusMessage = `Processing images... ${progressPercent}%`;
            }
          }
          else if (item.generation_status === 'starting') {
            statusMessage = 'Starting...';
          } else if (item.generation_status === 'extracting_content') {
            statusMessage = 'Extracting content...';
          } else if (item.generation_status === 'generating_transcript') {
            statusMessage = `Generating transcript... ${progressPercent}%`;
          } else {
            statusMessage = `Processing... ${progressPercent}%`;
          }
      }
    } else if (item.generation_status === 'starting') {
      statusMessage = 'Starting...';
    } else if (item.generation_status === 'extracting_content') {
      statusMessage = 'Extracting content...';
    } else if (item.generation_status === 'generating_transcript') {
      statusMessage = `Generating transcript... ${progressPercent}%`;
    } else {
      statusMessage = `Processing... ${progressPercent}%`;
    }

    return (
      <div className="generation-status generating">
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
          <span style={{ flex: 1 }}>{statusMessage}</span>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onCancelGeneration();
            }}
            className="cancel-generation-btn"
            title="Stop generation"
            style={{
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              padding: '0.25rem',
              display: 'flex',
              alignItems: 'center',
              color: '#ef4444',
            }}
          >
            <X size={16} />
          </button>
        </div>
        {progressPercent > 0 && (
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: `${progressPercent}%` }}></div>
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      {generationStatusDisplay()}
      {item.summary_status === 'generating' && (
        <div className="generation-status generating">
          <span>Summarizing…</span>
        </div>
      )}
      {item.summary_audio_status === 'generating' && (
        <div className="generation-status generating">
          <span>Generating summary audio…</span>
        </div>
      )}
      {item.summary_status === 'failed' && (
        <div className="generation-status error">
          <span className="error-message">
            Summary failed
            {item.summary_error && <span className="error-detail">: {item.summary_error}</span>}
          </span>
          <span className="error-actions">
            <button
              className="error-retry-btn"
              onClick={(e) => { e.stopPropagation(); onGenerateSummary(!!item.summary_generated_at); }}
              title="Retry summary generation"
            >
              Retry
            </button>
            <button
              className="error-dismiss-btn"
              onClick={(e) => { e.stopPropagation(); onDismissError('summary'); }}
              title="Dismiss"
            >
              <X size={14} />
            </button>
          </span>
        </div>
      )}
      {item.summary_audio_status === 'failed' && (
        <div className="generation-status error">
          <span className="error-message">
            Summary audio failed
            {item.summary_audio_error && <span className="error-detail">: {item.summary_audio_error}</span>}
          </span>
          <span className="error-actions">
            <button
              className="error-retry-btn"
              onClick={(e) => { e.stopPropagation(); onGenerateSummaryAudio(); }}
              title="Retry summary audio generation"
            >
              Retry
            </button>
            <button
              className="error-dismiss-btn"
              onClick={(e) => { e.stopPropagation(); onDismissError('summary_audio'); }}
              title="Dismiss"
            >
              <X size={14} />
            </button>
          </span>
        </div>
      )}
    </>
  );
}
