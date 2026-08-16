import { Suspense, lazy, type ReactNode } from 'react'
import { ModeProvider } from './app/ModeContext.js'
import { useRoute } from './app/router.js'
import { Shell } from './app/Shell.js'
import { StreamProvider, useStream } from './app/StreamContext.js'
import { foldedRepoPath } from './app/streamState.js'
import { WindowFloor } from './app/WindowFloor.js'
import { FleetProvider } from './fleet/FleetContext.js'
import type { FetchLike } from './fleet/manifest.js'
import { SelectionProvider } from './fleet/selection.js'
import type { EventSourceFactory } from './hooks/useEventStream.js'
import { usePreferenceApplication } from './settings/apply.js'

const LanePage = lazy(() => import('./lane-page/index.js'))
const RecordingsPage = lazy(() => import('./recordings/index.js'))
const LabPage = lazy(() => import('./lab/index.js'))
const ConnectPage = lazy(() => import('./connect/index.js'))
const SettingsPage = lazy(() => import('./settings/index.js'))

/**
 * The instrument's four nested facts, outermost first:
 *
 * 1. **mode** — live or replay (they are the same reducer, architecture.md);
 * 2. **stream** — which event log is folding, and the news-vs-history tag on it;
 * 3. **fleet** — the one derived object every surface reads, so four surfaces
 *    cannot disagree about how many lanes are working;
 * 4. **selection** — the one lane the strip, table, scene and drawer all point
 *    at, that Esc clears, and that a repo boundary drops (see
 *    {@link RepoScopedSelection}: a lane id belongs to the repo it was
 *    selected in).
 *
 * Each provider takes an injectable seam (`createSource`, `now`, `fetchLanes`)
 * so a test drives the real code deterministically instead of mocking around it.
 *
 * Above `Shell` sits the one route switch (prd9 B1b, #135; widened by prd16
 * ruling 4, prd14, prd19 ruling 1 and #549): `/` renders the balcony
 * unchanged, `/lane/:handle` renders the deep-linkable lane page,
 * `/recordings` renders the recordings library, `/lab` renders the
 * experiment console, `/connect` renders the handshake checklist (prd19
 * rulings 3, 5 and 7, wave 3, #258), and `/settings` renders the
 * configuration surface (prd-35 S1, #550). The switch lives here,
 * inside every provider, so every page shares the exact same
 * mode/stream/fleet/selection state the balcony does — there is no second
 * read of the log for any of them to disagree with. The recordings library
 * only ever reads `ModeContext` (for "open in replay") and its own `GET
 * /api/sessions`; the lab reads only its own `GET /api/lab/checkpoints` and
 * `GET /api/lab/experiments` (prd12 ruling 1's read-only second hand) — both
 * render under the same providers as everything else, but touch neither
 * `FleetProvider`'s nor `StreamProvider`'s state (the lab's own
 * `no-live-fleet-law.test.ts` holds that structurally). Connect reads the
 * same fold every other surface does (`useStream`, `selectConnection`), plus
 * its own `GET /api/meta` and `GET /api/doctor` (prd19 ruling 5) for the
 * facts the fold cannot know — and, ruling 7, mutates nothing but a
 * clipboard.
 *
 * The whole switch is wrapped in `WindowFloor` (S5, prd-32 ruling 10): below
 * the window's hard minimum, nothing above renders at all — one honest panel
 * takes the frame's place instead, on every route alike, and the app resumes
 * exactly where it was the moment the window grows back past the floor.
 *
 * `usePreferenceApplication` (prd-35 S1, #550) sits at the same level and for
 * the same reason `WindowFloor` does: the theme, density and motion a person
 * chose are properties of the whole document, not of the settings page they
 * chose them on, so they are applied HERE — once, at boot, on every route
 * alike. Applying them only where they are set is how a preference comes to
 * survive a reload in one place and not in another.
 */

/**
 * `SelectionProvider`, scoped to the repo the fold currently describes.
 *
 * The selection is the one piece of page state that names a lane without ever
 * having gone through the fold, so the fold's own repo-boundary reset cannot
 * reach it (#390 review; the same shape as the lane manifest, and as #370).
 * Retargeting the dashboard would otherwise carry a lane id from the old repo
 * into the new one — usually pointing at nothing, but spotlighting a stranger
 * whenever the two repos share a lane name, which `dev-1` and `main` routinely
 * do.
 *
 * It reads the stream here rather than inside `SelectionProvider` because that
 * provider is deliberately mountable on its own: most panel tests render it
 * with no stream in the tree, and `useStream` throws outside a provider. The
 * composition root is where this wiring belongs anyway.
 */
function RepoScopedSelection({ children }: { children: ReactNode }) {
  const { state } = useStream()
  return (
    <SelectionProvider repoPath={foldedRepoPath(state.session)}>{children}</SelectionProvider>
  )
}

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
  usePreferenceApplication()

  return (
    <ModeProvider>
      <StreamProvider url={streamUrl} createSource={createSource} now={now}>
        <FleetProvider now={now} fetchLanes={fetchLanes}>
          <RepoScopedSelection>
            <WindowFloor>
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
              ) : route.name === 'settings' ? (
                <Suspense fallback={null}>
                  <SettingsPage />
                </Suspense>
              ) : (
                <Shell />
              )}
            </WindowFloor>
          </RepoScopedSelection>
        </FleetProvider>
      </StreamProvider>
    </ModeProvider>
  )
}
