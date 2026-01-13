import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error, errorInfo: null };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('ErrorBoundary caught:', error, errorInfo);
    this.setState({ error, errorInfo });
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          padding: '2rem',
          background: '#991b1b',
          color: '#fecaca',
          borderRadius: '0.5rem',
          margin: '1rem',
          maxHeight: '80vh',
          overflow: 'auto'
        }}>
          <h1 style={{ fontSize: '1.5rem', marginBottom: '1rem' }}>💥 Component Crashed</h1>
          <div style={{
            background: '#7f1d1d',
            padding: '1rem',
            borderRadius: '0.375rem',
            marginBottom: '1rem',
            fontFamily: 'monospace',
            fontSize: '0.875rem',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word'
          }}>
            <strong>Error:</strong><br/>
            {this.state.error?.toString()}
          </div>
          {this.state.errorInfo && (
            <div style={{
              background: '#7f1d1d',
              padding: '1rem',
              borderRadius: '0.375rem',
              fontFamily: 'monospace',
              fontSize: '0.75rem',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word'
            }}>
              <strong>Component Stack:</strong><br/>
              {this.state.errorInfo.componentStack}
            </div>
          )}
        </div>
      );
    }

    return this.props.children;
  }
}
