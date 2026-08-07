import { Suspense, lazy } from 'react'
import { ModeProvider } from './app/ModeContext.js'
import { useRoute } from './app/router.js'
import { Shell } from './app/Shell.js'
import { StreamProvider } from './app/StreamContext.js'
import { FleetProvider } from './fleet/FleetContext.js'
import type { FetchLike } from './fleet/manifest.js'
import { SelectionProvider } from './fleet/selection.js'
import type { EventSourceFactory } from './hooks/useEventStream.js'

const LanePage = lazy(() => import('./lane-page/index.js'))
const RecordingsPage = lazy(() => import('./recordings/index.js'))
const LabPage = lazy(() => import('./lab/index.js'))
const ConnectPage = lazy(() => import('./connect/index.js'))

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
 *
 * Above `Shell` sits the one route switch (prd9 B1b, #135; widened by prd16
 * ruling 4, prd14 and prd19 ruling 1): `/` renders the balcony unchanged,
 * `/lane/:handle` renders the deep-linkable lane page, `/recordings` renders
 * the recordings library, `/lab` renders the experiment console, `/connect`
 * renders the connection surface (a fenced placeholder in this wave — the
 * handshake checklist itself is wave 3). The switch lives here, inside every
 * provider, so every page shares the exact same mode/stream/fleet/selection
 * state the balcony does — there is no second read of the log for any of
 * them to disagree with. The recordings library only ever reads
 * `ModeContext` (for "open in replay") and its own `GET /api/sessions`; the
 * lab reads only its own `GET /api/lab/checkpoints` and `GET
 * /api/lab/experiments` (prd12 ruling 1's read-only second hand) — both
 * render under the same providers as everything else, but touch neither
 * `FleetProvider`'s nor `StreamProvider`'s state (the lab's own
 * `no-live-fleet-law.test.ts` holds that structurally). The connect
 * placeholder reads nothing at all yet — wave 3 gives it `/api/meta` and
 * `/api/doctor` (prd19 ruling 5).
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
  const route = useRoute()

  return (
    <ModeProvider>
      <StreamProvider url={streamUrl} createSource={createSource} now={now}>
        <FleetProvider now={now} fetchLanes={fetchLanes}>
          <SelectionProvider>
            {route.name === 'lane' ? (
              <Suspense fallback={null}>
                <LanePage handle={route.handle} />
              </Suspense>
            ) : route.name === 'recordings' ? (
              <Suspense fallback={null}>
                <RecordingsPage />
              </Suspense>
            ) : route.name === 'lab' ? (
              <Suspense fallback={null}>
                <LabPage />
              </Suspense>
            ) : route.name === 'connect' ? (
              <Suspense fallback={null}>
                <ConnectPage />
              </Suspense>
            ) : (
              <Shell />
            )}
          </SelectionProvider>
        </FleetProvider>
      </StreamProvider>
    </ModeProvider>
  )
}
