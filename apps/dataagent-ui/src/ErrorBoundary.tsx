/**
 * Top-level error boundary: renders the failure into the DOM and mirrors it
 * on window so a wedged page can still be diagnosed from the outside.
 */
import { Component, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}
interface State {
  message?: string
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = {}

  static getDerivedStateFromError(error: unknown): State {
    return { message: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }
  }

  componentDidCatch(error: unknown, info: { componentStack?: string }): void {
    const w = window as unknown as { __reactError?: string; __reactStack?: string }
    w.__reactError = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    w.__reactStack = info.componentStack ?? ''
  }

  render(): ReactNode {
    if (this.state.message !== undefined) {
      return (
        <pre id="crash-report" style={{ padding: 20, whiteSpace: 'pre-wrap' }}>
          {this.state.message}
        </pre>
      )
    }
    return this.props.children
  }
}
