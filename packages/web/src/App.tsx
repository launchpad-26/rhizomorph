import { ModeProvider } from './app/ModeContext.js'
import { Shell } from './app/Shell.js'
import { StreamProvider } from './app/StreamContext.js'
import { FleetProvider } from './fleet/FleetContext.js'
import type { FetchLike } from './fleet/manifest.js'
import { SelectionProvider } from './fleet/selection.js'
import type { EventSourceFactory } from './hooks/useEventStream.js'

/**
 * The instrument's four nested facts, outermost first:
 *
 * 1. **mode** — live or replay (they are the same reducer, architecture.md);
 * 2. **stream** — which event log is folding, and the news-vs-history tag on it;
 * 3. **fleet** — the one derived object every surface reads, so four surfaces
 *    cannot disagree about how many lanes are working;
 * 4. **selection** — the one lane the strip, table, scene and drawer all point
 *    at, and that Esc clears.
 *
 * Each provider takes an injectable seam (`createSource`, `now`, `fetchLanes`)
 * so a test drives the real code deterministically instead of mocking around it.
 */

export interface AppProps {
  streamUrl?: string
  /** Test-only escape hatch for injecting a mock SSE source. */
  createSource?: EventSourceFactory
  /** Test-only clock: pins both the fixtures and the derived fleet's rebuild. */
  now?: number
  /** Test-only fetch for the lane manifest (`/api/lanes`, #76). */
  fetchLanes?: FetchLike
}

export function App({ streamUrl = '/api/stream', createSource, now, fetchLanes }: AppProps = {}) {
  return (
    <ModeProvider>
      <StreamProvider url={streamUrl} createSource={createSource} now={now}>
        <FleetProvider now={now} fetchLanes={fetchLanes}>
          <SelectionProvider>
            <Shell />
          </SelectionProvider>
        </FleetProvider>
      </StreamProvider>
    </ModeProvider>
  )
}
