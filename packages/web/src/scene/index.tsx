import { useMemo } from 'react'
import { useStream } from '../app/StreamContext.js'
import { SceneView } from './SceneView.js'
import { fixtureEvents } from './fixtures.js'

/**
 * The constellation, mounted by the shell's lazy slot behind its error
 * boundary (`app/SceneSlot.tsx`).
 *
 * It reads the shell's event stream — the same log every panel folds, no
 * bespoke data path — and falls back to `core`-validated fixture events until
 * the first real one arrives, so the scene is never an empty black box.
 */
export default function Scene() {
  const { state } = useStream()
  const live = state.events.length > 0
  const fixtures = useMemo(() => fixtureEvents(), [])
  const events = live ? state.events : fixtures

  return <SceneView events={events} demo={!live} />
}

export { SceneView } from './SceneView.js'
export { buildSceneModel } from './sceneModel.js'
export { fixtureEvents } from './fixtures.js'
