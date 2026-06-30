import { logger } from './utils/logger';
import React, { Component, type ReactNode, type ErrorInfo } from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'
import './i18n'

class RootErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  constructor(props: { children: ReactNode }) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Visible in %APPDATA%\AegisLink\logs\ on Windows (packaged app)
    logger.error('[AegisLink] Render crash:', error.message, info.componentStack)
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          justifyContent: 'center', height: '100vh', background: '#0a0e0d',
          color: '#e8ede9', gap: 16, fontFamily: 'monospace'
        }}>
          <span style={{ fontSize: 20 }}>AegisLink</span>
          <span style={{ fontSize: 12, opacity: 0.6, maxWidth: 400, textAlign: 'center' }}>
            {this.state.error.message}
          </span>
          <button
            onClick={() => { this.setState({ error: null }); window.location.reload(); }}
            style={{
              padding: '8px 24px', background: '#1e4a3a', color: '#e8ede9',
              border: 'none', borderRadius: 8, cursor: 'pointer', marginTop: 8
            }}
          >
            Reintentar
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </React.StrictMode>
)
