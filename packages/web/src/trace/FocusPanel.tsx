import { useStream } from '../app/StreamContext.js'
import { isMainSelected, useSelection } from '../fleet/index.js'
import { TraceGantt } from './TraceGantt.js'

/**
 * FOCUS TRACE's actual content — lazily imported by `PanelGrid`, exactly like
 * every other panel there, so a grid-level test can mock this module without
 * needing a `StreamProvider`/`SelectionProvider` in its tree (`PanelGrid`
 * itself carries the focus chrome; this is only ever mounted once focused).
 *
 * Reads the same selection every other selection-aware surface reads —
 * there is no second "which lane is open" fact for the gantt to disagree
 * with the drawer about.
 */
export default function TraceFocusPanel() {
  const { selectedId } = useSelection()
  const { state } = useStream()

  if (selectedId === null || isMainSelected(selectedId)) {
    return (
      <p role="status" className="px-4 py-3 text-[11px] leading-snug text-ice-500">
        NO LANE OPEN — trace focus needs a lane's drawer open first; select one from the fleet,
        then use its TRACE section's FOCUS ↗.
      </p>
    )
  }

  return <TraceGantt state={state.session} lane={selectedId} />
}
