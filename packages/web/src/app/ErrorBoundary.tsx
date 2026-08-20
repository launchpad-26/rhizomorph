import { Component, type ReactNode } from 'react'

export interface ErrorBoundaryProps {
  fallback: ReactNode
  children: ReactNode
}

interface ErrorBoundaryState {
  failed: boolean
}

/**
 * Generic boundary for slots that must not be able to sink the rest of the
 * shell — the scene most of all (architecture.md: "if it breaks, the panel
 * grid stands alone").
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { failed: false }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { failed: true }
  }

  override componentDidCatch(error: unknown): void {
    // The boundary contains the blast radius; it must never contain the news.
    // Production React does not log caught errors on its own, so a crash the
    // fallback absorbs would otherwise vanish from the console entirely.
    console.error('[rhizomorph] a view crashed and its boundary caught it:', error)
  }

  override render() {
    if (this.state.failed) return this.props.fallback
    return this.props.children
  }
}
