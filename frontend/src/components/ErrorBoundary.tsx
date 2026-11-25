import { Component, type ErrorInfo, type ReactNode } from 'react';
import { logPlayback } from '../playback-log';

// Catches an error while the app draws itself. Without it, React removes the whole page and
// only the background stays (reported 2026-11-08 after the screen had been off). It shows the
// error with a Reload button and sends a page-error line to the [Playback] log
// (playback-log.ts), with the message and the component where it broke.
interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack);
    // The first name in React's component stack is the component that broke
    const where = info.componentStack?.match(/at (\w+)/)?.[1];
    logPlayback('page-error', { msg: error.message, where });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="app loading-screen">
        <div className="loading-content error-screen">
          <h2>Something went wrong</h2>
          <p className="error-screen-message">{this.state.error.message}</p>
          <button className="save-button" onClick={() => window.location.reload()}>Reload</button>
        </div>
      </div>
    );
  }
}
