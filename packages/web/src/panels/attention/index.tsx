import { useFleet, useSelection } from '../../fleet/index.js'
import { AttentionStripView } from './AttentionStripView.js'
import './attention.css'

/**
 * THE ATTENTION STRIP (ruling 5) — thin, always-present, docked at the top.
 * Reads only the one derived fleet object and the one shared selection —
 * everything else lives in {@link AttentionStripView}, which is a pure
 * function of a `Fleet` and can be tested without either.
 *
 * The shell already swaps this slot out for the REPLAY banner in replay mode
 * (`app/Shell.tsx`), so this file never has to know a mode exists.
 */
export default function AttentionStrip() {
  const fleet = useFleet()
  const { selectedId, toggle } = useSelection()

  return <AttentionStripView fleet={fleet} selectedId={selectedId} onToggle={toggle} />
}
