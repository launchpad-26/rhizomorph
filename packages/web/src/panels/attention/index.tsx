import { useFleet, useSelection } from '../../fleet/index.js'
import { AttentionStripView } from './AttentionStripView.js'
import './attention.css'
import { useTabSignal } from './useTabSignal.js'

/**
 * THE ATTENTION STRIP (ruling 5) — thin, always-present, docked at the top;
 * the single source of truth for the tab signal and the favicon badge
 * (ruling 8). Reads only the one derived fleet object and the one shared
 * selection — everything else lives in {@link AttentionStripView}, which is
 * a pure function of a `Fleet` and can be tested without either.
 *
 * The shell already swaps this slot out for the REPLAY banner in replay mode
 * (`app/Shell.tsx`), so this file never has to know a mode exists.
 */
export default function AttentionStrip() {
  const fleet = useFleet()
  const { selectedId, toggle } = useSelection()
  useTabSignal(fleet)

  return <AttentionStripView fleet={fleet} selectedId={selectedId} onToggle={toggle} />
}
