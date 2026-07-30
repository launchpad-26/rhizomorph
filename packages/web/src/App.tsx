import { ModeProvider } from './app/ModeContext.js'
import { StreamProvider } from './app/StreamContext.js'
import { Shell } from './app/Shell.js'
import type { EventSourceFactory } from './hooks/useEventStream.js'

export interface AppProps {
  streamUrl?: string
  /** Test-only escape hatch for injecting a mock SSE source. */
  createSource?: EventSourceFactory
}

export function App({ streamUrl = '/api/stream', createSource }: AppProps = {}) {
  return (
    <ModeProvider>
      <StreamProvider url={streamUrl} createSource={createSource}>
        <Shell />
      </StreamProvider>
    </ModeProvider>
  )
}
