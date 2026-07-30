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

  override render() {
    if (this.state.failed) return this.props.fallback
    return this.props.children
  }
}
