import { PanelGrid } from './PanelGrid.js'
import { ReplayBar } from './ReplayBar.js'
import { SceneSlot } from './SceneSlot.js'
import { StatusBar } from './StatusBar.js'

/** Scene (top, collapsible) · panel grid (middle) · replay bar · status bar (bottom). */
export function Shell() {
  return (
    <div className="grid h-screen grid-rows-[auto_1fr_auto_auto] bg-void text-slate-100">
      <SceneSlot />
      <PanelGrid />
      <ReplayBar />
      <StatusBar />
    </div>
  )
}
