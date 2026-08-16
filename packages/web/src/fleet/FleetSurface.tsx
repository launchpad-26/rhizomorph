import { lazy, Suspense } from 'react'
import { ErrorBoundary } from '../app/ErrorBoundary.js'
import { TwoRepresentations } from './TwoRepresentations.js'

/**
 * THE FLEET SURFACE (prd-36 ruling 1 / S1, #555) — the hero of the main screen:
 * *who is alive*, in whichever representation suits the moment.
 *
 * The organism and the roster stop being two places that disagree. They were
 * already one thing pretending to be two — the table's STATE column draws the
 * scene's own glyph alphabet at row scale, which makes the table the scene's
 * legend — and until this commit they cost the viewport twice, the scene
 * hero-sized above and the table full-width beneath it, with the analytical
 * panels below both.
 *
 * **The list is the floor.** Say it in that direction, because it inverts the
 * usual instinct: the list is complete and usable at every scene quality level,
 * in still mode, on a machine that cannot hold a frame budget, and when the
 * canvas does not come up at all. The organism is the enhancement. That is what
 * makes prd-33's ambition safe to pursue — the art may be as expensive as it
 * likes, because navigation does not depend on it. Structurally, the floor is
 * this: the list arm below shares no module, no boundary and no failure mode
 * with the organism arm, so nothing the scene can do to itself can reach the
 * list.
 *
 * **What this wave is, and is not.** This is the container (prd-36 sequencing,
 * wave 1's keystone): the existing scene and the existing fleet table, mounted
 * inside one frame that owns the toggle, sharing the one `SelectionProvider`
 * they already shared. **No visual change to either representation.** Two
 * consequences of mounting them as they are, both wave 2's to tidy when the list
 * gets its own pass (`packages/web/src/panels/fleet/**`, fenced away from this
 * commit): the table brings its own `<h2>Fleet</h2>` and its own bordered
 * section, so in the list representation the heading and the frame are drawn
 * twice. Wave 2 drops the table's copies now that the surface carries them.
 *
 * **One derived fleet, two renderings.** Neither arm derives anything: the scene
 * and the table both call `useFleet()`, so a lane present in one and absent from
 * the other is impossible by construction rather than by test — though
 * `FleetSurface.test.tsx` pins it anyway, because "impossible by construction"
 * is a claim about today's construction.
 */
const Scene = lazy(() => import('../scene/index.js'))
const FleetTable = lazy(() => import('../panels/fleet/index.js'))

export function FleetSurface() {
  return (
    <TwoRepresentations
      surface="fleet"
      heading={
        <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-ice-400">Fleet</h2>
      }
      views={[
        { id: 'organism', label: 'Organism', render: () => <Organism /> },
        { id: 'list', label: 'List', render: () => <List /> },
      ]}
    />
  )
}

/**
 * The scene, hero-sized (prd4 ruling 2's `min-h-[55vh]`, carried over from the
 * slot this replaces) and behind both a lazy boundary and an error boundary: if
 * three.js falls over, everything around it is unaffected (architecture.md).
 *
 * The error line names the way to the list rather than taking it. prd-36's S1
 * *error* state — the surface falls to the list and says so once — is wave 2's,
 * and it has to be, because ruling 3's fourth guarantee forbids this component
 * from choosing a representation on the application's behalf. Telling a person
 * which key carries them to a complete fleet is the honest wave-1 half of that:
 * law 12's voice (what is missing, what is unaffected, what to do) with the act
 * left to the person.
 */
function Organism() {
  return (
    <div className="min-h-[55vh] flex-1">
      <ErrorBoundary fallback={<SceneErrorFallback />}>
        <Suspense fallback={<SceneFallback />}>
          <Scene />
        </Suspense>
      </ErrorBoundary>
    </div>
  )
}

/**
 * The floor. Deliberately not wrapped in an error boundary of its own the way
 * the organism is: an error boundary here would be a second, quieter fallback
 * behind the one that is already the fallback, and the honest answer to "the
 * list is broken" is the shell's own boundary rather than a line inside the
 * frame claiming the fleet is fine.
 */
function List() {
  return (
    <div className="min-h-0 flex-1">
      <Suspense fallback={<ListFallback />}>
        <FleetTable />
      </Suspense>
    </div>
  )
}

function SceneFallback() {
  return (
    <div className="flex h-full items-center justify-center text-xs uppercase tracking-widest text-ice-400">
      loading scene…
    </div>
  )
}

function ListFallback() {
  return <div className="h-full min-h-32 animate-pulse rounded-lg border border-ice-850 bg-ice-950" />
}

function SceneErrorFallback() {
  return (
    <div
      role="status"
      data-testid="fleet-organism-unavailable"
      className="flex h-full items-center justify-center px-4 text-center text-xs uppercase tracking-widest text-broken"
    >
      scene unavailable — press V for the list, which carries every lane
    </div>
  )
}
