import type { RhizomorphEvent } from '@rhizomorph/core'

/**
 * THE ONE PLACE AN EVENT'S LANE IS READ. Split out of the density band's own
 * `bands.ts` when prd13 ruling 13 cut the band entirely (issue #194):
 * `chaptersFor` (`chapters.ts`) needs exactly this same identity resolution
 * for the marks that survive the cut, so the function is genuinely shared
 * with the marks path and is kept; `bandsFor` and everything else that used
 * to sit beside it in `bands.ts` had no other consumer and went with it.
 *
 * The telemetry handle the event itself names — `payload.lane` for the money
 * layer and the trace layer, `payload.handle` for workmux, one shared
 * swarm-handle namespace by construction. Git and tmux facts (a commit, a
 * dirty-set change, a pane repaint) are keyed by branch or path instead, and
 * joining those to a handle is `buildFleet`'s `resolveLaneId` — which is not
 * exported, and copying it here would be drift-by-construction. So this
 * selector reads only the events that attribute themselves, and identity
 * resolution stays in the one place that already does it.
 */
export function laneOf(event: RhizomorphEvent): string | null {
  switch (event.type) {
    case 'agent.status':
      return event.payload.handle
    case 'llm.usage':
    case 'llm.cost':
    case 'tool.activity':
    case 'trace.span':
    case 'agent.activeTime':
      return event.payload.lane
    default:
      return null
  }
}
