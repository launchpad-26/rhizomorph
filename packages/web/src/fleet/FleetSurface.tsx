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
 * **Wave 2 (#562) finished the container's two loose ends.** Wave 1 mounted the
 * scene and the table as they were, which left the list representation drawing
 * the heading and the frame twice; the table has dropped its copies now that
 * this surface carries them (`panels/fleet/index.tsx`). And the organism's
 * error state has become S1's *error* state proper — see {@link Organism}.
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
      heading={<h2 className="heading text-(--ink-dim)">Fleet</h2>}
      views={[
        { id: 'organism', label: 'Organism', render: () => <Organism /> },
        { id: 'list', label: 'List', render: () => <List /> },
      ]}
    />
  )
}

/**
 * The organism, behind both a lazy boundary and an error boundary: if three.js
 * falls over, everything around it is unaffected (architecture.md).
 *
 * **THE CANVAS-FAILURE FLOOR (prd-36 S1's *error* state, #562).** When the
 * canvas does not come up, the surface **falls to the list and says so once**.
 * The list is the floor and this is the case it exists for — a blank frame
 * where the fleet was is the one outcome S1 names as wrong.
 *
 * It is done *here*, inside the organism arm, and not by flipping the toggle,
 * and the distinction is ruling 3's fourth guarantee rather than a detail of
 * where the code sits: **no representation may be selected automatically by
 * application state.** A canvas error that rewrote a person's remembered choice
 * would be exactly the instrument that hides its own scene at the moment they
 * most want to look at it — and worse, it would still be hiding it after the
 * next reload, on a machine where the canvas had since recovered. So the choice
 * is untouched and stays visible in the toggle; what changes is what the
 * organism arm can honestly draw, which is the roster plus one line saying why.
 *
 * "Once" is structural: the line is a sibling of the list, rendered by the
 * boundary's single fallback, so there is exactly one of it however many times
 * the renderer retries beneath.
 */
function Organism() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ErrorBoundary fallback={<CanvasFloor />}>
        <Suspense fallback={<SceneFallback />}>
          <Scene />
        </Suspense>
      </ErrorBoundary>
    </div>
  )
}

/**
 * The floor, arrived at the hard way: one honest line, then the complete list.
 *
 * Law 12's three parts, in order — WHAT is missing (the organism), WHAT is
 * unaffected (every lane is below, in full), and WHAT to do (nothing is
 * required; the toggle is still a person's own). It does not offer to retry:
 * S1 is explicit that a silent retry is the wrong answer, because a canvas that
 * failed to initialise fails the same way on the next frame and an operator
 * would be watching a spinner instead of their fleet.
 */
function CanvasFloor() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <p
        role="status"
        data-testid="fleet-organism-unavailable"
        className="shrink-0 px-4 pb-2 text-read-floor leading-snug text-broken"
      >
        ORGANISM UNAVAILABLE — the canvas did not come up, so the picture cannot be drawn. The list
        below carries every lane, complete; nothing else on the page is affected.
      </p>
      <List />
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
    <div className="flex h-full items-center justify-center heading tracking-widest text-(--ink-dim)">
      loading scene…
    </div>
  )
}

function ListFallback() {
  return (
    <div className="h-full min-h-32 animate-pulse rounded-lg border border-(--line-hair) bg-(--surface-panel)" />
  )
}
